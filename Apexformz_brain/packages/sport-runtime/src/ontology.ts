import type { CriterionDefinition, FeatureSpec, FeedbackEntry, MovementDefinition, PhaseGraph, SportPackBundle } from '@apexformz/contracts';

/**
 * Movement ontology helpers (TRD 05). Aliases only resolve when approved;
 * similar edges never resolve to a different movement.
 */
export function resolveMovement(bundle: SportPackBundle, idOrAlias: string): MovementDefinition | null {
  const direct = bundle.movement_catalog.movements.find((m) => m.id === idOrAlias || m.uuid === idOrAlias);
  if (direct) return direct;
  const lower = idOrAlias.trim().toLowerCase();
  return bundle.movement_catalog.movements.find((m) => m.aliases.some((a) => a.status === 'approved' && a.name.toLowerCase() === lower)) ?? null;
}

export function phaseGraphFor(bundle: SportPackBundle, movement: MovementDefinition): PhaseGraph {
  const g = bundle.phase_graphs.graphs.find((x) => x.id === movement.phase_graph_id);
  if (!g) throw new Error(`phase graph ${movement.phase_graph_id} missing for ${movement.id}`);
  return g;
}

export function criteriaFor(bundle: SportPackBundle, movement: MovementDefinition): CriterionDefinition[] {
  const set = new Set(movement.criteria);
  return bundle.technique_criteria.criteria.filter((c) => set.has(c.criterion_id) && c.movement_id === movement.id);
}

/** Feature specs required by a movement: criteria features, selector candidates, phase conditions, plus their dependencies. */
export function featureSpecsFor(bundle: SportPackBundle, movement: MovementDefinition): FeatureSpec[] {
  const all = new Map(bundle.technique_criteria.features.map((f) => [f.id, f]));
  const needed = new Set<string>();
  const add = (id: string) => {
    if (needed.has(id)) return;
    const spec = all.get(id);
    if (!spec) return;
    needed.add(id);
    const p = spec.params as Record<string, unknown>;
    if (typeof p.of === 'string') add(p.of);
    if (Array.isArray(p.features)) for (const f of p.features as string[]) add(f);
  };
  for (const c of criteriaFor(bundle, movement)) {
    c.required_features.forEach(add);
    c.feature_selector?.candidates.forEach(add);
  }
  const g = phaseGraphFor(bundle, movement);
  for (const p of g.phases) for (const cond of p.enter) add(cond.feature);
  return bundle.technique_criteria.features.filter((f) => needed.has(f.id));
}

export function feedbackFor(bundle: SportPackBundle, errorId: string): FeedbackEntry | null {
  return bundle.feedback_templates.entries.find((e) => e.error_id === errorId) ?? null;
}

export function similarMovements(bundle: SportPackBundle, movement: MovementDefinition): MovementDefinition[] {
  return movement.similar
    .map((s) => bundle.movement_catalog.movements.find((m) => m.id === s.movement_id))
    .filter((m): m is MovementDefinition => Boolean(m));
}
