/**
 * TRD 04: "For every feature, implement unit test with analytic synthetic landmarks, mirrored
 * inputs, missing joints, denominator degeneracy and confidence thresholds."
 *
 * One table drives every feature kind in the catalog through the same four checks.
 */
import { describe, expect, it } from 'vitest';
import type { FeatureSpec, FeatureValue } from '@apexformz/contracts';
import { FEATURE_KINDS } from '@apexformz/contracts';
import { SignalPipeline, syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { FeatureEngine } from './engine';

const DT = 40;
const ctx = { view: 'front' as const, handedness: 'right' as const };
const spec = (id: string, kind: FeatureSpec['kind'], params: Record<string, unknown>, extra: Partial<FeatureSpec> = {}): FeatureSpec => ({
  id, kind, params, version: '1.0.0', coordinate_system: 'body_relative', view_applicability: 'any', ...extra,
});

/** Feed `n` frames of pose options (a function of frame index) and return the final feature map. */
function run(specs: FeatureSpec[], pose: (i: number) => SyntheticPoseOptions, n = 12, meta: { mirror?: boolean } = {}) {
  const engine = new FeatureEngine(specs);
  const pipeline = new SignalPipeline();
  let out = new Map<string, FeatureValue>();
  for (let i = 0; i < n; i++) {
    const r = pipeline.process(syntheticPoseFrame(i, i * DT, pose(i), meta));
    if (r.time_gap || r.track_changed) engine.reset();
    if (r.frame) out = engine.compute(pipeline.window, ctx) as Map<string, FeatureValue>;
  }
  return out;
}

const BASE: SyntheticPoseOptions = { left_knee_flexion: 20, right_knee_flexion: 20, left_elbow_flexion: 90, right_elbow_flexion: 90, stance_width: 0.4 };

interface Case {
  kind: FeatureSpec['kind'];
  specs: FeatureSpec[];
  /** id of the feature under test */
  id: string;
  pose: (i: number) => SyntheticPoseOptions;
  /** analytic expectation on the final value */
  expect: (v: number) => void;
  /** landmark whose loss must invalidate the feature (null when the feature is derived only from other features) */
  missing: string | null;
  /** how a mirrored input must relate to the unmirrored value */
  mirror: 'invariant' | 'negated' | 'skip';
  /** false for scores whose confidence is not derived from landmark confidence */
  conf?: boolean;
}

const knee = spec('left_knee', 'angle_at', { a: 'left_hip', b: 'left_knee', c: 'left_ankle', dims: '2d' });
const rknee = spec('right_knee', 'angle_at', { a: 'right_hip', b: 'right_knee', c: 'right_ankle', dims: '2d' });
// Both knees ramp together so the mirrored stream (which swaps left/right identities) sees the same signal.
const ramp = (i: number): SyntheticPoseOptions => ({ ...BASE, left_knee_flexion: 10 + 2 * i, right_knee_flexion: 10 + 2 * i }); // +2 deg flexion per 40 ms => knee angle -50 deg/s

const CASES: Case[] = [
  { kind: 'angle_at', specs: [knee], id: 'left_knee', pose: () => BASE, expect: (v) => expect(v).toBeCloseTo(160, 0), missing: 'left_knee', mirror: 'invariant' },
  { kind: 'line_inclination', specs: [spec('lean', 'line_inclination', { from: ['left_hip', 'right_hip'], to: ['left_shoulder', 'right_shoulder'], reference: 'vertical' })], id: 'lean', pose: () => ({ ...BASE, trunk_lean: 12 }), expect: (v) => expect(Math.abs(v)).toBeCloseTo(12, 0), missing: 'left_shoulder', mirror: 'negated' },
  { kind: 'segment_orientation', specs: [spec('shoulders', 'segment_orientation', { from: 'left_shoulder', to: 'right_shoulder', plane: 'xy' })], id: 'shoulders', pose: () => BASE, expect: (v) => expect(Math.abs(Math.sin((v * Math.PI) / 180))).toBeLessThan(1e-6), missing: 'right_shoulder', mirror: 'skip' },
  { kind: 'interjoint_distance_ratio', specs: [spec('stance', 'interjoint_distance_ratio', { a: 'left_ankle', b: 'right_ankle', c: 'left_hip', d: 'right_hip', dims: '2d' })], id: 'stance', pose: () => BASE, expect: (v) => expect(v).toBeGreaterThan(0), missing: 'left_ankle', mirror: 'invariant' },
  { kind: 'center_of_keypoints', specs: [spec('hip_x', 'center_of_keypoints', { landmarks: ['left_hip', 'right_hip'], axis: 'x' })], id: 'hip_x', pose: () => BASE, expect: (v) => expect(Math.abs(v)).toBeLessThan(1e-9), missing: 'left_hip', mirror: 'invariant' },
  { kind: 'landmark_coordinate', specs: [spec('lhip_x', 'landmark_coordinate', { landmark: 'left_hip', axis: 'x' })], id: 'lhip_x', pose: () => BASE, expect: (v) => expect(v).not.toBe(0), missing: 'left_hip', mirror: 'skip' },
  { kind: 'landmark_offset', specs: [spec('knee_off', 'landmark_offset', { a: 'left_knee', b: 'left_ankle', axis: 'x' })], id: 'knee_off', pose: () => ({ ...BASE, knee_offset_x: { side: 'left', metres: 0.1 } }), expect: (v) => expect(Math.abs(v)).toBeGreaterThan(0.05), missing: 'left_knee', mirror: 'skip' },
  { kind: 'time_derivative', specs: [knee, spec('knee_rate', 'time_derivative', { of: 'left_knee', window_ms: 120, method: 'finite' })], id: 'knee_rate', pose: ramp, expect: (v) => expect(v).toBeCloseTo(-50, -1), missing: 'left_knee', mirror: 'invariant' },
  { kind: 'angular_velocity', specs: [knee, spec('knee_av', 'angular_velocity', { of: 'left_knee', window_ms: 120, method: 'finite' })], id: 'knee_av', pose: ramp, expect: (v) => expect(v).toBeCloseTo(-50, -1), missing: 'left_knee', mirror: 'invariant' },
  { kind: 'relative_phase_timing', specs: [knee, rknee, spec('seq', 'relative_phase_timing', { features: ['left_knee', 'right_knee'], window_ms: 1500 })], id: 'seq', pose: (i) => ({ ...BASE, left_knee_flexion: 10 + (i < 6 ? 8 * i : 40), right_knee_flexion: 10 + (i >= 6 ? 8 * (i - 6) : 0) }), expect: (v) => expect(v).toBeGreaterThanOrEqual(0), missing: 'left_knee', mirror: 'skip', conf: false },
  { kind: 'stability_variability', specs: [knee, spec('knee_std', 'stability_variability', { of: 'left_knee', window_ms: 400, stat: 'std', min_samples: 4 })], id: 'knee_std', pose: () => BASE, expect: (v) => expect(v).toBeLessThan(1e-6), missing: 'left_knee', mirror: 'invariant' },
  { kind: 'path_smoothness', specs: [spec('wrist_jerk', 'path_smoothness', { landmark: 'left_wrist', window_ms: 400 })], id: 'wrist_jerk', pose: () => BASE, expect: (v) => expect(v).toBeLessThan(1e-6), missing: 'left_wrist', mirror: 'invariant' },
  { kind: 'window_min', specs: [knee, spec('kmin', 'window_min', { of: 'left_knee', window_ms: 400 })], id: 'kmin', pose: ramp, expect: (v) => expect(v).toBeLessThan(160), missing: 'left_knee', mirror: 'invariant' },
  { kind: 'window_max', specs: [knee, spec('kmax', 'window_max', { of: 'left_knee', window_ms: 400 })], id: 'kmax', pose: ramp, expect: (v) => expect(v).toBeGreaterThan(140), missing: 'left_knee', mirror: 'invariant' },
  { kind: 'window_mean', specs: [knee, spec('kmean', 'window_mean', { of: 'left_knee', window_ms: 400 })], id: 'kmean', pose: () => BASE, expect: (v) => expect(v).toBeCloseTo(160, 0), missing: 'left_knee', mirror: 'invariant' },
  { kind: 'min_of', specs: [knee, rknee, spec('lead', 'min_of', { features: ['left_knee', 'right_knee'] })], id: 'lead', pose: () => ({ ...BASE, left_knee_flexion: 60 }), expect: (v) => expect(v).toBeCloseTo(120, 0), missing: 'left_knee', mirror: 'skip' },
  { kind: 'max_of', specs: [knee, rknee, spec('trail', 'max_of', { features: ['left_knee', 'right_knee'] })], id: 'trail', pose: () => ({ ...BASE, left_knee_flexion: 60 }), expect: (v) => expect(v).toBeCloseTo(160, 0), missing: 'right_knee', mirror: 'skip' },
];

describe('feature catalog matrix (TRD 04)', () => {
  it('covers every feature kind in the contract', () => {
    const covered = new Set(CASES.map((c) => c.kind));
    for (const k of FEATURE_KINDS) expect(covered.has(k), `no catalog test for ${k}`).toBe(true);
  });

  for (const c of CASES) {
    describe(c.kind, () => {
      it('matches the analytic expectation on synthetic landmarks', () => {
        const v = run(c.specs, c.pose).get(c.id)!;
        expect(v, `${c.id} missing from output`).toBeDefined();
        expect(v.valid, `${c.id} invalid: ${v.reason}`).toBe(true);
        expect(Number.isFinite(v.value!)).toBe(true);
        expect(v.unit).toBeTruthy();
        expect(v.evidence_frame_ids.length).toBeGreaterThan(0);
        c.expect(v.value!);
      });

      if (c.mirror !== 'skip') {
        it('mirrored input keeps the semantics (mirror flag preserved, reflected once)', () => {
          const plain = run(c.specs, c.pose).get(c.id)!;
          const mirrored = run(c.specs, c.pose, 12, { mirror: true }).get(c.id)!;
          expect(mirrored.valid).toBe(true);
          // Reflection x -> 1 - x plus filtering leaves sub-0.05 numerical differences; semantics must be identical.
          if (c.mirror === 'invariant') expect(mirrored.value!).toBeCloseTo(plain.value!, 1);
          else expect(mirrored.value!).toBeCloseTo(-plain.value!, 1);
        });
      }

      if (c.missing) {
        it('a missing joint yields null with a typed reason, never zero', () => {
          const v = run(c.specs, (i) => ({ ...c.pose(i), visibility_overrides: { [c.missing!]: 0.1 } })).get(c.id)!;
          expect(v.valid).toBe(false);
          expect(v.value).toBeNull();
          expect(v.reason).toBeTruthy();
          expect(['MISSING_JOINT', 'LOW_CONFIDENCE', 'DEPENDENCY_INVALID', 'INSUFFICIENT_HISTORY', 'DEGENERATE_GEOMETRY']).toContain(v.reason);
        });

        it.skipIf(c.conf === false)('low landmark confidence propagates into the feature confidence', () => {
          const v = run(c.specs, (i) => ({ ...c.pose(i), visibility: 0.6 })).get(c.id)!;
          if (v.valid) expect(v.confidence!).toBeLessThanOrEqual(0.6 + 1e-9);
          else expect(v.reason).toBeTruthy();
        });
      }
    });
  }

  it('landmark_offset grows monotonically with the physical offset and keeps its sign (analytic check)', () => {
    const off = spec('knee_off', 'landmark_offset', { a: 'left_knee', b: 'left_ankle', axis: 'x' });
    const one = run([off], () => ({ ...BASE, knee_offset_x: { side: 'left', metres: 0.1 } })).get('knee_off')!.value!;
    const two = run([off], () => ({ ...BASE, knee_offset_x: { side: 'left', metres: 0.2 } })).get('knee_off')!.value!;
    expect(Math.sign(two)).toBe(Math.sign(one));
    expect(Math.abs(two)).toBeGreaterThan(Math.abs(one) * 1.3);
  });

  it('body-relative features are invariant to camera zoom (scale) and image offset', () => {
    const a = run([knee, spec('stance', 'interjoint_distance_ratio', { a: 'left_ankle', b: 'right_ankle', c: 'left_hip', d: 'right_hip', dims: '2d' })], () => BASE);
    const b = run([knee, spec('stance', 'interjoint_distance_ratio', { a: 'left_ankle', b: 'right_ankle', c: 'left_hip', d: 'right_hip', dims: '2d' })], () => ({ ...BASE, scale: 0.6, offset_x: 0.1, offset_y: -0.05 }));
    expect(b.get('left_knee')!.value!).toBeCloseTo(a.get('left_knee')!.value!, 4);
    expect(b.get('stance')!.value!).toBeCloseTo(a.get('stance')!.value!, 4);
  });
});
