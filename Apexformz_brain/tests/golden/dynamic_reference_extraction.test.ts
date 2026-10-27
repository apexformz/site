import { describe, expect, it } from 'vitest';
import { syntheticPoseFrame } from '@apexformz/signal';
import type { DynamicReferenceModel, PoseFrame } from '@apexformz/contracts';
import { validateDynamicReferenceModel } from '@apexformz/contracts';
import { DYNAMIC_REFERENCE_FEATURES, DYNAMIC_REFERENCE_FEATURE_SPECS, extractDynamicCapture } from '../../tools/extract_dynamic_references';
import { hasInvertedBodyEvidence, recordedBodyOrientationIssue, rotateRecordedPose180, sourceOrientationReview } from '../../tools/dynamic_reference_orientation';

function recording(count = 90): PoseFrame[] {
  return Array.from({ length: count }, (_, i) => syntheticPoseFrame(i, i * 50, {
    right_elbow_flexion: 55 + 40 * Math.sin(i / 8),
    left_knee_flexion: 35 + 20 * Math.sin(i / 10),
    offset_x: 0.03 * Math.sin(i / 12),
  }));
}
function model(): DynamicReferenceModel {
  const s = extractDynamicCapture(recording(), 'front', 'right').segments[0];
  return {
    kind: 'dynamic_reference', schema_version: '1.0.0', movement_id: 'test.stroke', validation_status: 'provisional',
    feature_specs: DYNAMIC_REFERENCE_FEATURE_SPECS, features: DYNAMIC_REFERENCE_FEATURES, unsupported_reasons: [],
    references: [{ ...s, id: 'test-1', view: 'front', handedness: 'right', source_execution_id: 'source-1', source_pose_sha256: 'a'.repeat(64), source_media_sha256: 'b'.repeat(64), boundary_method: 'observed_motion' }],
    provenance: { dataset_sha256: 'c'.repeat(64), extraction_version: 'test', phase_labels_reviewed: false, tolerances_reviewed: false },
  };
}

