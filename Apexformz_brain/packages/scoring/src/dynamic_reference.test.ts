import { describe, expect, it } from 'vitest';
import type { FeatureValue } from '@apexformz/contracts';
import type { DynamicReferenceModel } from '../../contracts/src/dynamic_reference';
import { DynamicReferenceComparator, type DynamicReferenceComparison } from './dynamic_reference';

function model(complete = true): DynamicReferenceModel {
  const ids = ['wrist_x', 'wrist_y', 'knee', 'elbow'];
  return {
    kind: 'dynamic_reference', schema_version: '1.0.0', movement_id: 'sport.stroke', validation_status: 'provisional',
    features: ids.map(id => ({ id, unit: 'normalized', tolerance: 0.25, weight: 1, body_joints: [id] })),
    feature_specs: ids.map(id => ({ id, kind: 'landmark_coordinate', params: { landmark: 'right_wrist', axis: 'x' }, version: '1', coordinate_system: 'body_relative', view_applicability: 'any' })),
    references: [{ id: 'reference', view: 'front', handedness: 'right', source_execution_id: 'capture', source_pose_sha256: 'a'.repeat(64), source_media_sha256: 'b'.repeat(64), start_ms: 0, end_ms: 2000, duration_ms: 2000, boundary_method: 'observed_motion', complete_capture: complete,
      samples: Array.from({ length: 21 }, (_, i) => ({ t_ms: i * 100, values: values(i / 20) })) }],
    unsupported_reasons: [], provenance: { dataset_sha256: 'c'.repeat(64), extraction_version: 'test', phase_labels_reviewed: false, tolerances_reviewed: false },
  };
}
function values(progress: number): number[] {
  const p = Math.min(1, Math.max(0, progress));
  return [p * 2, Math.sin(p * Math.PI) * 0.8, Math.sin(p * Math.PI) * 0.5, p * 0.5];
}
function features(values: Array<number | null>, timestamp_ms: number, confidence = 1, m = model()): Map<string, FeatureValue> {
  return new Map(m.features.map((f, i) => [f.id, { spec_id: f.id, name: f.id, value: values[i], unit: f.unit, valid: values[i] !== null, confidence, evidence_frame_ids: [timestamp_ms], coordinate_system: 'body_relative', timestamp_ms, view_applicability: 'any' }]));
}
function run(m = model(), options: { cadence?: number; speed?: number; modify?: (v: number[], p: number) => Array<number | null>; duration?: number } = {}) {
  const engine = new DynamicReferenceComparator(m, { view: 'front', handedness: 'right', emit_interval_ms: 0 });
  const cadence = options.cadence ?? 100, duration = options.duration ?? 2000 * (options.speed ?? 1);
  const results: DynamicReferenceComparison[] = [];
  for (let t = 0, frame = 0; t <= duration + 1000; t += cadence, frame++) {
    const p = Math.min(1, t / duration), v = options.modify?.(values(p), p) ?? values(p);
    const r = engine.observe({ timestamp_ms: t, frame_id: frame, features: features(v, t, 1, m), quality_ok: true });
    if (r) results.push(r);
  }
  return { engine, results };
}

