import { describe, expect, it, vi } from 'vitest';
import { syntheticPoseFrame } from '@apexformz/signal';
import { MIRROR_PAIRS, type PoseFrame } from '@apexformz/contracts';
import type { BrainTick } from '@apexformz/runtime';
import { buildMovementHierarchy, seriesToTensor, validateMovementModelConfig, type MovementModelConfig, type RecognizerOutput } from '@apexformz/analysis';
import type { ResampledSeries } from '@apexformz/signal';
import { CausalMovementDetector, movementSample, recognitionHierarchy, type AsyncMovementPredictor } from './movement_detector';
import { loadBrowserMovementModel } from './movement_model_loader';

const config: MovementModelConfig = {
  schema_version: '1.0.0', sport_id: 'squash', model_task: 'dynamic_movement',
  model: { model_id: 'test', version: '1', digest: `sha256:${'0'.repeat(64)}` },
  classes: ['exact capture name', 'UNKNOWN'],
  input: { landmark_set: 'mediapipe_pose_33', window_frames: 3, hz: 10, max_hold_ms: 100, min_visibility: 0.5, normalization: 'body_relative_v1', smoothing: 'none' },
  calibration: { temperature: 1, margin: 0.1, thresholds: { 'exact capture name': 0.7 }, status: 'validated' },
};
const output: RecognizerOutput = { probabilities: { 'exact capture name': 0.9 }, unknown_probability: 0.1, model: config.model };
const frame = (i: number) => syntheticPoseFrame(i, i * 100, {}, { session_id: 's' });
function tick(f: PoseFrame): BrainTick {
  return { tick_id: f.frame_id, frame_id: f.frame_id, timestamp_ms: f.timestamp_ms, quality: { ok: true, reasons: [] }, signal: { dropped: false, time_gap: false, track_changed: false, normalization_valid: true, mirror_applied: false }, session_state: 'ACTIVE', executed_pack: { id: 'squash', version: '1' }, features: [], temporal: null, repetition: null, assessment: null, feedback: null, suppressed_reason: null, telemetry: null };
}
function detector(predictAsync: AsyncMovementPredictor['predictAsync'] = vi.fn(async () => output), c = config) {
  const d = new CausalMovementDetector(c, { predictAsync });
  d.startSession('s', 'squash', 'squash.lunge');
  return d;
}

