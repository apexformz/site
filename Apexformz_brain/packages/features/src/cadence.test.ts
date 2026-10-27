import { describe, expect, it } from 'vitest';
import type { FeatureSpec } from '@apexformz/contracts';
import { SignalPipeline, syntheticPoseFrame } from '@apexformz/signal';
import { FeatureEngine } from './engine';

const specs: FeatureSpec[] = [
  { id: 'elbow', kind: 'angle_at', params: { a: 'left_shoulder', b: 'left_elbow', c: 'left_wrist' }, version: '1', coordinate_system: 'body_relative', view_applicability: 'any' },
  { id: 'speed', kind: 'angular_velocity', params: { of: 'elbow', window_ms: 150, method: 'finite' }, version: '1', coordinate_system: 'body_relative', view_applicability: 'any' },
  { id: 'spread', kind: 'stability_variability', params: { of: 'elbow', window_ms: 600, min_samples: 4, stat: 'std' }, version: '1', coordinate_system: 'body_relative', view_applicability: 'any' },
];
const ctx = { view: 'front' as const, handedness: 'right' as const };
function runner(adapt = true) {
  const engine = new FeatureEngine(specs, adapt ? { cadence_max_gap_ms: 400 } : {});
  const pipeline = new SignalPipeline({ allow_short_gap_prediction: false });
  return { engine, feed: (id: number, timestamp: number, flexion = 20, missing = false, identity = 'athlete') => {
    const f = syntheticPoseFrame(id, timestamp, { left_elbow_flexion: flexion, ...(missing ? { visibility_overrides: { left_wrist: 0.1 } } : {}) }, { tracked_subject_id: identity });
    const signal = pipeline.process(f);
    if (signal.time_gap || signal.track_changed) engine.reset();
    return engine.compute(pipeline.window, ctx);
  } };
}

describe('opt-in dynamic cadence handling', () => {
  it.each([{ times: [0, 203, 405, 608] }, { times: [0, 333, 669, 1003] }])('uses actual observation time at sparse jittered cadence $times', ({ times }) => {
    const { feed } = runner();
    const maps = times.map((t, i) => feed(i, t, 20 + i * 5));
    const speed = maps.at(-1)!.get('speed')!;
    expect(speed.valid).toBe(true);
    const dt = times.at(-1)! - times.at(-2)!;
    expect(speed.value).toBeCloseTo((maps.at(-1)!.get('elbow')!.value! - maps.at(-2)!.get('elbow')!.value!) * 1000 / dt, 8);
    expect(speed.evidence_frame_ids).toEqual([2, 3]);
    expect(speed.meta).toMatchObject({ cadence_adapted: true, effective_span_ms: dt, requested_span_ms: 150 });
    expect(maps[2].get('spread')!.valid).toBe(false);
    expect(maps[3].get('spread')!).toMatchObject({ valid: true, evidence_frame_ids: [0, 1, 2, 3] });
    expect(maps[3].get('spread')!.meta).toMatchObject({ samples: 4, cadence_adapted: true, effective_span_ms: times[3] });
  });

  it('does not extend fixed windows unless explicitly enabled', () => {
    const { feed } = runner(false);
    const maps = [0, 333, 666, 999].map((t, i) => feed(i, t));
    expect(maps.at(-1)!.get('speed')!.reason).toBe('INSUFFICIENT_HISTORY');
    expect(maps.at(-1)!.get('spread')!.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('does not bridge a 401ms gap or an identity change', () => {
    const { feed } = runner();
    [0, 200, 400, 600].forEach((t, i) => feed(i, t));
    const gap = feed(4, 1001);
    expect(gap.get('speed')!.reason).toBe('INSUFFICIENT_HISTORY');
    expect(gap.get('spread')!.reason).toBe('INSUFFICIENT_HISTORY');
    const changed = feed(5, 1201, 20, false, 'another-athlete');
    expect(changed.get('speed')!.reason).toBe('INSUFFICIENT_HISTORY');
    expect(changed.get('spread')!.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('does not reuse values across an invalid intermediate landmark observation', () => {
    const { feed } = runner();
    [0, 100, 200, 300].forEach((t, i) => feed(i, t));
    const missing = feed(4, 500, 20, true);
    expect(missing.get('elbow')!.valid).toBe(false);
    expect(missing.get('spread')!.valid).toBe(false);
    const returned = feed(5, 700);
    expect(returned.get('speed')!.reason).toBe('INSUFFICIENT_HISTORY');
    expect(returned.get('spread')!.reason).toBe('INSUFFICIENT_HISTORY');
    expect(feed(6, 900).get('spread')!.valid).toBe(false);
    expect(feed(7, 1100).get('spread')!.valid).toBe(false);
    expect(feed(8, 1301).get('spread')!.valid).toBe(true);
  });

  it('does not infer unsampled peak speed or make a fitted derivative from two observations', () => {
    const { feed } = runner();
    const first = feed(0, 0, 20);
    const second = feed(1, 333, 40);
    expect(second.get('speed')!.value).toBeCloseTo((second.get('elbow')!.value! - first.get('elbow')!.value!) / .333, 8);
    const fit = new FeatureEngine(specs.map(s => s.id === 'speed' ? { ...s, params: { ...s.params, method: 'fit' } } : s), { cadence_max_gap_ms: 400 });
    const p = new SignalPipeline();
    p.process(syntheticPoseFrame(0, 0)); fit.compute(p.window, ctx);
    p.process(syntheticPoseFrame(1, 333));
    expect(fit.compute(p.window, ctx).get('speed')!.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('also rejects an invalid intervening sample inside the original fast-capture window', () => {
    const { feed } = runner();
    feed(0, 0); feed(1, 40); feed(2, 80, 20, true);
    expect(feed(3, 120).get('speed')!.reason).toBe('INSUFFICIENT_HISTORY');
    expect(feed(4, 160).get('speed')!.valid).toBe(true);
  });
});