describe('recorded dynamic reference comparator', () => {
  it.each([33, 100, 200, 333])('follows a correct ordered trajectory at %ims cadence and never passes before endpoint', cadence => {
    const { results } = run(model(), { cadence });
    expect(results.some(r => r.status === 'active')).toBe(true);
    expect(results.filter(r => r.status === 'active').every(r => r.state !== 'PASS')).toBe(true);
    const final = results.find(r => r.status === 'complete');
    expect(final).toBeDefined();
    expect(final?.state).toBe('PASS');
    expect(final?.current).toBe(false);
    expect(final?.cue_allowed).toBe(true);
  });
  it.each([0.6, 1.5, 2])('aligns correct speed variation %sx without a fault', speed => {
    const final = run(model(), { speed }).results.find(r => r.status === 'complete');
    expect(final?.state).toBe('PASS');
  });
  it('retains a supported knee fault after a corrected final posture', () => {
    const { results } = run(model(), { modify: (v, p) => { if (p > 0.25 && p < 0.75) v[2] += 0.7; return v; } });
    const live = results.find(r => r.current && r.deviations.some(d => d.feature_id === 'knee' && d.outside_reference_band));
    expect(live).toBeDefined();
    expect(live?.deviations.filter(d => d.outside_reference_band).map(d => d.feature_id)).toEqual(['knee']);
    const final = results.find(r => r.status === 'complete');
    expect(final?.state).toBe('IMPROVE');
    expect(final?.deviations.some(d => d.feature_id === 'knee' && d.outside_reference_band)).toBe(true);
  });
  it('does not accept the reversed direction as a correct movement', () => {
    const r = run(model(), { modify: v => [-v[0], v[1], v[2], v[3]] }).results;
    expect(r.some(x => x.state === 'PASS')).toBe(false);
    expect(r.some(x => x.sequence_mismatch || x.deviations.some(d => d.feature_id === 'wrist_x' && d.outside_reference_band))).toBe(true);
  });
  it('does not pass a reordered trajectory', () => {
    const r = run(model(), { modify: (_, p) => values(p < 0.5 ? p * 1.7 : Math.max(0, 1.7 - p * 1.7)) }).results;
    expect(r.some(x => x.state === 'PASS')).toBe(false);
  });
  it('does not pass a movement with severely reduced excursion', () => {
    const r = run(model(), { modify: (_, p) => values(p * 0.25) }).results;
    expect(r.some(x => x.state === 'PASS')).toBe(false);
    // A correct prefix followed by a pause supplies no evidence of the rest;
    // it must not become a completed/pass movement or an invented local fault.
    expect(r.some(x => x.status === 'active' && x.progress < 0.5)).toBe(true);
    expect(r.every(x => !x.completed && !x.segment_matched)).toBe(true);
  });
  it('a single noisy frame cannot become a supported local fault', () => {
    const r = run(model(), { modify: (v, p) => { if (Math.abs(p - 0.5) < 0.01) v[2] += 0.7; return v; } }).results;
    expect(r.some(x => x.deviations.some(d => d.feature_id === 'knee' && d.outside_reference_band))).toBe(false);
  });
  it('never treats a stationary reference-like posture as an attempt', () => {
    const r = run(model(), { modify: () => values(0.4) }).results;
    expect(r.every(x => x.status === 'waiting')).toBe(true);
    expect(r.every(x => !x.completed)).toBe(true);
  });
  it('partial source can reach a matching segment but never confirm the whole sequence', () => {
    const r = run(model(false)).results;
    expect(r.some(x => x.status === 'incomplete' && x.segment_matched && !x.sequence_mismatch)).toBe(true);
    expect(r.every(x => !x.completed && x.state !== 'PASS')).toBe(true);
  });
  it('does not grade motion beyond the end of a partial recording', () => {
    const m = model(false), engine = new DynamicReferenceComparator(m, { view: 'front', handedness: 'right', emit_interval_ms: 0 });
    const results: DynamicReferenceComparison[] = [];
    for (let t = 0; t <= 3000; t += 100) {
      const p = t / 2000, vs = p <= 1 ? values(p) : [2 + (p - 1) * 3, (p - 1) * 2, 0, 0.5];
      const r = engine.observe({ timestamp_ms: t, frame_id: t / 100, features: features(vs, t), quality_ok: true });
      if (r) results.push(r);
    }
    const review = results.findIndex(r => r.status === 'incomplete' && r.segment_matched);
    expect(review).toBeGreaterThan(-1);
    expect(results.slice(review + 1).every(r => !r.current && r.deviations.length === 0)).toBe(true);
    expect(results.some(r => r.state === 'IMPROVE')).toBe(false);
  });
  it('retains a legitimate pause within an ordered reference instead of restarting in its middle', () => {
    const m = model();
    const ref = m.references[0];
    ref.duration_ms = ref.end_ms = 4000;
    ref.samples = Array.from({ length: 41 }, (_, i) => ({ t_ms: i * 100, values: values(i < 10 ? i / 20 : i < 30 ? 0.5 : (i - 20) / 20) }));
    const engine = new DynamicReferenceComparator(m, { view: 'front', handedness: 'right', emit_interval_ms: 0 });
    const results: DynamicReferenceComparison[] = [];
    for (let t = 0; t <= 5000; t += 100) {
      const p = t < 1000 ? t / 2000 : t < 3000 ? 0.5 : Math.min(1, (t - 2000) / 2000);
      const r = engine.observe({ timestamp_ms: t, frame_id: t / 100, features: features(values(p), t), quality_ok: true });
      if (r) results.push(r);
    }
    expect(results.some(r => r.state === 'IMPROVE')).toBe(false);
    expect(results.find(r => r.status === 'complete')?.state).toBe('PASS');
    expect(new Set(results.flatMap(r => r.attempt_id ? [r.attempt_id] : [])).size).toBe(1);
  });
  it('can select a valid recorded variant whose early prefix is shared with another example', () => {
    const m = model();
    const alternative = structuredClone(m.references[0]);
    alternative.id = 'alternative';
    for (const s of alternative.samples) if (s.t_ms >= 1000) s.values[2]! += 0.7;
    m.references.push(alternative);
    const r = run(m, { modify: (v, p) => { if (p >= 0.5) v[2] += 0.7; return v; } }).results;
    expect(r.some(x => x.state === 'IMPROVE')).toBe(false);
    expect(r.find(x => x.status === 'complete')?.reference_id).toBe('alternative');
  });
  it('abstains on absent exact view or handedness and invalid model bytes', () => {
    for (const opts of [{ view: 'back', handedness: 'right' }, { view: 'front', handedness: 'left' }, { view: 'front', handedness: 'right', handedness_assumed: true }] as const) {
      const engine = new DynamicReferenceComparator(model(), opts);
      expect(engine.observe({ timestamp_ms: 0, frame_id: 0, features: features(values(0), 0), quality_ok: true })?.status).toBe('unavailable');
    }
    const bad = new DynamicReferenceComparator({} as DynamicReferenceModel, { view: 'front', handedness: 'right' });
    expect(bad.observe({ timestamp_ms: 0, frame_id: 0, features: new Map(), quality_ok: true })?.reason).toBe('MODEL_UNAVAILABLE');
  });
  it('quality loss and time gaps reset attempt evidence instead of joining sequences', () => {
    const { engine } = run();
    expect(engine.observe({ timestamp_ms: 5000, frame_id: 100, features: features(values(0.5), 5000), quality_ok: true })?.reason).toBe('TIME_GAP');
    expect(engine.cueAllowed).toBe(false);
    expect(engine.observe({ timestamp_ms: 5100, frame_id: 101, features: features(values(0.6), 5100), quality_ok: false })?.current).toBe(false);
    expect(engine.cueAllowed).toBe(false);
  });
  it('missing/low-confidence geometry cannot produce fault or completed evidence', () => {
    const engine = new DynamicReferenceComparator(model(), { view: 'front', handedness: 'right' });
    const a = engine.observe({ timestamp_ms: 0, frame_id: 0, features: features(values(0.5), 0, 0.1), quality_ok: true });
    expect(a?.reason).toBe('COVERAGE_INSUFFICIENT');
    expect(a?.deviations).toEqual([]);
    expect(a?.completed).toBe(false);
  });
  it('reused stale feature values are unavailable rather than fresh repeated evidence', () => {
    const engine = new DynamicReferenceComparator(model(), { view: 'front', handedness: 'right' });
    const r = engine.observe({ timestamp_ms: 200, frame_id: 2, features: features(values(0.5), 0), quality_ok: true });
    expect(r?.reason).toBe('COVERAGE_INSUFFICIENT');
  });
  it('normalizes root travel for camera position and torso image scale without cancelling movement', () => {
    const m = model();
    m.features.push({ id: 'root', unit: 'normalized', tolerance: 0.25, weight: 1, body_joints: ['left_hip', 'right_hip'], relative_to_start: true, scale_feature_id: 'scale' },
      { id: 'scale', unit: 'px', tolerance: 10, weight: 0, body_joints: [] });
    for (const id of ['root', 'scale']) m.feature_specs.push({ id, kind: 'landmark_coordinate', params: { landmark: 'left_hip', axis: 'x' }, version: '1', coordinate_system: 'image_pixel', view_applicability: 'any' });
    for (const s of m.references[0].samples) s.values.push(1000 + 100 * s.t_ms / 1000, 100);
    const engine = new DynamicReferenceComparator(m, { view: 'front', handedness: 'right', emit_interval_ms: 0 });
    const results: DynamicReferenceComparison[] = [];
    for (let t = 0; t <= 3000; t += 100) {
      const p = Math.min(1, t / 2000), vs = [...values(p), 300 + 400 * p, 200];
      const r = engine.observe({ timestamp_ms: t, frame_id: t / 100, features: features(vs, t, 1, m), quality_ok: true });
      if (r) results.push(r);
    }
    expect(results.find(r => r.status === 'complete')?.state).toBe('PASS');
    expect(results.some(r => r.deviations.some(d => d.feature_id === 'root' && d.outside_reference_band))).toBe(false);
  });
});
