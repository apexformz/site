import { describe, expect, it } from 'vitest';
import type { Candidate } from './types';
import { SubjectTracker } from './subject_tracker';
import { ByteSubjectTracker } from './byte_subject_tracker';
import { fromPoseLandmarkerResult } from './adapters';
import { syntheticPoseFrame } from '@apexformz/signal';

function person(cx: number): Candidate {
  return { normalized: [], confidence: .95, bbox: { x0: cx - .1, x1: cx + .1, y0: .2, y1: .8, cx, cy: .5, area: .12 } };
}
const roi = { x0: .05, y0: .05, x1: .5, y1: .95 };

describe.each([{ name: 'centroid', Tracker: SubjectTracker }, { name: 'ByteTrack', Tracker: ByteSubjectTracker }])('explicit subject region $name', ({ Tracker }) => {
  it('requires an unambiguous initial subject and never labels a reflection automatically', () => {
    const tracker = new Tracker();
    expect(tracker.select([person(.3), person(.7)])).toMatchObject({ index: null, ambiguous: true, person_count: 2 });
    expect(tracker.currentTrackId).toBeNull();
  });
  it('selects only the explicit region, preserving original indexes and total detected count', () => {
    const tracker = new Tracker({ subject_roi: roi });
    tracker.select([person(.7), person(.3)]); // ByteTrack requires its confirmation frame.
    expect(tracker.select([person(.7), person(.3)])).toMatchObject({ index: 1, ambiguous: false, person_count: 2 });
    expect(tracker.select([person(.7)])).toMatchObject({ index: null, person_count: 1 });
  });
  it('still abstains for comparable competing people inside the region', () => {
    const tracker = new Tracker({ subject_roi: roi });
    tracker.select([person(.3)]);
    expect(tracker.select([person(.3), person(.36)])).toMatchObject({ index: null, ambiguous: true, person_count: 2 });
  });
  it('validates the explicit region instead of silently accepting invalid bounds', () => {
    expect(() => new Tracker({ subject_roi: { ...roi, x0: .7 } })).toThrow(/subject_roi/);
    expect(() => new Tracker({ subject_roi: { ...roi, x1: NaN } })).toThrow(/subject_roi/);
  });
});

it('centroid tracking flags a sudden single-person jump as a changed identity', () => {
  const tracker = new SubjectTracker();
  const first = tracker.select([person(.3)]);
  const jumped = tracker.select([person(.85)]);
  expect(jumped.track_id).not.toBe(first.track_id);
  expect(jumped.track_changed).toBe(true);
});

it('an empty ambiguous selection keeps its quality flag in the pose adapter', () => {
  const source = syntheticPoseFrame(0, 0);
  const a = source.normalized_landmarks.map((p) => ({ ...p, z: p.z ?? 0 }));
  const b = a.map((p) => ({ ...p, x: p.x + .1 }));
  const frame = fromPoseLandmarkerResult({ landmarks: [a, b] }, { session_id: 's', frame_id: 0, timestamp_ms: 0,
    camera_id: 'c', image_size: [1280, 720], mirror: false, orientation: 'landscape', provenance: { model_id: 'test', version: '1' } });
  expect(frame.normalized_landmarks).toEqual([]);
  expect(frame.quality).toMatchObject({ ambiguous_people: true, framing_ok: false, person_count: 2 });
});
