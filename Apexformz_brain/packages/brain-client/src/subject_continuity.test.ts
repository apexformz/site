import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { syntheticPoseFrame } from '@apexformz/signal';
import type { MovementModelConfig } from '@apexformz/analysis';
import type { BrainTick } from '@apexformz/runtime';
import { CausalMovementDetector } from './movement_detector';
import { loadBrowserMovementModel } from './movement_model_loader';
import { PoseDetectorBridge } from './pose_landmarker';
import { OnnxPoseBackend } from './onnx_pose_backend';

const config: MovementModelConfig = {
  schema_version: '1.0.0', sport_id: 'squash', model_task: 'static_pose',
  model: { model_id: 'test', version: '1', digest: `sha256:${'0'.repeat(64)}` }, classes: ['capture', 'UNKNOWN'],
  input: { landmark_set: 'mediapipe_pose_33', window_frames: 1, hz: 15, max_hold_ms: 100, min_visibility: .5,
    frame_gate: 'identity_only', subject_continuity: 'tracker_root_v1', normalization: 'body_relative_v1', smoothing: 'none' },
  calibration: { temperature: 1, margin: .1, thresholds: { capture: .7 }, status: 'validated' },
};
interface Row { t: number; dx: number; track?: string; camera?: string; ambiguous?: boolean; changed?: boolean }
const cases = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/subject_continuity_cases.json'), 'utf8')) as Array<{ name: string; rows: Row[]; valid: boolean[] }>;

describe('shared Python/browser safe subject continuity cases', () => {
  it('validates ROI at the actual MediaPipe camera bridge boundary', () => {
    expect(() => new PoseDetectorBridge({ wasm_base_url: '/wasm', model_asset_path: '/pose.task',
      subject_roi: { x0: .8, y0: 0, x1: .2, y1: 1 } })).toThrow(/subject_roi/);
  });
  it('validates ROI at the actual ONNX camera backend boundary', () => {
    expect(() => new OnnxPoseBackend({ model_url: '/pose.onnx', model_kind: 'rtmo', input_size: [640, 640], keypoint_set: 'coco_17',
      subject_roi: { x0: -.1, y0: 0, x1: 1, y1: 1 } })).toThrow(/subject_roi/);
  });
  it.each(cases)('$name', async (fixture) => {
    const predict = vi.fn(async () => ({ probabilities: { capture: .9 }, unknown_probability: .1, model: config.model }));
    const detector = new CausalMovementDetector(config, { predictAsync: predict }, { inference_interval_ms: 0 });
    detector.startSession('s', 'squash', 'squash.selected');
    const valid = [];
    for (const [index, row] of fixture.rows.entries()) {
      const frame = syntheticPoseFrame(index, row.t, {}, { session_id: 's' });
      frame.camera_id = row.camera ?? 'c'; frame.tracked_subject_id = row.track ?? 'athlete';
      frame.normalized_landmarks = Array.from({ length: 33 }, (_, id) => ({ id, x: .5 + row.dx, y: .5, z: 0, visibility: .95 }));
      for (const [id, x, y] of [[11, .45, .35], [12, .55, .35], [23, .47, .55], [24, .53, .55]]) Object.assign(frame.normalized_landmarks[id], { x: x + row.dx, y });
      frame.quality = { framing_ok: true, ambiguous_people: row.ambiguous ?? false, track_changed: row.changed ?? false, missing_joints: [] };
      const tick = { frame_id: index, session_state: 'ACTIVE', executed_pack: { id: 'squash' }, quality: { ok: true, reasons: [] }, signal: { dropped: false, time_gap: false, track_changed: false, normalization_valid: true } } as unknown as BrainTick;
      const result = await detector.observe(frame, tick);
      valid.push(result?.capture_label === 'capture');
      if (row.ambiguous || row.changed) expect(result?.probabilities).toEqual({});
    }
    expect(valid).toEqual(fixture.valid);
    expect(predict).toHaveBeenCalledTimes(fixture.valid.filter(Boolean).length);
  });

  it('rejects geometric training before fetching even with provisional opt-in', async () => {
    const fetch = vi.fn(); const createSession = vi.fn();
    await expect(loadBrowserMovementModel({ config: { ...config, input: { ...config.input, subject_continuity: 'geometric' } }, model_url: '/model.onnx', allow_provisional: true }, { fetch, createSession })).rejects.toThrow(/incompatible with live/);
    expect(fetch).not.toHaveBeenCalled(); expect(createSession).not.toHaveBeenCalled();
  });
  it('does not assume that old world/identity-only artifacts used safe tracking', async () => {
    const fetch = vi.fn(); const createSession = vi.fn();
    await expect(loadBrowserMovementModel({ config: { ...config, input: { ...config.input, subject_continuity: undefined, normalization: 'world_bodyframe_v1' } }, model_url: '/model.onnx', allow_provisional: true }, { fetch, createSession })).rejects.toThrow(/explicit subject continuity/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