describe('dynamic recorded-reference extraction', () => {
  it('canonicalizes only reviewed source rotation, preserving anatomy, handedness and source immutability', () => {
    const original = recording();
    const before = JSON.stringify(original);
    const encoded = original.map(rotateRecordedPose180);
    expect(hasInvertedBodyEvidence(encoded[0])).toBe(true);
    expect(extractDynamicCapture(encoded, 'right', 'right').segments).toEqual([]);
    const canonical = encoded.map(rotateRecordedPose180);
    expect(canonical[0].normalized_landmarks.map(lm => lm.id)).toEqual(original[0].normalized_landmarks.map(lm => lm.id));
    expect(canonical[0].mirror).toBe(original[0].mirror);
    const expected = extractDynamicCapture(original, 'right', 'right');
    const actual = extractDynamicCapture(canonical, 'right', 'right');
    expect(JSON.stringify(actual.segments)).toBe(JSON.stringify(expected.segments));
    expect(JSON.stringify(original)).toBe(before);
    const world = { ...original[0], world_landmarks: [{ id: 15, x: .3, y: -.2, z: .7, confidence: .9 }] };
    expect(rotateRecordedPose180(world).world_landmarks).toEqual([{ id: 15, x: -.3, y: .2, z: .7, confidence: .9 }]);
  });

  it('binds source rotation to both original digests, never to camera view', () => {
    const source = { stream_id: 'reviewed', source_pose_sha256: 'a'.repeat(64), source_media_sha256: 'b'.repeat(64) };
    const review = { ...source, rotation_degrees: 180 as const, review_evidence: 'visual.jpg', review_evidence_sha256: 'c'.repeat(64) };
    expect(sourceOrientationReview(source, [review])).toBe(review);
    expect(sourceOrientationReview({ ...source, stream_id: 'other-right-camera' }, [review])).toBeUndefined();
    expect(() => sourceOrientationReview({ ...source, source_pose_sha256: 'd'.repeat(64) }, [review])).toThrow('Orientation provenance mismatch');
    expect(() => sourceOrientationReview({ ...source, source_media_sha256: 'd'.repeat(64) }, [review])).toThrow('Orientation provenance mismatch');
  });

  it('breaks on an inverted observed body without turning ordinary forward bending into inversion', () => {
    const frames = recording(120);
    frames[60] = rotateRecordedPose180(frames[60]);
    const result = extractDynamicCapture(frames, 'front', 'right');
    expect(result.rejected_frames.INVERTED_BODY_GEOMETRY).toBe(1);
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
    expect(result.segments.every(s => !s.complete_capture && (s.end_ms < 3000 || s.start_ms > 3000))).toBe(true);
    const bent = structuredClone(frames[0]);
    bent.normalized_landmarks.find(lm => lm.id === 0)!.y = .8;
    bent.normalized_landmarks.find(lm => lm.id === 11)!.y = .75;
    bent.normalized_landmarks.find(lm => lm.id === 12)!.y = .75;
    for (const id of [0, 11, 12]) bent.normalized_landmarks.find(lm => lm.id === id)!.x += .3;
    expect(hasInvertedBodyEvidence(bent)).toBe(false);
    expect(recordedBodyOrientationIssue(bent)).toBeNull();
    bent.quality.missing_joints = [27, 28];
    expect(recordedBodyOrientationIssue(bent)).toBe('ORIENTATION_AMBIGUOUS');
    const swapped = rotateRecordedPose180(frames[0]);
    for (const id of [27, 28]) swapped.normalized_landmarks.find(lm => lm.id === id)!.y = .95;
    expect(recordedBodyOrientationIssue(swapped)).toBe('ORIENTATION_AMBIGUOUS');
  });

  it('requires reviewed provenance for a rotated artifact', () => {
    const artifact = model();
    artifact.references[0].recorded_source_transform = { rotation_degrees: 180, anatomical_labels_preserved: true };
    expect(() => validateDynamicReferenceModel(artifact)).toThrow('source orientation');
    artifact.references[0].recorded_source_transform.review_evidence_sha256 = 'e'.repeat(64);
    expect(() => validateDynamicReferenceModel(artifact)).not.toThrow();
  });

  it('keeps movement-specific signed trajectories, endpoint timing and immutable source frame data', () => {
    const frames = recording();
    const before = JSON.stringify(frames);
    const result = extractDynamicCapture(frames, 'front', 'right');
    expect(result.reason).toBeNull();
    expect(result.segments).toHaveLength(1);
    const s = result.segments[0];
    expect(s.complete_capture).toBe(true);
    expect(s.samples[0].t_ms).toBe(0);
    expect(s.samples.at(-1)!.t_ms).toBeCloseTo(s.duration_ms, 6);
    expect(s.samples.length).toBeLessThanOrEqual(121);
    const wristX = DYNAMIC_REFERENCE_FEATURES.findIndex(f => f.id === 'dynamic_ref_dominant_wrist_x');
    const values = s.samples.map(r => r.values[wristX]).filter((v): v is number => v !== null);
    expect(new Set(values).size).toBeGreaterThan(5);
    expect(Math.min(...values)).toBeLessThan(0);
    expect(JSON.stringify(frames)).toBe(before);
  });

  it.each(['FRAMING_INVALID', 'TRACK_CHANGED', 'AMBIGUOUS_PEOPLE', 'TIME_GAP'])('never concatenates reference geometry across %s', reason => {
    const frames = recording(120);
    const pivot = 60;
    if (reason === 'FRAMING_INVALID') frames[pivot].quality.framing_ok = false;
    if (reason === 'TRACK_CHANGED') frames[pivot].quality.track_changed = true;
    if (reason === 'AMBIGUOUS_PEOPLE') frames[pivot].quality.ambiguous_people = true;
    if (reason === 'TIME_GAP') for (let i = pivot; i < frames.length; i++) frames[i].timestamp_ms += 1000;
    const result = extractDynamicCapture(frames, 'front', 'right');
    expect(result.rejected_frames[reason]).toBeGreaterThan(0);
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
    expect(result.segments.every(s => !s.complete_capture)).toBe(true);
    const boundary = frames[pivot].timestamp_ms;
    expect(result.segments.every(s => s.end_ms < boundary || s.start_ms >= boundary)).toBe(true);
  });

  it('retains the known selected athlete even with another visible person, matching the live identity contract', () => {
    const frames = recording();
    for (const f of frames) { f.quality.person_count = 2; f.quality.ambiguous_people = false; }
    const result = extractDynamicCapture(frames, 'front', 'right');
    expect(result.segments).toHaveLength(1);
    expect(result.rejected_frames.AMBIGUOUS_PEOPLE).toBeUndefined();
  });

  it('masks an explicitly missing local joint without inventing it or breaking other observed trajectories', () => {
    const frames = recording();
    for (const f of frames) f.quality.missing_joints = [16];
    const result = extractDynamicCapture(frames, 'front', 'right');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].complete_capture).toBe(false);
    const wrist = DYNAMIC_REFERENCE_FEATURES.findIndex(f => f.id === 'dynamic_ref_dominant_wrist_x');
    expect(result.segments[0].samples.every(s => s.values[wrist] === null)).toBe(true);
    expect(result.rejected_frames.MISSING_JOINT_MASKED).toBe(frames.length);
  });

  it('does not turn a held still position into a dynamic reference', () => {
    const frames = Array.from({ length: 80 }, (_, i) => syntheticPoseFrame(i, i * 50, { left_knee_flexion: 40, right_elbow_flexion: 70 }));
    expect(extractDynamicCapture(frames, 'front', 'right').segments).toEqual([]);
  });

  it('requires explicit source view and handedness', () => {
    expect(extractDynamicCapture(recording(), 'unknown', 'right').reason).toBe('VIEW_UNKNOWN');
    expect(extractDynamicCapture(recording(), 'front', 'unknown').reason).toBe('HANDEDNESS_UNKNOWN');
  });

  it('retains low-confidence local measurements as missing without filling values', () => {
    const frames = recording();
    for (const f of frames) {
      f.normalized_landmarks[16].visibility = 0.1;
      f.normalized_landmarks[16].presence = 0.1;
      f.quality.missing_joints = [];
    }
    const result = extractDynamicCapture(frames, 'front', 'right');
    expect(result.segments.length).toBeGreaterThan(0);
    const wrist = DYNAMIC_REFERENCE_FEATURES.findIndex(f => f.id === 'dynamic_ref_dominant_wrist_x');
    expect(result.segments.flatMap(s => s.samples).every(s => s.values[wrist] === null)).toBe(true);
  });

  it('retains travel with an origin-relative torso-scale transform, not absolute starting position', () => {
    const specs = new Map(DYNAMIC_REFERENCE_FEATURE_SPECS.map(s => [s.id, s]));
    const root = DYNAMIC_REFERENCE_FEATURES.find(f => f.id === 'dynamic_ref_root_x')!;
    expect(root.relative_to_start).toBe(true);
    expect(root.scale_feature_id).toBe('dynamic_ref_torso_scale');
    expect(specs.get(root.id)?.coordinate_system).toBe('image_pixel');
    expect(DYNAMIC_REFERENCE_FEATURES.find(f => f.id === root.scale_feature_id)?.weight).toBe(0);
  });
});

