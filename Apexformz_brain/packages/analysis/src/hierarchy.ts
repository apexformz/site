/**
 * Hierarchical open-set recognition (family -> group -> movement).
 *
 * A fine-grained recognizer over many similar classes is often unsure WHICH of several near-identical
 * movements it sees while being sure of the KIND of movement. Probability mass of mutually exclusive classes adds
 * up, so a group's probability is the sum of its members' probabilities and a family's the sum of its groups'.
 * The decision reports the most specific level that clears its gate:
 *
 *   movement  the fine decision (decideOpenSet) is accepted
 *   group     otherwise, when the top group clears the group threshold and margin
 *   family    otherwise, when the top family clears the family threshold and margin
 *   unknown   otherwise, or when the UNKNOWN class outweighs the best candidate at that level
 *
 * A closest match is a ranked model suggestion inside an accepted group/family, never a second way
 * to mark an exact movement accepted. Fine thresholds and validation status remain authoritative.
 *
 * The taxonomy and the gates come from the sport pack; nothing here names a sport.
 */
import type { MovementTaxonomy } from '@apexformz/contracts';
import { decideOpenSet, type OpenSetDecision, type RecognizerOutput } from './recognizer';

export type RecognitionLevel = 'movement' | 'group' | 'family';

export interface HierarchyGates {
  group_threshold: number;
  family_threshold: number;
  margin: number;
}

export interface MovementHierarchy {
  version: string;
  validation_status: 'approved' | 'provisional' | 'disabled';
  movement_to_group: Record<string, string>;
  group_to_family: Record<string, string>;
  names: Record<string, string>;
  gates: HierarchyGates;
}

export const DEFAULT_HIERARCHY_GATES: HierarchyGates = { group_threshold: 0.6, family_threshold: 0.6, margin: 0.1 };

/** Index a pack taxonomy. Movements not placed in the taxonomy stay fine-level only. */
export function buildMovementHierarchy(taxonomy: MovementTaxonomy | undefined | null, gates?: Partial<HierarchyGates>): MovementHierarchy | null {
  if (!taxonomy || !Array.isArray(taxonomy.families) || !taxonomy.families.length) return null;
  const movement_to_group: Record<string, string> = {};
  const group_to_family: Record<string, string> = {};
  const names: Record<string, string> = {};
  for (const f of taxonomy.families) {
    names[f.id] = f.name;
    for (const g of f.groups) {
      names[g.id] = g.name;
      group_to_family[g.id] = f.id;
      for (const m of g.members) movement_to_group[m] = g.id;
    }
  }
  const recognition = (taxonomy as MovementTaxonomy & { recognition?: Partial<HierarchyGates> }).recognition ?? {};
  const merged = { ...DEFAULT_HIERARCHY_GATES, ...pickGates(recognition), ...pickGates(gates ?? {}) };
  return { version: taxonomy.version, validation_status: taxonomy.validation_status, movement_to_group, group_to_family, names, gates: merged };
}

function pickGates(g: Partial<HierarchyGates>): Partial<HierarchyGates> {
  const out: Partial<HierarchyGates> = {};
  for (const k of ['group_threshold', 'family_threshold', 'margin'] as const) {
    const v = g[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) out[k] = v;
  }
  return out;
}

export interface HierarchicalDecision {
  level: RecognitionLevel | null;
  movement: OpenSetDecision;
  group_id: string | null;
  group_probability: number | null;
  family_id: string | null;
  family_probability: number | null;
  /** Probability mass per group and per family (only labels present in the taxonomy contribute). */
  group_probabilities: Record<string, number>;
  family_probabilities: Record<string, number>;
  closest_match: ClosestMovementMatch | null;
  reason: OpenSetDecision['reason'] | null;
}

/** A distinguishable model candidate inside a supported ancestor; explicitly approximate. */
export interface ClosestMovementMatch {
  class_label: string;
  movement_id: string;
  probability: number;
}

function topTwo(p: Record<string, number>): [string | null, number, number] {
  const e = Object.entries(p).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return [e[0]?.[0] ?? null, e[0]?.[1] ?? 0, e[1]?.[1] ?? 0];
}