describe('causal learned movement detection', () => {
  it('waits for real history and reports the exact source label without changing selected coaching movement', async () => {
    const predict = vi.fn(async () => output);
    const d = detector(predict);
    expect(await d.observe(frame(0), tick(frame(0)))).toMatchObject({ reason: 'INSUFFICIENT_HISTORY' });
    await d.observe(frame(1), tick(frame(1)));
    const result = await d.observe(frame(2), tick(frame(2)));
    expect(result).toMatchObject({ capture_label: 'exact capture name', movement_id: null, selected_coaching_movement_id: 'squash.lunge', unknown: false });
    const observed = predict.mock.calls[0] as unknown[];
    expect(observed[0]).toMatchObject({ timestamps_ms: [0, 100, 200], padded: [false, false, false] });
  });

  it('handles a static photograph as one frame, without manufacturing a temporal sequence', async () => {
    const predict = vi.fn(async () => output);
    const d = detector(predict, { ...config, model_task: 'static_pose', input: { ...config.input, window_frames: 1 } });
    expect(await d.observe(frame(0), tick(frame(0)))).toMatchObject({ model_task: 'static_pose', capture_label: 'exact capture name' });
    expect((predict.mock.calls[0] as unknown[])[0]).toMatchObject({ timestamps_ms: [0] });
  });

  it('never runs another sport model or enables provisional detection by default', async () => {
    const predict = vi.fn(async () => output);
    const d = detector(predict);
    d.startSession('s', 'badminton', 'badminton.lunge');
    expect(await d.observe(frame(0), tick(frame(0)))).toMatchObject({ reason: 'SPORT_MISMATCH' });
    const provisional = detector(predict, { ...config, calibration: { ...config.calibration, status: 'provisional' } });
    expect(await provisional.observe(frame(0), tick(frame(0)))).toMatchObject({ reason: 'CALIBRATION_UNVALIDATED' });
    expect(predict).not.toHaveBeenCalled();
  });

  it('invalidates in-flight results on quality loss and never queues concurrent inference', async () => {
    let resolve!: (value: RecognizerOutput) => void;
    const predict = vi.fn(() => new Promise<RecognizerOutput>((r) => { resolve = r; }));
    const d = detector(predict);
    await d.observe(frame(0), tick(frame(0))); await d.observe(frame(1), tick(frame(1)));
    const pending = d.observe(frame(2), tick(frame(2)));
    expect(await d.observe(frame(3), tick(frame(3)))).toBeNull();
    expect(predict).toHaveBeenCalledTimes(1);
    expect(await d.observe(frame(4), { ...tick(frame(4)), quality: { ok: false, reasons: ['AMBIGUOUS_SUBJECT'] } })).toMatchObject({ unknown: true, reason: 'POSE_QUALITY' });
    resolve(output);
    expect(await pending).toBeNull();
    expect(await d.observe(frame(5), tick(frame(5)))).toMatchObject({ reason: 'INSUFFICIENT_HISTORY' });
  });

  it('does not reuse history after a pause/reset, time gap, camera change or session replacement', async () => {
    for (const change of ['reset', 'gap', 'camera', 'session']) {
      const d = detector();
      await d.observe(frame(0), tick(frame(0))); await d.observe(frame(1), tick(frame(1)));
      const f = frame(2); const t = tick(f);
      if (change === 'reset') d.reset();
      if (change === 'gap') t.signal.time_gap = true;
      if (change === 'camera') f.camera_id = 'other';
      if (change === 'session') { d.startSession('s2', 'squash', 'squash.forehand_drive'); f.session_id = 's2'; }
      expect(await d.observe(f, t)).toMatchObject({ reason: 'INSUFFICIENT_HISTORY' });
    }
  });

  it('abstains on sparse pose evidence even when the root can be normalized', async () => {
    const predict = vi.fn(async () => output);
    const d = detector(predict, { ...config, model_task: 'static_pose', input: { ...config.input, window_frames: 1 } });
    const f = frame(0);
    f.normalized_landmarks = f.normalized_landmarks.filter((p) => [11, 12, 23, 24].includes(p.id));
    expect(await d.observe(f, tick(f))).toMatchObject({ reason: 'POSE_QUALITY' });
    expect(predict).not.toHaveBeenCalled();
  });

  it('uses explicit reviewed mapping only and applies the unknown threshold', async () => {
    const single = { ...config, model_task: 'static_pose' as const, input: { ...config.input, window_frames: 1 }, movement_ids: { 'exact capture name': 'squash.forehand_drive' } };
    expect(await detector(undefined, single).observe(frame(0), tick(frame(0)))).toMatchObject({ movement_id: 'squash.forehand_drive', selected_coaching_movement_id: 'squash.lunge' });
    const low = detector(vi.fn(async () => ({ ...output, probabilities: { 'exact capture name': 0.6 }, unknown_probability: 0.4 })), single);
    expect(await low.observe(frame(0), tick(frame(0)))).toMatchObject({ capture_label: null, movement_id: null, reason: 'BELOW_THRESHOLD' });
  });

  it('keeps threshold-one classes withheld even when a development prediction saturates at one', async () => {
    const provisional: MovementModelConfig = { ...config, model_task: 'static_pose', input: { ...config.input, window_frames: 1 }, calibration: { ...config.calibration, status: 'provisional', thresholds: { 'exact capture name': 1 } } };
    const d = new CausalMovementDetector(provisional, { predictAsync: async () => ({ ...output, probabilities: { 'exact capture name': 1 }, unknown_probability: 0 }) }, { allow_provisional: true });
    d.startSession('s', 'squash', 'squash.lunge');
    expect(await d.observe(frame(0), tick(frame(0)))).toMatchObject({ capture_label: null, movement_id: null, unknown: true, reason: 'BELOW_THRESHOLD', probabilities: { 'exact capture name': 1 } });
  });

  it('retains a transient bad frame as zero input/mask without inferring on that frame', async () => {
    for (const qualityFailure of ['framing', 'missing', 'normalization']) {
      const predict = vi.fn(async (_series: ResampledSeries) => output);
      const d = detector(predict);
      await d.observe(frame(0), tick(frame(0)));
      const bad = frame(1); const badTick = tick(bad);
      if (qualityFailure === 'framing') bad.quality.framing_ok = false;
      if (qualityFailure === 'missing') bad.quality.missing_joints = [15];
      if (qualityFailure === 'normalization') badTick.signal.normalization_valid = false;
      expect(await d.observe(bad, badTick)).toMatchObject({ reason: 'POSE_QUALITY', probabilities: {}, capture_label: null });
      expect(predict).not.toHaveBeenCalled();
      expect(await d.observe(frame(2), tick(frame(2)))).toMatchObject({ capture_label: 'exact capture name', observed_fraction: 2 / 3 });
      const series = predict.mock.calls[0][0];
      expect(series.timestamps_ms).toEqual([0, 100, 200]);
      expect(series.mask[1]).toEqual(Array(33).fill(false));
      expect(series.padded).toEqual([false, true, false]);
      const tensors = seriesToTensor(series);
      expect([...tensors.input.data.slice(99, 198)]).toEqual(Array(99).fill(0));
      expect([...tensors.mask.data.slice(33, 66)]).toEqual(Array(33).fill(0));
    }
  });

  it('uses deployment coverage including masked frames and retains the default for older configs', async () => {
    for (const minimum of [undefined, 0.8]) {
      const predict = vi.fn(async () => output);
      const d = detector(predict, { ...config, input: { ...config.input, min_observed_fraction: minimum } });
      await d.observe(frame(0), tick(frame(0)));
      const bad = frame(1); bad.quality.framing_ok = false;
      await d.observe(bad, tick(bad));
      const result = await d.observe(frame(2), tick(frame(2)));
      expect(result).toMatchObject({ observed_fraction: 2 / 3, unknown: minimum !== undefined });
      expect(predict).toHaveBeenCalledTimes(minimum === undefined ? 1 : 0);
    }
  });

  it('invalidates an in-flight prediction on a transient bad frame while preserving masked history', async () => {
    let resolve!: (value: RecognizerOutput) => void;
    const predict = vi.fn(() => new Promise<RecognizerOutput>((r) => { resolve = r; }));
    const d = detector(predict);
    await d.observe(frame(0), tick(frame(0))); await d.observe(frame(1), tick(frame(1)));
    const pending = d.observe(frame(2), tick(frame(2)));
    const bad = frame(3); bad.quality.missing_joints = [15];
    expect(await d.observe(bad, tick(bad))).toMatchObject({ reason: 'POSE_QUALITY', capture_label: null });
    resolve(output);
    expect(await pending).toBeNull();
    predict.mockResolvedValue(output);
    expect(await d.observe(frame(4), tick(frame(4)))).toMatchObject({ capture_label: 'exact capture name', observed_fraction: 2 / 3 });
  });

  it('hard-resets temporal history for raw identity ambiguity even if a tick omits its quality reason', async () => {
    const predict = vi.fn(async () => output); const d = detector(predict);
    await d.observe(frame(0), tick(frame(0))); await d.observe(frame(1), tick(frame(1)));
    const ambiguous = frame(2); ambiguous.quality.ambiguous_people = true;
    expect(await d.observe(ambiguous, tick(ambiguous))).toMatchObject({ reason: 'POSE_QUALITY' });
    expect(await d.observe(frame(3), tick(frame(3)))).toMatchObject({ reason: 'INSUFFICIENT_HISTORY' });
    expect(predict).not.toHaveBeenCalled();
  });
});