describe('dynamic reference contract bounds', () => {
  it('accepts generated reference metadata and explicit unsupported entries', () => {
    expect(() => validateDynamicReferenceModel(model())).not.toThrow();
    const empty = model(); empty.references = []; empty.unsupported_reasons = ['NO_SOURCE_CAPTURE'];
    expect(() => validateDynamicReferenceModel(empty)).not.toThrow();
  });
  it.each(['nan', 'backward-time', 'duplicate-reference', 'missing-scale', 'unreviewed-truth', 'unknown-view', 'bad-source-hash'])('rejects malformed %s', variant => {
    const m = structuredClone(model());
    if (variant === 'nan') m.references[0].samples[0].values[0] = NaN;
    if (variant === 'backward-time') m.references[0].samples[2].t_ms = -1;
    if (variant === 'duplicate-reference') m.references.push(m.references[0]);
    if (variant === 'missing-scale') m.features[0].scale_feature_id = 'missing';
    if (variant === 'unreviewed-truth') (m.provenance as any).phase_labels_reviewed = true;
    if (variant === 'unknown-view') m.references[0].view = 'unknown';
    if (variant === 'bad-source-hash') m.references[0].source_pose_sha256 = 'invalid';
    expect(() => validateDynamicReferenceModel(m)).toThrow();
  });
});
