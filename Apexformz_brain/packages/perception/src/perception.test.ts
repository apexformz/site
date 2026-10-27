import { describe, expect, it } from 'vitest';
import { LANDMARK_INDEX, validate } from '@apexformz/contracts';
import { syntheticPoseFrame } from '@apexformz/signal';
import { fromLegacyKeypoints, fromPoseLandmarkerResult } from './adapters';
import { SubjectTracker, candidateFromLandmarks } from './subject_tracker';
import { checkFraming, gatePoseQuality } from './framing';
import type { FrameMeta } from './types';

const meta: FrameMeta = {
  session_id: 's', frame_id: 1, timestamp_ms: 33, camera_id: 'c', image_size: [1280, 720],
  mirror: true, orientation: 'landscape', provenance: { model_id: 'mp', version: 'x' },
};

function person(offsetX: number, scale = 0.38) {
  return syntheticPoseFrame(0, 0, { offset_x: offsetX, scale }).normalized_landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z ?? 0, visibility: l.visibility, presence: l.presence }));
}

describe('perception adapters', () => {
  it('converts a landmarker result into a schema-valid PoseFrame', () => {
    const frame = fromPoseLandmarkerResult({ landmarks: [person(0)] }, meta);
    expect(validate('poseFrame', frame).ok).toBe(true);
    expect(frame.quality.person_count).toBe(1);
    expect(frame.quality.ambiguous_people).toBe(false);
    expect(frame.quality.framing_ok).toBe(true);
    expect(frame.mirror).toBe(true);
  });

  it('flags ambiguity when a second comparable person enters', () => {
    const tracker = new SubjectTracker();
    const a = fromPoseLandmarkerResult({ landmarks: [person(0)] }, meta, { tracker });
    expect(a.quality.ambiguous_people).toBe(false);
    const b = fromPoseLandmarkerResult({ landmarks: [person(0), person(0.08)] }, { ...meta, frame_id: 2 }, { tracker });
    expect(b.quality.ambiguous_people).toBe(true);
    expect(gatePoseQuality(b).reasons).toContain('AMBIGUOUS_SUBJECT');
  });

  it('keeps identity for a distant smaller bystander', () => {
    const tracker = new SubjectTracker();
    fromPoseLandmarkerResult({ landmarks: [person(0)] }, meta, { tracker });
    const b = fromPoseLandmarkerResult({ landmarks: [person(0), person(0.4, 0.15)] }, { ...meta, frame_id: 2 }, { tracker });
    expect(b.quality.ambiguous_people).toBe(false);
    expect(b.tracked_subject_id).toBe('track-1');
  });

  it('reports an empty frame when nobody is detected', () => {
    const frame = fromPoseLandmarkerResult({ landmarks: [] }, meta);
    expect(frame.normalized_landmarks).toHaveLength(0);
    expect(frame.quality.framing_ok).toBe(false);
    expect(frame.quality.missing_joints.length).toBe(33);
  });

  it('adapts legacy pixel keypoints', () => {
    const kps = syntheticPoseFrame(0, 0).normalized_landmarks.map((l, i) => ({
      x: l.x * 1280, y: l.y * 720, z: (l.z ?? 0) * 1280, score: l.visibility ?? 1, name: ['nose'][0] && i === 0 ? 'nose' : `p${i}`,
    }));
    // Use real names for the landmarks we care about
    const names = Object.entries(LANDMARK_INDEX);
    for (const [name, id] of names) kps[id].name = name;
    const frame = fromLegacyKeypoints(kps, meta);
    expect(validate('poseFrame', frame).ok).toBe(true);
    expect(frame.normalized_landmarks[LANDMARK_INDEX['left_knee']].x).toBeCloseTo(syntheticPoseFrame(0, 0).normalized_landmarks[LANDMARK_INDEX['left_knee']].x, 6);
  });

  it('framing fails for a missing ankle', () => {
    const f = syntheticPoseFrame(0, 0, { visibility_overrides: { left_ankle: 0.2 } });
    const r = checkFraming(f.normalized_landmarks);
    expect(r.framing_ok).toBe(false);
    expect(r.missing_joints).toContain(LANDMARK_INDEX['left_ankle']);
    const c = candidateFromLandmarks(f.normalized_landmarks);
    expect(c.bbox.area).toBeGreaterThan(0);
  });
});