describe('movement normalization / artifact validation', () => {
  it('uses torso units with no smoothing and reverses a mirror exactly once', () => {
    const f = frame(0);
    const sample = movementSample(f, 0.5)!;
    expect(sample.values[11]!.x).toBeCloseTo(0.4);
    expect(sample.values[11]!.y).toBeCloseTo(-1);
    const mirrored = structuredClone(f);
    mirrored.mirror = true;
    for (const p of mirrored.normalized_landmarks) p.x = 1 - p.x;
    for (const [l, r] of MIRROR_PAIRS) {
      const left = { ...mirrored.normalized_landmarks[l], id: r };
      mirrored.normalized_landmarks[l] = { ...mirrored.normalized_landmarks[r], id: l };
      mirrored.normalized_landmarks[r] = left;
    }
    const canonical = movementSample(mirrored, 0.5)!;
    for (let i = 0; i < 33; i++) expect(canonical.values[i]!.x).toBeCloseTo(sample.values[i]!.x);
  });

  it('rejects class order and preprocessing mismatches', () => {
    expect(() => validateMovementModelConfig({ ...config, classes: ['UNKNOWN', 'capture'] })).toThrow(/classes/);
    expect(() => validateMovementModelConfig({ ...config, input: { ...config.input, smoothing: 'one_euro' } })).toThrow(/normalization/);
    expect(() => validateMovementModelConfig({ ...config, calibration: { ...config.calibration, thresholds: {} } })).toThrow(/threshold/);
    for (const min_observed_fraction of [-0.1, 1.1, NaN, null, '0.6']) expect(() => validateMovementModelConfig({ ...config, input: { ...config.input, min_observed_fraction } })).toThrow(/observed fraction/);
  });

  it('verifies artifact digest before creating an ONNX session', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const createSession = vi.fn(async () => ({ run: vi.fn(), release: vi.fn() }));
    const fetcher = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    await expect(loadBrowserMovementModel({ config, model_url: '/model.onnx' }, { fetch: fetcher, createSession })).rejects.toThrow(/digest mismatch/);
    expect(createSession).not.toHaveBeenCalled();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
    const loaded = await loadBrowserMovementModel({ config: { ...config, model: { ...config.model, digest: `sha256:${digest}` } }, model_url: '/model.onnx' }, { fetch: fetcher, createSession });
    expect(createSession).toHaveBeenCalledTimes(1);
    await loaded.close();
  });

  it('reports the family or group when near-identical movements split the probability (pack taxonomy)', async () => {
    const hConfig: MovementModelConfig = {
      ...config,
      classes: ['squash.dynamic.0031', 'squash.dynamic.0030', 'squash.dynamic.0041', 'UNKNOWN'],
      calibration: { temperature: 1, margin: 0.1, thresholds: { 'squash.dynamic.0031': 0.7, 'squash.dynamic.0030': 0.7, 'squash.dynamic.0041': 0.7 }, status: 'validated' },
    };
    const hierarchy = buildMovementHierarchy({
      version: '1.0.0', levels: ['family', 'group', 'movement'], validation_status: 'provisional',
      families: [
        { id: 'squash.family.fh', name: 'Forehand strokes', type: 'dynamic', groups: [{ id: 'squash.group.fh.drives', name: 'Forehand drive and similar', members: ['squash.dynamic.0031', 'squash.dynamic.0030'] }] },
        { id: 'squash.family.bh', name: 'Backhand strokes', type: 'dynamic', groups: [{ id: 'squash.group.bh.drives', name: 'Backhand drive and similar', members: ['squash.dynamic.0041'] }] },
      ],
    });
    const split: RecognizerOutput = { probabilities: { 'squash.dynamic.0031': 0.46, 'squash.dynamic.0030': 0.44, 'squash.dynamic.0041': 0.05 }, unknown_probability: 0.05, model: config.model };
    const d = new CausalMovementDetector(hConfig, { predictAsync: vi.fn(async () => split) }, { allow_provisional: true });
    d.startSession('s', 'squash', 'squash.dynamic.0031', hierarchy);
    await d.observe(frame(0), tick(frame(0)));
    await d.observe(frame(1), tick(frame(1)));
    const result = await d.observe(frame(2), tick(frame(2)));
    expect(result).toMatchObject({ unknown: true, capture_label: null, level: 'group', group_id: 'squash.group.fh.drives', group_name: 'Forehand drive and similar', family_id: 'squash.family.fh', family_name: 'Forehand strokes', calibration_status: 'provisional' });
    expect(result!.group_probability).toBeCloseTo(0.9, 9);
    // Without a pack taxonomy the same output stays a plain fine-level abstention.
    const plain = new CausalMovementDetector(hConfig, { predictAsync: vi.fn(async () => split) });
    plain.startSession('s', 'squash', 'squash.dynamic.0031');
    await plain.observe(frame(0), tick(frame(0)));
    await plain.observe(frame(1), tick(frame(1)));
    const r2 = await plain.observe(frame(2), tick(frame(2)));
    expect(r2).toMatchObject({ unknown: true, reason: 'BELOW_THRESHOLD' });
    expect(r2!.level).toBeUndefined();

    // Model calibration never authorizes an unreviewed taxonomy; disabled taxonomy stays off in dev too.
    for (const [status, allow, expected] of [
      ['approved', false, 'group'], ['provisional', false, undefined], ['disabled', true, undefined],
    ] as const) {
      const gated = new CausalMovementDetector(hConfig, { predictAsync: async () => split }, { allow_provisional: allow });
      gated.startSession('s', 'squash', 'squash.dynamic.0031', { ...hierarchy!, validation_status: status });
      await gated.observe(frame(0), tick(frame(0)));
      await gated.observe(frame(1), tick(frame(1)));
      expect((await gated.observe(frame(2), tick(frame(2))))!.level).toBe(expected);
    }
    const fineOutput = { ...split, probabilities: { 'squash.dynamic.0031': 0.95, 'squash.dynamic.0030': 0, 'squash.dynamic.0041': 0 } };
    const fineOnly = new CausalMovementDetector(hConfig, { predictAsync: async () => fineOutput });
    fineOnly.startSession('s', 'squash', 'squash.dynamic.0041', hierarchy);
    await fineOnly.observe(frame(0), tick(frame(0))); await fineOnly.observe(frame(1), tick(frame(1)));
    expect(await fineOnly.observe(frame(2), tick(frame(2)))).toMatchObject({ capture_label: 'squash.dynamic.0031', movement_id: 'squash.dynamic.0031', selected_coaching_movement_id: 'squash.dynamic.0041', calibration_status: 'validated' });
  });

  it('requires both taxonomy and group/family gates to be approved for strict recognition', () => {
    const families = [{ id: 'family', name: 'Family', type: 'dynamic' as const, groups: [{ id: 'group', name: 'Group', members: ['squash.dynamic.0031'] }] }];
    for (const [taxonomy, gates, expected] of [
      ['approved', 'approved', 'approved'], ['approved', 'provisional', 'provisional'],
      ['provisional', 'approved', 'provisional'], ['approved', undefined, 'provisional'],
      ['approved', 'disabled', 'disabled'], ['disabled', 'approved', 'disabled'],
    ] as const) {
      expect(recognitionHierarchy({ version: '1', levels: ['family', 'group', 'movement'], validation_status: taxonomy, recognition: gates ? { validation_status: gates } : undefined, families })?.validation_status).toBe(expected);
    }
  });

  it('carries a named closest match without accepting its exact class, and clears it on lost identity', async () => {
    const label = 'capture-fh-drive-001', alternate = 'capture-fh-drive-002';
    const movement = 'squash.forehand_straight_drive';
    const hConfig: MovementModelConfig = {
      ...config, classes: [label, alternate, 'UNKNOWN'],
      class_names: { [label]: 'Forehand straight drive', [alternate]: 'Forehand crosscourt drive' },
      movement_ids: { [label]: movement, [alternate]: 'squash.forehand_crosscourt_drive' },
      calibration: { temperature: 1, margin: 0.1, thresholds: { [label]: 1, [alternate]: 1 }, status: 'provisional' },
    };
    const hierarchy = buildMovementHierarchy({
      version: '1', levels: ['family', 'group', 'movement'], validation_status: 'provisional',
      families: [{ id: 'squash.family.forehand', name: 'Forehand strokes', type: 'dynamic', groups: [
        { id: 'squash.group.drives', name: 'Forehand drives', members: [movement, 'squash.forehand_crosscourt_drive'] },
      ] }],
    });
    const predict = vi.fn(async (): Promise<RecognizerOutput> => ({ probabilities: { [label]: 0.88, [alternate]: 0.07 }, unknown_probability: 0.05, model: config.model }));
    const preview = new CausalMovementDetector(hConfig, { predictAsync: predict }, { allow_provisional: true });
    preview.startSession('s', 'squash', 'squash.backhand_volley', hierarchy);
    await preview.observe(frame(0), tick(frame(0))); await preview.observe(frame(1), tick(frame(1)));
    const named = await preview.observe(frame(2), tick(frame(2)));
    expect(named).toMatchObject({
      capture_label: null, capture_name: null, movement_id: null, unknown: true,
      reason: 'BELOW_THRESHOLD', calibration_status: 'provisional', level: 'group',
      selected_coaching_movement_id: 'squash.backhand_volley',
      group_name: 'Forehand drives', family_name: 'Forehand strokes',
      closest_match: { capture_label: label, capture_name: 'Forehand straight drive', movement_id: movement, probability: 0.88 },
    });
    const ambiguous = frame(3); ambiguous.quality.ambiguous_people = true;
    const cleared = await preview.observe(ambiguous, tick(ambiguous));
    expect(cleared).toMatchObject({ reason: 'POSE_QUALITY', capture_label: null, movement_id: null, probabilities: {} });
    expect(cleared?.closest_match).toBeUndefined();
    expect(cleared?.level).toBeUndefined();
    const rebuilding = await preview.observe(frame(4), tick(frame(4)));
    expect(rebuilding).toMatchObject({ reason: 'INSUFFICIENT_HISTORY', capture_label: null });
    expect(rebuilding?.closest_match).toBeUndefined();
    expect(predict).toHaveBeenCalledTimes(1);

    // UI preview is opt-in at the detector boundary; its presence never changes strict client defaults.
    const validatedOnly = new CausalMovementDetector(hConfig, { predictAsync: predict });
    validatedOnly.startSession('s', 'squash', 'squash.backhand_volley', hierarchy);
    const blocked = await validatedOnly.observe(frame(0), tick(frame(0)));
    expect(blocked).toMatchObject({ reason: 'CALIBRATION_UNVALIDATED', capture_label: null, movement_id: null });
    expect(blocked?.closest_match).toBeUndefined();
    expect(predict).toHaveBeenCalledTimes(1);
  });
});

