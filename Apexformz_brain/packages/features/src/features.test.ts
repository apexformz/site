import { describe, expect, it } from 'vitest';
import type { FeatureSpec } from '@apexformz/contracts';
import { SignalPipeline, syntheticPoseFrame } from '@apexformz/signal';
import { FeatureEngine } from './engine';
import { angleAt } from './geometry';

const spec = (id: string, kind: FeatureSpec['kind'], params: Record<string, unknown>, extra: Partial<FeatureSpec> = {}): FeatureSpec => ({
  id, kind, params, version: '1.0.0', coordinate_system: 'body_relative', view_applicability: 'any', ...extra,
});

const ctx = { view: 'front' as const, handedness: 'right' as const };

describe('geometry', () => {
  it('computes 180 degrees for collinear points and null for degenerate segments', () => {
    const v = angleAt({ x: 0, y: 0, z: null }, { x: 1, y: 0, z: null }, { x: 2, y: 0, z: null }, false);
    expect(v).toBeCloseTo(180, 9);
    expect(angleAt({ x: 1, y: 1, z: null }, { x: 1, y: 1, z: null }, { x: 2, y: 0, z: null }, false)).toBeNull();
    expect(angleAt({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, true)).toBeCloseTo(90, 9);
  });
});

function runFrames(engine: FeatureEngine, frames: ReturnType<typeof syntheticPoseFrame>[], pipeline = new SignalPipeline()) {
  let out = new Map();
  for (const f of frames) {
    const r = pipeline.process(f);
    if (r.time_gap || r.track_changed) engine.reset();
    if (r.frame) out = engine.compute(pipeline.window, ctx);
  }
  return out;
}

describe('FeatureEngine', () => {
  it('angle_at on a straight elbow is ~180 and flexed elbow is lower', () => {
    const eng = new FeatureEngine([spec('left_elbow', 'angle_at', { a: 'left_shoulder', b: 'left_elbow', c: 'left_wrist' })]);
    const straight = runFrames(eng, [syntheticPoseFrame(0, 0, { left_elbow_flexion: 0 })]).get('left_elbow')!;
    expect(straight.valid).toBe(true);
    expect(straight.value!).toBeGreaterThan(178);
    eng.reset();
    const flexed = runFrames(eng, [syntheticPoseFrame(0, 0, { left_elbow_flexion: 90 })]).get('left_elbow')!;
    expect(flexed.value!).toBeCloseTo(90, 0);
    expect(flexed.unit).toBe('deg');
    expect(flexed.coordinate_system).toBe('body_relative');
  });

  it('reports missing joints with a typed reason instead of zero', () => {
    const eng = new FeatureEngine([spec('left_elbow', 'angle_at', { a: 'left_shoulder', b: 'left_elbow', c: 'left_wrist' })]);
    const v = runFrames(eng, [syntheticPoseFrame(0, 0, { visibility_overrides: { left_wrist: 0.1 } })]).get('left_elbow')!;
    expect(v.valid).toBe(false);
    expect(v.value).toBeNull();
    expect(v.reason).toBe('LOW_CONFIDENCE');
  });

  it('resolves dominant side tokens from handedness and fails closed when unknown', () => {
    const eng = new FeatureEngine([spec('dom_knee', 'angle_at', { a: 'dominant_hip', b: 'dominant_knee', c: 'dominant_ankle' })]);
    const p = new SignalPipeline();
    p.process(syntheticPoseFrame(0, 0, { right_knee_flexion: 60 }));
    const right = eng.compute(p.window, { view: 'front', handedness: 'right' }).get('dom_knee')!;
    expect(right.value!).toBeCloseTo(120, 0);
    eng.reset();
    const unknown = eng.compute(p.window, { view: 'front', handedness: 'unknown' }).get('dom_knee')!;
    expect(unknown.valid).toBe(false);
    expect(unknown.reason).toBe('HANDEDNESS_UNKNOWN');
  });

  it('marks view-restricted features VIEW_INVALID outside permitted views', () => {
    const eng = new FeatureEngine([spec('twist', 'segment_orientation', { from: 'left_shoulder', to: 'right_shoulder' }, { view_applicability: ['front'] })]);
    const p = new SignalPipeline();
    p.process(syntheticPoseFrame(0, 0));
    expect(eng.compute(p.window, { view: 'left', handedness: 'right' }).get('twist')!.reason).toBe('VIEW_INVALID');
  });

  it('time derivative is timestamp aware and resets across gaps', () => {
    const eng = new FeatureEngine([
      spec('knee', 'angle_at', { a: 'left_hip', b: 'left_knee', c: 'left_ankle' }),
      spec('knee_vel', 'angular_velocity', { of: 'knee', window_ms: 200 }),
    ]);
    const frames = [];
    for (let i = 0; i < 10; i++) frames.push(syntheticPoseFrame(i, i * 50, { left_knee_flexion: i * 5 }));
    const out = runFrames(eng, frames);
    const vel = out.get('knee_vel')!;
    expect(vel.valid).toBe(true);
    expect(vel.unit).toBe('deg_per_s');
    // 5 deg per 50 ms of flexion => angle decreases by ~100 deg/s
    expect(vel.value!).toBeLessThan(-80);
    expect(vel.value!).toBeGreaterThan(-120);
    // After a gap the first sample has no history
    const pipeline = new SignalPipeline();
    const eng2 = new FeatureEngine([
      spec('knee', 'angle_at', { a: 'left_hip', b: 'left_knee', c: 'left_ankle' }),
      spec('knee_vel', 'angular_velocity', { of: 'knee', window_ms: 200 }),
    ]);
    runFrames(eng2, frames, pipeline);
    const after = runFrames(eng2, [syntheticPoseFrame(10, 10 * 50 + 5000, { left_knee_flexion: 50 })], pipeline).get('knee_vel')!;
    expect(after.valid).toBe(false);
    expect(after.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('stability variability needs history and is near zero for a held pose', () => {
    const eng = new FeatureEngine([
      spec('wrist_y', 'landmark_coordinate', { landmark: 'right_wrist', axis: 'y' }),
      spec('wrist_stab', 'stability_variability', { of: 'wrist_y', window_ms: 1000, min_samples: 5 }),
    ]);
    const frames = [];
    for (let i = 0; i < 20; i++) frames.push(syntheticPoseFrame(i, i * 50, { right_arm_raise: 90 }));
    const out = runFrames(eng, frames);
    expect(out.get('wrist_stab')!.valid).toBe(true);
    expect(out.get('wrist_stab')!.value!).toBeLessThan(1e-6);
  });

  it('rejects dependency cycles at construction', () => {
    expect(() => new FeatureEngine([
      spec('a', 'time_derivative', { of: 'b' }),
      spec('b', 'time_derivative', { of: 'a' }),
    ])).toThrow(/cycle/);
  });

  it('interjoint ratio flags degenerate denominators', () => {
    const eng = new FeatureEngine([spec('ratio', 'interjoint_distance_ratio', { a: 'left_ankle', b: 'right_ankle', c: 'left_shoulder', d: 'left_shoulder' })]);
    const v = runFrames(eng, [syntheticPoseFrame(0, 0)]).get('ratio')!;
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('DEGENERATE_GEOMETRY');
  });

  it('relative phase timing scores ordering of peak velocities', () => {
    const eng = new FeatureEngine([
      spec('knee', 'angle_at', { a: 'left_hip', b: 'left_knee', c: 'left_ankle' }),
      spec('elbow', 'angle_at', { a: 'left_shoulder', b: 'left_elbow', c: 'left_wrist' }),
      spec('order', 'relative_phase_timing', { features: ['knee', 'elbow'], window_ms: 2000 }),
    ]);
    const frames = [];
    for (let i = 0; i < 30; i++) {
      const knee = i < 10 ? i * 6 : 60; // knee moves first
      const elbow = i >= 15 && i < 25 ? (i - 15) * 9 : i >= 25 ? 90 : 0; // elbow later
      frames.push(syntheticPoseFrame(i, i * 40, { left_knee_flexion: knee, left_elbow_flexion: elbow }));
    }
    const v = runFrames(eng, frames).get('order')!;
    expect(v.valid).toBe(true);
    expect(v.value).toBe(1);
  });
});
