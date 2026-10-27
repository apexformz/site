import { describe, expect, it } from 'vitest';
import { LANDMARK_INDEX } from '@apexformz/contracts';
import { SignalPipeline } from './pipeline';
import { TimeGuard } from './time_guard';
import { OneEuroFilter } from './one_euro';
import { syntheticPoseFrame } from './synthetic';
import { canonicalizeMirror, normalizeBodyRelative, toFilteredImageLandmarks } from './coordinates';

describe('TimeGuard', () => {
  it('accepts monotonic frames, rejects regression and duplicates, flags gaps', () => {
    const g = new TimeGuard(400);
    expect(g.check(0, 0).accepted).toBe(true);
    expect(g.check(33, 1)).toMatchObject({ accepted: true, dt_ms: 33, gap: false });
    expect(g.check(33, 1)).toMatchObject({ accepted: false, duplicate: true });
    expect(g.check(20, 2)).toMatchObject({ accepted: false, regression: true });
    expect(g.check(900, 3)).toMatchObject({ accepted: true, gap: true, dt_ms: null });
    expect(g.stats).toEqual({ regressions: 1, duplicates: 1, gaps: 1 });
  });
});

describe('OneEuroFilter', () => {
  it('converges to a constant and tracks a fast ramp without large lag', () => {
    const f = new OneEuroFilter(1.0, 0.1, 1.0);
    let v = 0;
    for (let i = 0; i < 60; i++) v = f.filter(1, i / 30);
    expect(v).toBeCloseTo(1, 2);
    const g = new OneEuroFilter(1.0, 0.5, 1.0);
    let last = 0;
    for (let i = 0; i < 30; i++) last = g.filter(i * 0.1, i / 30);
    expect(Math.abs(last - 2.9)).toBeLessThan(0.3);
  });
});

describe('coordinates', () => {
  it('mirrors exactly once and swaps left/right identities', () => {
    const f = syntheticPoseFrame(0, 0, {}, { mirror: true });
    const { landmarks, applied } = canonicalizeMirror(f);
    expect(applied).toBe(true);
    const lk = LANDMARK_INDEX['left_knee'];
    const rk = LANDMARK_INDEX['right_knee'];
    expect(landmarks[lk].x).toBeCloseTo(1 - f.normalized_landmarks[rk].x, 9);
    expect(landmarks[rk].x).toBeCloseTo(1 - f.normalized_landmarks[lk].x, 9);
    // mirrored frame canonicalizes to the same geometry as the unmirrored one
    const u = syntheticPoseFrame(0, 0);
    const canon = canonicalizeMirror(u).landmarks;
    for (let i = 0; i < 33; i++) {
      expect(landmarks[i].x).toBeCloseTo(canon[i].x, 6);
      expect(landmarks[i].y).toBeCloseTo(canon[i].y, 6);
    }
  });

  it('normalizes to body_relative with hip-mid origin and unit torso', () => {
    const f = syntheticPoseFrame(0, 0, { trunk_lean: 0 });
    const img = toFilteredImageLandmarks(f.normalized_landmarks, 0.5);
    const n = normalizeBodyRelative(img, f.image_size);
    expect(n.valid).toBe(true);
    const lh = n.body[LANDMARK_INDEX['left_hip']];
    const rh = n.body[LANDMARK_INDEX['right_hip']];
    expect((lh.x + rh.x) / 2).toBeCloseTo(0, 6);
    expect((lh.y + rh.y) / 2).toBeCloseTo(0, 6);
    const ls = n.body[LANDMARK_INDEX['left_shoulder']];
    const rs = n.body[LANDMARK_INDEX['right_shoulder']];
    expect(Math.hypot((ls.x + rs.x) / 2, (ls.y + rs.y) / 2)).toBeCloseTo(1, 6);
  });

  it('reports missing root instead of inventing one', () => {
    const f = syntheticPoseFrame(0, 0, { visibility_overrides: { left_hip: 0.1 } });
    const img = toFilteredImageLandmarks(f.normalized_landmarks, 0.5);
    const n = normalizeBodyRelative(img, f.image_size);
    expect(n.valid).toBe(false);
    expect(n.reason).toBe('MISSING_JOINT');
    expect(n.body.every((l) => !l.valid)).toBe(true);
  });
});

describe('SignalPipeline', () => {
  it('builds a window, clears it on time gaps and keeps dt null across the gap', () => {
    const p = new SignalPipeline({ max_gap_ms: 300 });
    for (let i = 0; i < 10; i++) p.process(syntheticPoseFrame(i, i * 33));
    expect(p.window.size).toBe(10);
    const r = p.process(syntheticPoseFrame(10, 10 * 33 + 2000));
    expect(r.time_gap).toBe(true);
    expect(r.frame?.dt_ms).toBeNull();
    expect(p.window.size).toBe(1);
  });

  it('drops regressions and duplicates with structured errors', () => {
    const p = new SignalPipeline();
    p.process(syntheticPoseFrame(5, 500));
    const r = p.process(syntheticPoseFrame(4, 400));
    expect(r.dropped).toBe(true);
    expect(r.error?.code).toBe('TIMESTAMP_REGRESSION');
  });

  it('rejects implausible jumps and marks the sample predicted', () => {
    const p = new SignalPipeline({ outlier_max_speed: 5 });
    for (let i = 0; i < 5; i++) p.process(syntheticPoseFrame(i, i * 33));
    const jump = syntheticPoseFrame(5, 5 * 33);
    const wrist = jump.normalized_landmarks[LANDMARK_INDEX['left_wrist']];
    wrist.x = Math.min(0.99, wrist.x + 0.45);
    const r = p.process(jump);
    const w = r.frame!.body[LANDMARK_INDEX['left_wrist']];
    expect(w.predicted).toBe(true);
    expect(w.reason).toBe('PREDICTED_SAMPLE');
    expect(w.confidence).toBeLessThanOrEqual(0.4);
  });

  it('resets history when the tracked subject changes', () => {
    const p = new SignalPipeline();
    for (let i = 0; i < 5; i++) p.process(syntheticPoseFrame(i, i * 33, {}, { tracked_subject_id: 'a' }));
    const r = p.process(syntheticPoseFrame(5, 5 * 33, {}, { tracked_subject_id: 'b' }));
    expect(r.track_changed).toBe(true);
    expect(p.window.size).toBe(1);
  });

  it('resamples with explicit masks and padding', () => {
    const p = new SignalPipeline({ window_ms: 2000 });
    for (let i = 0; i < 30; i++) p.process(syntheticPoseFrame(i, i * 33));
    const rs = p.window.resample(15, 1000, 100);
    expect(rs.timestamps_ms).toHaveLength(15);
    expect(rs.padded.some((x) => x)).toBe(false);
    expect(rs.mask[0]).toHaveLength(33);
  });
});