/**
 * TRD 02 capture edge cases: athlete entering/leaving the frame, portrait/landscape transition,
 * low light (low visibility everywhere), the raised racket arm, and a rotated camera. Each must
 * surface a typed quality flag or keep the frame valid; none may invent landmarks.
 */
describe('perception edge cases (TRD 02)', () => {
  it('athlete leaving and re-entering the frame: empty frames carry no landmarks and identity is either kept or flagged', () => {
    const tracker = new SubjectTracker();
    const a = fromPoseLandmarkerResult({ landmarks: [person(0)] }, meta, { tracker });
    const gone1 = fromPoseLandmarkerResult({ landmarks: [] }, { ...meta, frame_id: 2, timestamp_ms: 66 }, { tracker });
    const gone2 = fromPoseLandmarkerResult({ landmarks: [] }, { ...meta, frame_id: 3, timestamp_ms: 99 }, { tracker });
    expect(gone1.normalized_landmarks.every((l) => (l.visibility ?? 0) < 0.5) || gone1.normalized_landmarks.length === 0).toBe(true);
    expect(gone2.quality.framing_ok).toBe(false);
    expect(gatePoseQuality(gone2).ok).toBe(false);
    const back = fromPoseLandmarkerResult({ landmarks: [person(0.05)] }, { ...meta, frame_id: 4, timestamp_ms: 132 }, { tracker });
    expect(validate('poseFrame', back).ok).toBe(true);
    expect(back.quality.framing_ok).toBe(true);
    expect(back.tracked_subject_id === a.tracked_subject_id || back.quality.track_changed === true).toBe(true);
  });

  it('landscape to portrait transition preserves orientation metadata and image size per frame', () => {
    const land = fromPoseLandmarkerResult({ landmarks: [person(0)] }, meta);
    const port = fromPoseLandmarkerResult({ landmarks: [person(0)] }, { ...meta, frame_id: 2, orientation: 'portrait', image_size: [720, 1280] });
    expect(land.orientation).toBe('landscape');
    expect(port.orientation).toBe('portrait');
    expect(port.image_size).toEqual([720, 1280]);
    expect(validate('poseFrame', port).ok).toBe(true);
  });

  it('low light: uniformly low visibility fails framing with MISSING_JOINT and FRAMING_INVALID, no landmark is invented', () => {
    const dim = syntheticPoseFrame(0, 0, { visibility: 0.3 }).normalized_landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z ?? 0, visibility: l.visibility, presence: l.presence }));
    const frame = fromPoseLandmarkerResult({ landmarks: [dim] }, meta);
    expect(frame.quality.framing_ok).toBe(false);
    expect(frame.quality.missing_joints.length).toBeGreaterThan(0);
    const gate = gatePoseQuality(frame);
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toEqual(expect.arrayContaining(['FRAMING_INVALID', 'MISSING_JOINT']));
  });

  it('a raised racket arm keeps framing valid (wrists are not core joints) and stays schema-valid', () => {
    const raised = syntheticPoseFrame(0, 0, { right_arm_raise: 170, right_elbow_flexion: 10 }).normalized_landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z ?? 0, visibility: l.visibility, presence: l.presence }));
    const frame = fromPoseLandmarkerResult({ landmarks: [raised] }, meta);
    expect(validate('poseFrame', frame).ok).toBe(true);
    expect(frame.quality.framing_ok).toBe(true);
  });

  it('a camera rotated so the feet leave the image reports out-of-frame core joints instead of clamping them', () => {
    const shiftedFrame = syntheticPoseFrame(0, 0, { offset_y: 0.45 });
    const shifted = shiftedFrame.normalized_landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z ?? 0, visibility: l.visibility, presence: l.presence }));
    const framing = checkFraming(shiftedFrame.normalized_landmarks);
    expect(framing.framing_ok).toBe(false);
    expect(framing.out_of_frame).toEqual(expect.arrayContaining([LANDMARK_INDEX.left_ankle, LANDMARK_INDEX.right_ankle]));
    const frame = fromPoseLandmarkerResult({ landmarks: [shifted] }, meta);
    expect(frame.quality.framing_ok).toBe(false);
    // Coordinates are reported as observed (possibly > 1), never clamped into the image.
    expect(frame.normalized_landmarks[LANDMARK_INDEX.left_ankle].y).toBeGreaterThan(1);
  });
});
