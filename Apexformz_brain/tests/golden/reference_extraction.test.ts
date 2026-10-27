import { describe, expect, it } from 'vitest';
import type { FeatureSpec } from '@apexformz/contracts';
import { syntheticPoseFrame } from '@apexformz/signal';
import { extractReferenceCapture, resolveReferenceHandedness } from '../../tools/extract_reference_vectors';

const specs: FeatureSpec[] = [
  { id: 'left_knee_angle', kind: 'angle_at', params: { a: 'left_hip', b: 'left_knee', c: 'left_ankle', dims: '2d' }, version: '1', coordinate_system: 'body_relative', view_applicability: 'any', unit: 'deg' },
  { id: 'dominant_elbow_angle', kind: 'angle_at', params: { a: 'dominant_shoulder', b: 'dominant_elbow', c: 'dominant_wrist', dims: '2d' }, version: '1', coordinate_system: 'body_relative', view_applicability: 'any', unit: 'deg' },
];
const ids = specs.map((f) => f.id);
const unknown = resolveReferenceHandedness(['unknown']);
const good = () => syntheticPoseFrame(0, 0, { left_knee_flexion: 45, right_elbow_flexion: 70 });

describe('reference capture quality and source handedness', () => {
  it.each([
    [{ framing_ok: false }, 'FRAMING_INVALID'],
    [{ ambiguous_people: true }, 'AMBIGUOUS_PEOPLE'],
    [{ person_count: 2 }, 'AMBIGUOUS_PEOPLE'],
    [{ track_changed: true }, 'TRACK_CHANGED'],
    [{ missing_joints: [15] }, 'MISSING_JOINT'],
  ])('rejects globally unusable captures before valid-looking local angles can become references', (quality, reason) => {
    const frame = good();
    frame.quality = { ...frame.quality, ...quality };
    const result = extractReferenceCapture([frame], specs, ids, 'front', unknown);
    expect(result.values).toBeNull();
    expect(result.rejected_frames[reason as string]).toBe(1);
  });
  it('does not fall back to an earlier good frame when the latest capture frame is unusable', () => {
    const bad = syntheticPoseFrame(1, 33);
    bad.quality.framing_ok = false;
    expect(extractReferenceCapture([good(), bad], specs, ids, 'front', unknown).values).toBeNull();
  });
  it('retains bilateral evidence while unknown handedness leaves dominant-side angles missing', () => {
    const result = extractReferenceCapture([good()], specs, ids, 'front', unknown);
    expect(result.values?.[0]).toBeCloseTo(135, 0);
    expect(result.values?.[1]).toBeNull();
    expect(unknown).toEqual({ handedness: 'unknown', handedness_assumed: false, handedness_source: 'unknown' });
  });
  it('uses only explicit source handedness and records any CLI override as assumed', () => {
    expect(resolveReferenceHandedness(['unknown', 'left']).handedness).toBe('left');
    expect(resolveReferenceHandedness(['left', 'right']).handedness_source).toBe('conflicting_dataset');
    const assumed = resolveReferenceHandedness(['unknown'], 'right');
    expect(assumed.handedness_assumed).toBe(true);
    expect(assumed.handedness_source).toBe('cli_assumption');
    expect(() => resolveReferenceHandedness([], 'typo')).toThrow();
    expect(extractReferenceCapture([good()], specs, ids, 'front', resolveReferenceHandedness(['right'])).values?.[1]).not.toBeNull();
  });
});
