import { describe, expect, it } from 'vitest';
import type { MovementDetection } from '@apexformz/brain-client';
import { modelsForMovement, presentGuidedRecognition, presentRecognition, recognitionModeFromParam } from './recognition';
import type { MovementModelConfig } from '@apexformz/brain-client';

const detection: MovementDetection = {
  schema_version: '1.0.0', session_id: 'test', frame_id: 1, timestamp_ms: 100, sport_id: 'squash', model_task: 'dynamic_movement',
  capture_label: null, movement_id: null, selected_coaching_movement_id: 'squash.backhand', unknown: true, reason: 'BELOW_THRESHOLD',
  probability: 0.5, probabilities: {}, unknown_probability: 0.05, observed_fraction: 1, calibration_status: 'provisional',
  model: { model_id: 'test', version: '1' }, level: 'group', group_id: 'forehand', group_name: 'Forehand drives', group_probability: 0.85,
  family_id: 'strokes', family_name: 'Forehand strokes', family_probability: 0.9,
  closest_match: { capture_label: 'drive', capture_name: 'Forehand straight drive', movement_id: 'squash.drive', probability: 0.5 },
};

describe('specific-to-broad recognition presentation', () => {
  it('always prefers a supported exact name over a nearest suggestion', () => {
    expect(presentRecognition({ ...detection, unknown: false, capture_label: 'volley', capture_name: 'Forehand volley', level: 'movement', probability: 0.92 }, 'preview'))
      .toMatchObject({ title: 'Forehand volley', kind: 'exact', probability: 0.92 });
  });
  it('shows a closest catalogue match explicitly as approximate and preserves the selected drill', () => {
    expect(presentRecognition(detection, 'preview')).toMatchObject({ title: 'Forehand straight drive', label: 'Closest match', kind: 'closest', probability: 0.5 });
    expect(detection.unknown).toBe(true);
    expect(detection.movement_id).toBeNull();
    expect(detection.selected_coaching_movement_id).toBe('squash.backhand');
  });
  it('uses the supported group then family when no specific suggestion separates', () => {
    expect(presentRecognition({ ...detection, closest_match: null }, 'preview')).toMatchObject({ title: 'Forehand drives', kind: 'group', probability: 0.85 });
    expect(presentRecognition({ ...detection, closest_match: null, level: 'family' }, 'preview')).toMatchObject({ title: 'Forehand strokes', kind: 'family', probability: 0.9 });
  });
  it('withholds all names without valid pose/model evidence and in validated-only mode', () => {
    for (const reason of ['POSE_QUALITY', 'INSUFFICIENT_HISTORY', 'MODEL_UNAVAILABLE'] as const) {
      expect(presentRecognition({ ...detection, reason }, 'preview')).toMatchObject({ kind: 'waiting', path: [], probability: null });
    }
    expect(presentRecognition(detection, 'validated')).toMatchObject({ title: 'Awaiting validation', kind: 'waiting', path: [] });
    expect(presentRecognition({ ...detection, level: null, closest_match: null, reason: 'UNKNOWN_CLASS' }, 'preview')).toMatchObject({ title: 'Movement unclear', kind: 'waiting' });
  });
  it('supports observation preview independently of coaching mode', () => {
    expect(recognitionModeFromParam(null)).toBe('preview');
    expect(recognitionModeFromParam('validated')).toBe('validated');
  });
});

describe('selected-drill coaching recognition', () => {
  const target = { id: 'squash.backhand', type: 'dynamic' as const };
  it('runs only the selected static or dynamic classifier', () => {
    const models = [
      { model_task: 'static_pose', input: { window_frames: 1 } },
      { model_task: 'dynamic_movement', input: { window_frames: 30 } },
    ] as MovementModelConfig[];
    expect(modelsForMovement(models, { type: 'static' })).toEqual([models[0]]);
    expect(modelsForMovement(models, target)).toEqual([models[1]]);
    const loaders = models.map(config => ({ config, model_url: 'local.onnx', allow_provisional: true }));
    expect(modelsForMovement(loaders, { type: 'static' })).toEqual([loaders[0]]);
    expect(modelsForMovement(loaders, target)).toEqual([loaders[1]]);
  });
  it('does not turn a competing closest stance into the selected target or a correctness verdict', () => {
    const result = presentGuidedRecognition(detection, target, 'preview');
    expect(result.state).toBe('uncertain');
    expect(JSON.stringify(result)).not.toContain('Forehand');
    expect(result.detail).toContain('target stays fixed');
  });
  it('distinguishes target identity support from correct execution', () => {
    const result = presentGuidedRecognition({ ...detection, unknown: false, reason: null, movement_id: target.id }, target, 'preview');
    expect(result).toMatchObject({ state: 'supported', label: 'Target pattern suggested' });
    expect(result.detail).toContain('identity only');
  });
  it('withholds old-session, wrong-task and insufficient-history detections', () => {
    expect(presentGuidedRecognition({ ...detection, selected_coaching_movement_id: 'old' }, target, 'preview').state).toBe('waiting');
    expect(presentGuidedRecognition({ ...detection, model_task: 'static_pose' }, target, 'preview').state).toBe('waiting');
    expect(presentGuidedRecognition({ ...detection, reason: 'INSUFFICIENT_HISTORY' }, target, 'preview').state).toBe('waiting');
    expect(presentGuidedRecognition(detection, target, 'validated').state).toBe('waiting');
  });
});
