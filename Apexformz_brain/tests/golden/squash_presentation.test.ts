import { describe, expect, it } from 'vitest';
import type { AssessmentSet, FeedbackAction, MovementCatalog } from '@apexformz/contracts';
import type { BrainTick } from '@apexformz/runtime';
import type { MovementDetection, MovementModelConfig } from '@apexformz/analysis';
import { syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { CausalMovementDetector, recognitionHierarchy } from '../../packages/brain-client/src/movement_detector';
import { currentAssessment, currentDetections, currentFeedback, selectedMovement } from '../../apps/frontend/src/lib/brain/presentation';
import catalogJson from '../../sport-packs/squash/movement_catalog.json';
import { poseFrameToLegacyKeypoints } from '../../apps/frontend/src/lib/brain/poseAdapter';
import { activeSession, calibration } from '../helpers/packs';

const catalog = catalogJson as unknown as MovementCatalog;
const assessment: AssessmentSet = {
  schema_version: '1.0.0', session_id: 's', event_id: 'assessment-1', timestamp_ms: 100,
  movement_id: 'squash.dynamic.0021', execution_id: 'rep1', phase_id: 'lunge', score: 0.8,
  criteria: [], coverage: { evaluated: 0, required: 0, ratio: 0, minimum: 0.6, omitted: [] },
  method: 'weighted_mean_of_valid_criteria', weights: {}, rubric_version: '1.0.0',
  sport_pack_id: 'squash', sport_pack_version: '1.0.0', retrospective: false,
};
const tick = {
  timestamp_ms: 150, quality: { ok: true, reasons: [] },
  signal: { dropped: false, time_gap: false, track_changed: false },
  temporal: { movement_id: 'squash.dynamic.0021', execution_id: 'rep1', cue_allowed: true },
} as unknown as BrainTick;
const cue = { event_id: 'cue', timestamp_ms: 100, expires_ms: 400, kind: 'technique_cue', priority: 'primary' } as FeedbackAction;

describe('squash setup and live presentation boundaries', () => {
  it('keeps overlay coordinates aligned to the displayed video after detector downsampling', () => {
    const frame = syntheticPoseFrame(0, 0);
    frame.image_size = [320, 180];
    frame.normalized_landmarks = [{ id: 0, x: 0.5, y: 0.25, z: 0.1, visibility: 1 }];
    const keypoint = poseFrameToLegacyKeypoints(frame, [1280, 720])!.keypoints[0];
    expect(keypoint).toMatchObject({ x: 640, y: 180, z: 128, name: 'nose' });
    expect(keypoint.x / 1280).toBe(0.5);
    expect(keypoint.y / 720).toBe(0.25);
    expect(poseFrameToLegacyKeypoints(frame)!.keypoints[0]).toMatchObject({ x: 160, y: 45 });
    expect(frame.image_size).toEqual([320, 180]);
  });

  it('migrates approved legacy ids to exact capture ids and keeps proposed lookalikes unresolved', () => {
    const canonical = selectedMovement(catalog, 'squash.lunge');
    expect(canonical?.id).toBe('squash.dynamic.0021');
    expect(selectedMovement(catalog, ' SQUASH.LUNGE ')?.id).toBe(canonical?.id);
    expect(selectedMovement(catalog, canonical!.uuid)?.id).toBe(canonical?.id);
    const proposed = { ...catalog, movements: [{ ...canonical!, aliases: [{ name: 'lunge lookalike', locale: 'en', status: 'proposed' as const }] }] };
    expect(selectedMovement(proposed, 'lunge lookalike')).toBeNull();
    expect(selectedMovement(catalog, 'squash.retired_or_unknown_drill')).toBeNull();
  });

  it('hides recognition on camera stop, stream restart, expiry and session mismatch', () => {
    const d = { timestamp_ms: 100, session_id: 's' } as MovementDetection;
    const detections = { static_pose: d };
    expect(currentDetections(detections, true, 's', 400, 0)).toEqual(detections);
    expect(currentDetections(detections, false, 's', 400, 0)).toEqual({});
    expect(currentDetections(detections, true, 's', 400, 200)).toEqual({});
    expect(currentDetections(detections, true, 's', 1101, 0)).toEqual({});
    expect(currentDetections(detections, true, 'other', 400, 0)).toEqual({});
  });

  it('retains a phase assessment between ticks without leaking it across tracking or execution boundaries', () => {
    expect(currentAssessment(assessment, tick, 0)).toBe(assessment);
    expect(currentAssessment(assessment, tick, 101)).toBeNull();
    expect(currentAssessment(assessment, { ...tick, signal: { ...tick.signal, track_changed: true } }, 0)).toBeNull();
    expect(currentAssessment(assessment, { ...tick, signal: { ...tick.signal, time_gap: true } }, 0)).toBeNull();
    expect(currentAssessment(assessment, { ...tick, quality: { ok: false, reasons: ['LOW_CONFIDENCE'] } }, 0)).toBeNull();
    expect(currentAssessment(assessment, { ...tick, temporal: { ...tick.temporal!, execution_id: 'rep2' } }, 0)).toBeNull();
  });

  it('expires cues and stops technique feedback in non-cueable phases, while retaining quality instructions', () => {
    expect(currentFeedback(cue, tick, true, 200)).toBe(cue);
    expect(currentFeedback(cue, tick, true, 400)).toBeNull();
    expect(currentFeedback(cue, tick, false, 200)).toBeNull();
    const action = { ...tick, temporal: { ...tick.temporal!, cue_allowed: false } };
    expect(currentFeedback(cue, action, true, 200)).toBeNull();
    const safety = { ...cue, priority: 'safety' as const };
    expect(currentFeedback(safety, action, true, 200)).toBe(safety);
    const poor = { ...tick, quality: { ok: false, reasons: ['FRAMING_INVALID' as const] } };
    const setup = { ...cue, kind: 'setup_instruction' as const, priority: 'setup' as const };
    expect(currentFeedback(cue, poor, true, 200)).toBeNull();
    expect(currentFeedback(setup, poor, true, 200)).toBe(setup);
    expect(currentFeedback(setup, tick, true, 200)).toBeNull();
  });
});

describe('learned squash recognition alongside the selected coaching graph', () => {
  it('recognizes a different exact capture without changing selected phases, assessments or feedback movement', async () => {
    const selected = selectedMovement(catalog, 'squash.lunge')!;
    const { rt, sessionId } = await activeSession(['squash'], 'squash', selected.id,
      { strict_rubrics: false, allow_draft_feedback: true }, calibration({ nominal_view: 'front' }));
    const recognized = 'squash.dynamic.0041';
    const config: MovementModelConfig = {
      schema_version: '1.0.0', sport_id: 'squash', model_task: 'static_pose',
      model: { model_id: 'test', version: '1', digest: `sha256:${'0'.repeat(64)}` },
      classes: [recognized, 'UNKNOWN'],
      input: { landmark_set: 'mediapipe_pose_33', window_frames: 1, hz: 25, max_hold_ms: 100, min_visibility: 0.5, normalization: 'body_relative_v1', smoothing: 'none' },
      calibration: { temperature: 1, margin: 0.1, thresholds: { [recognized]: 0.7 }, status: 'validated' },
    };
    const learned = new CausalMovementDetector(config, { predictAsync: async () => ({ probabilities: { [recognized]: 0.95 }, unknown_probability: 0.05, model: config.model }) }, { allow_provisional: true, inference_interval_ms: 0 });
    learned.startSession(sessionId, 'squash', selected.id, recognitionHierarchy(catalog.taxonomy));
    const ready: SyntheticPoseOptions = { left_knee_flexion: 10, right_knee_flexion: 10, right_elbow_flexion: 90, left_elbow_flexion: 60, right_arm_raise: 40, stance_width: 0.9 };
    const ticks: BrainTick[] = [];
    const detections: MovementDetection[] = [];
    let i = 0;
    const cycle = [[10, 25], [50, 8], [135, 12], [5, 55]] as const;
    for (const [flex, count] of [...cycle, ...cycle, ...cycle]) {
      for (let k = 0; k < count; k++, i++) {
        const frame = syntheticPoseFrame(i, i * 40, { ...ready, right_knee_flexion: flex }, { session_id: sessionId });
        const result = rt.process(frame, frame.timestamp_ms);
        if (!result) continue;
        ticks.push(result);
        const detection = await learned.observe(frame, result);
        if (detection) detections.push(detection);
      }
    }
    expect(detections.some((d) => d.capture_label === recognized && d.movement_id === recognized)).toBe(true);
    expect(detections.every((d) => d.selected_coaching_movement_id === selected.id)).toBe(true);
    expect(ticks.some((t) => t.temporal?.phase_id === 'bottom')).toBe(true);
    const assessments = ticks.flatMap((t) => t.assessment ? [t.assessment] : []);
    expect(assessments.length).toBeGreaterThan(0);
    expect(assessments.every((a) => a.movement_id === selected.id)).toBe(true);
    const feedback = ticks.flatMap((t) => t.feedback ? [t.feedback] : []);
    expect(feedback.length).toBeGreaterThan(0);
    expect(feedback.every((f) => f.movement_id === selected.id)).toBe(true);
    expect(ticks.every((t) => !t.temporal || t.temporal.movement_id === selected.id)).toBe(true);
  });
});
