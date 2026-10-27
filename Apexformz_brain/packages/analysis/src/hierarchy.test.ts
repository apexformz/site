import { describe, expect, it } from 'vitest';
import type { MovementTaxonomy } from '@apexformz/contracts';
import { buildMovementHierarchy, decideHierarchical } from './hierarchy';
import type { RecognizerOutput } from './recognizer';

const taxonomy: MovementTaxonomy = {
  version: '1.0.0', levels: ['family', 'group', 'movement'], validation_status: 'provisional',
  families: [
    { id: 'x.family.strokes', name: 'Strokes', type: 'dynamic', groups: [
      { id: 'x.group.drives', name: 'Drives', members: ['x.drive_a', 'x.drive_b', 'x.drive_c'] },
      { id: 'x.group.drops', name: 'Drops', members: ['x.drop_a'] },
    ] },
    { id: 'x.family.travel', name: 'Travel', type: 'dynamic', groups: [
      { id: 'x.group.forward', name: 'Forward', members: ['x.fwd_a', 'x.fwd_b'] },
      { id: 'x.group.lateral', name: 'Lateral', members: ['x.lat_a'] },
    ] },
  ],
};
const model = { model_id: 'm', version: '1' };
const out = (p: Record<string, number>, unknown = 0): RecognizerOutput => ({ probabilities: p, unknown_probability: unknown, model });
const thresholds = (v: number) => Object.fromEntries(['x.drive_a', 'x.drive_b', 'x.drive_c', 'x.drop_a', 'x.fwd_a', 'x.fwd_b', 'x.lat_a'].map((k) => [k, v]));

