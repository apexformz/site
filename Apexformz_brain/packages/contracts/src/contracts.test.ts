import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION, MEDIAPIPE_POSE_33, MIRROR_PAIRS, isContractCompatible, coreSatisfiesMinimum,
  satisfiesCaret, validate, assertValid, BrainError, makeEventId, LANDMARK_INDEX,
} from './index';
import type { PoseFrame } from './index';

export function samplePoseFrame(overrides: Partial<PoseFrame> = {}): PoseFrame {
  return {
    schema_version: CONTRACT_VERSION,
    session_id: 'sess-1',
    frame_id: 0,
    timestamp_ms: 0,
    camera_id: 'cam0',
    image_size: [1280, 720],
    mirror: false,
    orientation: 'landscape',
    landmark_set: 'mediapipe_pose_33',
    normalized_landmarks: MEDIAPIPE_POSE_33.map((_, id) => ({ id, x: 0.5, y: 0.5, z: 0, visibility: 0.9, presence: 0.9 })),
    quality: { framing_ok: true, ambiguous_people: false, missing_joints: [], person_count: 1 },
    provenance: { model_id: 'mediapipe_pose_landmarker', version: 'full/0.10' },
    ...overrides,
  };
}

describe('contracts', () => {
  it('exposes 33 landmarks with consistent mirror pairs', () => {
    expect(MEDIAPIPE_POSE_33).toHaveLength(33);
    for (const [l, r] of MIRROR_PAIRS) {
      expect(MEDIAPIPE_POSE_33[l].replace('left_', '').replace('mouth_left', 'mouth')).toBe(
        MEDIAPIPE_POSE_33[r].replace('right_', '').replace('mouth_right', 'mouth'),
      );
    }
    expect(LANDMARK_INDEX['left_knee']).toBe(25);
  });

  it('validates a well-formed PoseFrame and rejects a malformed one', () => {
    expect(validate('poseFrame', samplePoseFrame()).ok).toBe(true);
    const bad = samplePoseFrame({ image_size: [0, 720] as unknown as [number, number] });
    const res = validate('poseFrame', bad);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('nullable measurements require a typed reason', () => {
    const evidence = {
      criterion_id: 'x.y', movement_id: 'x.m', state: 'NOT_ASSESSABLE', score: null,
      measurement: { value: null, unit: 'deg' },
      confidence: { movement: 0.9, assessment: null },
      evidence: { frame_ids: [1], view: 'front' },
      feedback: null,
      provenance: { sport_pack: '1.0.0', rubric: '1.0.0', validation_status: 'provisional', evaluator: 'range' },
      timestamp_ms: 10,
    };
    expect(validate('criterionEvidence', evidence).ok).toBe(false);
    (evidence.measurement as { reason?: string }).reason = 'VIEW_INVALID';
    expect(validate('criterionEvidence', evidence).ok).toBe(true);
  });

  it('rejects definitive feedback on an abstaining criterion', () => {
    const evidence = {
      criterion_id: 'x.y', movement_id: 'x.m', state: 'NOT_ASSESSABLE', score: null,
      measurement: { value: null, unit: 'deg', reason: 'VIEW_INVALID' },
      confidence: { movement: 0.9, assessment: null },
      evidence: { frame_ids: [1], view: 'front' },
      feedback: { error_id: 'e', cue: 'do the thing' },
      provenance: { sport_pack: '1.0.0', rubric: '1.0.0', validation_status: 'approved', evaluator: 'range' },
      timestamp_ms: 10,
    };
    expect(validate('criterionEvidence', evidence).ok).toBe(false);
  });

  it('assertValid throws a closed BrainError', () => {
    expect(() => assertValid('poseFrame', { nope: true })).toThrowError(BrainError);
    try {
      assertValid('poseFrame', { nope: true });
    } catch (e) {
      expect((e as BrainError).code).toBe('SCHEMA_INVALID');
      expect((e as BrainError).recoverable).toBe(false);
    }
  });

  it('version compatibility is major-strict', () => {
    expect(isContractCompatible('1.0.0')).toBe(true);
    expect(isContractCompatible('1.0.9')).toBe(true);
    expect(isContractCompatible('2.0.0')).toBe(false);
    expect(coreSatisfiesMinimum('1.0.0')).toBe(true);
    expect(coreSatisfiesMinimum('1.4.0')).toBe(false);
    expect(satisfiesCaret('1.2.3', '^1.0')).toBe(true);
    expect(satisfiesCaret('2.0.0', '^1.0')).toBe(false);
  });

  it('event ids are deterministic per session sequence', () => {
    expect(makeEventId('s', 7)).toBe('s:00000007');
  });
});