/** Aggregation is meaningful only for one coherent mutually exclusive probability distribution. */
function validDistribution(out: RecognizerOutput): boolean {
  const values = [...Object.values(out.probabilities), out.unknown_probability];
  return values.every((p) => Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) <= 1e-5;
}

/**
 * @param classToMovement maps recognizer class labels to pack movement ids (identity when omitted).
 */
export function decideHierarchical(
  out: RecognizerOutput,
  thresholds: Record<string, number>,
  margin: number,
  hierarchy: MovementHierarchy,
  classToMovement: (label: string) => string | null = (l) => l,
): HierarchicalDecision {
  if (!validDistribution(out) || !Number.isFinite(margin) || margin < 0 || margin > 1) {
    return {
      level: null, movement: { movement_id: null, probability: 0, unknown: true, reason: 'UNKNOWN_CLASS' },
      group_id: null, group_probability: null, family_id: null, family_probability: null,
      group_probabilities: {}, family_probabilities: {}, closest_match: null, reason: 'UNKNOWN_CLASS',
    };
  }
  const movement = decideOpenSet(out, thresholds, margin);
  const groupP: Record<string, number> = {};
  const familyP: Record<string, number> = {};
  for (const [label, p] of Object.entries(out.probabilities)) {
    if (!Number.isFinite(p) || p <= 0) continue;
    const mid = classToMovement(label);
    const g = mid ? hierarchy.movement_to_group[mid] : undefined;
    if (!g) continue;
    groupP[g] = (groupP[g] ?? 0) + p;
    const f = hierarchy.group_to_family[g];
    if (f) familyP[f] = (familyP[f] ?? 0) + p;
  }
  const base = { movement, group_probabilities: groupP, family_probabilities: familyP, closest_match: null as ClosestMovementMatch | null };
  const unknownP = out.unknown_probability;
  const closestWithin = (group: string | null, family: string | null): ClosestMovementMatch | null => {
    const [label, probability, runnerUp] = topTwo(out.probabilities);
    if (!label || probability <= unknownP || probability <= runnerUp || probability - runnerUp < margin) return null;
    const mid = classToMovement(label);
    const candidateGroup = mid ? hierarchy.movement_to_group[mid] : null;
    if (!mid || !candidateGroup || (group ? candidateGroup !== group : hierarchy.group_to_family[candidateGroup] !== family)) return null;
    return { class_label: label, movement_id: mid, probability };
  };

  if (!movement.unknown && movement.movement_id) {
    const mid = classToMovement(movement.movement_id);
    const g = mid ? hierarchy.movement_to_group[mid] ?? null : null;
    const f = g ? hierarchy.group_to_family[g] ?? null : null;
    return { ...base, level: 'movement', group_id: g, group_probability: g ? groupP[g] ?? null : null, family_id: f, family_probability: f ? familyP[f] ?? null : null, reason: null };
  }
  if (hierarchy.validation_status === 'disabled') {
    return { ...base, level: null, group_id: null, group_probability: null, family_id: null, family_probability: null, reason: movement.reason ?? null };
  }
  // UNKNOWN can beat each exact alternative while losing to their shared group/family.
  // Compare it with the aggregate at each level rather than aborting at the exact decision.
  const { group_threshold, family_threshold, margin: m } = hierarchy.gates;
  const [g, pg, pg2] = topTwo(groupP);
  if (g && pg >= group_threshold && pg - pg2 >= m && pg > unknownP) {
    const f = hierarchy.group_to_family[g] ?? null;
    return { ...base, level: 'group', group_id: g, group_probability: pg, family_id: f, family_probability: f ? familyP[f] ?? null : null,
      closest_match: closestWithin(g, f), reason: movement.reason ?? null };
  }
  const [f, pf, pf2] = topTwo(familyP);
  if (f && pf >= family_threshold && pf - pf2 >= m && pf > unknownP) {
    return { ...base, level: 'family', group_id: null, group_probability: null, family_id: f, family_probability: pf,
      closest_match: closestWithin(null, f), reason: movement.reason ?? null };
  }
  return { ...base, level: null, group_id: null, group_probability: null, family_id: null, family_probability: null, reason: movement.reason ?? 'BELOW_THRESHOLD' };
}