describe('hierarchical open-set decision', () => {
  const h = buildMovementHierarchy(taxonomy)!;

  it('indexes movements to groups and groups to families with names', () => {
    expect(h.movement_to_group['x.drive_b']).toBe('x.group.drives');
    expect(h.group_to_family['x.group.lateral']).toBe('x.family.travel');
    expect(h.names['x.family.strokes']).toBe('Strokes');
    expect(h.gates).toEqual({ group_threshold: 0.6, family_threshold: 0.6, margin: 0.1 });
  });

  it('accepts the specific movement when the fine decision clears its gate, and reports its ancestors', () => {
    const d = decideHierarchical(out({ 'x.drive_a': 0.8, 'x.drive_b': 0.1, 'x.fwd_a': 0.1 }), thresholds(0.5), 0.1, h);
    expect(d.level).toBe('movement');
    expect(d.movement.movement_id).toBe('x.drive_a');
    expect(d.group_id).toBe('x.group.drives');
    expect(d.family_id).toBe('x.family.strokes');
    expect(d.group_probability).toBeCloseTo(0.9, 9);
    expect(d.closest_match).toBeNull();
  });

  it('falls back to the group when near-identical members split the probability', () => {
    const d = decideHierarchical(out({ 'x.drive_a': 0.36, 'x.drive_b': 0.34, 'x.drive_c': 0.1, 'x.fwd_a': 0.2 }), thresholds(0.5), 0.1, h);
    expect(d.movement.unknown).toBe(true);
    expect(d.level).toBe('group');
    expect(d.group_id).toBe('x.group.drives');
    expect(d.group_probability).toBeCloseTo(0.8, 9);
    expect(d.family_id).toBe('x.family.strokes');
    expect(d.closest_match).toBeNull(); // no arbitrary exact name when near-identical alternatives tie
  });

  it('falls back to the family when its groups split the probability', () => {
    const d = decideHierarchical(out({ 'x.fwd_a': 0.2, 'x.fwd_b': 0.2, 'x.lat_a': 0.35, 'x.drive_a': 0.25 }), thresholds(0.5), 0.1, h);
    expect(d.level).toBe('family');
    expect(d.group_id).toBeNull();
    expect(d.family_id).toBe('x.family.travel');
    expect(d.family_probability).toBeCloseTo(0.75, 9);
  });

  it('reports nothing when even the families are ambiguous', () => {
    const d = decideHierarchical(out({ 'x.fwd_a': 0.25, 'x.drive_a': 0.25, 'x.lat_a': 0.25, 'x.drop_a': 0.25 }), thresholds(0.5), 0.1, h);
    expect(d.level).toBeNull();
    expect(d.reason).toBeTruthy();
  });

  it('recognizes a shared group even when UNKNOWN outweighs each exact alternative', () => {
    const d = decideHierarchical(out({ 'x.drive_a': 0.3, 'x.drive_b': 0.3 }, 0.4), thresholds(0.5), 0.1, h);
    expect(d.level).toBe('group');
    expect(d.group_id).toBe('x.group.drives');
    expect(d.movement.reason).toBe('UNKNOWN_CLASS');
    expect(d.closest_match).toBeNull();
  });

  it('recognizes a shared family when UNKNOWN outweighs each alternative but not the family', () => {
    const d = decideHierarchical(out({ 'x.fwd_a': 0.2, 'x.fwd_b': 0.2, 'x.lat_a': 0.25 }, 0.35), thresholds(0.5), 0.1, h);
    expect(d.level).toBe('family');
    expect(d.family_id).toBe('x.family.travel');
    expect(d.closest_match).toBeNull();
  });

  it('keeps abstaining when UNKNOWN dominates or ties the whole candidate family', () => {
    for (const unknown of [0.5, 0.6]) {
      const d = decideHierarchical(out({ 'x.drive_a': (1 - unknown) / 2, 'x.drive_b': (1 - unknown) / 2 }, unknown), thresholds(0.5), 0.1,
        { ...h, gates: { group_threshold: 0.3, family_threshold: 0.3, margin: 0.1 } });
      expect(d.level).toBeNull();
      expect(d.reason).toBe('UNKNOWN_CLASS');
      expect(d.closest_match).toBeNull();
    }
  });

  it('offers a distinguishable closest match without overriding the exact abstention gate', () => {
    const d = decideHierarchical(out({ 'x.drive_a': 0.82, 'x.drive_b': 0.08, 'x.fwd_a': 0.05 }, 0.05), thresholds(1), 0.1, h);
    expect(d.level).toBe('group');
    expect(d.movement).toMatchObject({ unknown: true, movement_id: null, reason: 'BELOW_THRESHOLD' });
    expect(d.closest_match).toEqual({ class_label: 'x.drive_a', movement_id: 'x.drive_a', probability: 0.82 });
  });

  it('can suggest the closest movement within an accepted family', () => {
    const d = decideHierarchical(out({ 'x.fwd_a': 0.17, 'x.fwd_b': 0.15, 'x.lat_a': 0.4, 'x.drive_a': 0.18 }, 0.1), thresholds(1), 0.1, h);
    expect(d.level).toBe('family');
    expect(d.closest_match?.movement_id).toBe('x.lat_a');
  });

  it('does not attach a globally stronger outlier to the winning group', () => {
    const d = decideHierarchical(out({ 'x.drive_a': 0.22, 'x.drive_b': 0.21, 'x.drive_c': 0.2, 'x.fwd_a': 0.36 }, 0.01), thresholds(1), 0.1, h);
    expect(d.level).toBe('group');
    expect(d.group_id).toBe('x.group.drives');
    expect(d.closest_match).toBeNull();
  });

  it('never suggests unmapped classes or disabled taxonomy fallback', () => {
    const d = decideHierarchical(out({ other: 0.7, 'x.drive_a': 0.3 }), { other: 1, ...thresholds(1) }, 0.1, h, (l) => l === 'other' ? null : l);
    expect(d.level).toBeNull();
    expect(d.closest_match).toBeNull();
    const disabled = decideHierarchical(out({ 'x.drive_a': 0.8, 'x.drive_b': 0.2 }), thresholds(1), 0.1, { ...h, validation_status: 'disabled' });
    expect(disabled.level).toBeNull();
    expect(disabled.closest_match).toBeNull();
  });

  it.each([
    [{ 'x.drive_a': NaN }, 0],
    [{ 'x.drive_a': Infinity }, 0],
    [{ 'x.drive_a': -0.1, 'x.drive_b': 1 }, 0.1],
    [{ 'x.drive_a': 1.1 }, 0],
    [{ 'x.drive_a': 0.9 }, NaN],
    [{ 'x.drive_a': 0.9 }, -0.1],
    [{ 'x.drive_a': 0.9 }, 0.9],
    [{ 'x.drive_a': 0.1 }, 0.1],
    [{}, 0],
  ])('rejects invalid or unnormalized posterior %j / %s', (probabilities, unknown) => {
    const d = decideHierarchical(out(probabilities as Record<string, number>, unknown as number), thresholds(0.5), 0.1, h);
    expect(d.level).toBeNull();
    expect(d.movement.unknown).toBe(true);
    expect(d.closest_match).toBeNull();
  });

  it('accepts ordinary softmax roundoff in the probability sum', () => {
    const d = decideHierarchical(out({ 'x.drive_a': 0.80000001, 'x.drive_b': 0.1 }, 0.1), thresholds(0.5), 0.1, h);
    expect(d.level).toBe('movement');
  });

  it('a provisional export gate of 1.0 still allows a confident group or family answer', () => {
    const d = decideHierarchical(out({ 'x.drive_a': 0.5, 'x.drive_b': 0.45, 'x.fwd_a': 0.05 }), thresholds(1.0), 0.1, h);
    expect(d.movement.reason).toBe('BELOW_THRESHOLD');
    expect(d.level).toBe('group');
  });

  it('maps recognizer class labels to pack movement ids before aggregating', () => {
    const d = decideHierarchical(out({ c1: 0.5, c2: 0.4, c3: 0.1 }), { c1: 1, c2: 1, c3: 1 }, 0.1, h, (l) => ({ c1: 'x.drive_a', c2: 'x.drive_b', c3: 'x.fwd_a' } as Record<string, string>)[l] ?? null);
    expect(d.level).toBe('group');
    expect(d.group_id).toBe('x.group.drives');
  });

  it('pack gates override the defaults; out-of-range values are ignored', () => {
    const h2 = buildMovementHierarchy({ ...taxonomy, recognition: { group_threshold: 0.9, family_threshold: 2, margin: 0.2 } } as MovementTaxonomy)!;
    expect(h2.gates).toEqual({ group_threshold: 0.9, family_threshold: 0.6, margin: 0.2 });
    expect(buildMovementHierarchy(undefined)).toBeNull();
  });
});
