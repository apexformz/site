import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { validate, type ContactMeasurementEvidence, type EquipmentMeasurementFrame, type PoseFrame, type TrackSet } from '@apexformz/contracts';
import { syntheticPoseFrame } from '@apexformz/signal';
import { loadSportPack } from '@apexformz/sport-runtime';
import { readPackDir } from '@apexformz/sport-runtime/node';
import { calibration as sessionCalibration, DEV_KEYS, PACKS_DIR } from '../../../tests/helpers/packs';
import { BrainRuntime } from './runtime';
import { equipmentFrameMismatch, validateEquipmentFrame } from './equipment';
import { calibrateCourt, courtFootprintMeasurements, mergeEquipmentFrames, projectCourtPoint, TrackSetEquipmentAdapter, type CourtCalibrationInput, type EquipmentCameraContext, type GroundFootprintObservation } from './equipment_adapters';

const pose = (frame = 0) => syntheticPoseFrame(frame, frame * 40, { right_arm_raise: 88, right_elbow_flexion: 5, left_arm_raise: 5, stance_width: 0.45 }, { session_id: 'equipment-session', camera_id: 'camera', tracked_subject_id: 'athlete' });
const context: EquipmentCameraContext = { session_id: 'equipment-session', camera_id: 'camera', view: 'front', image_size: [1280, 720], mirror: false, orientation: 'landscape' };
const contact = (p = pose(), event: ContactMeasurementEvidence['event'] = 'implement_projectile'): ContactMeasurementEvidence => ({ kind: 'sensor', event, source_id: 'independent-sensor', version: 'test-1', frame_id: p.frame_id, timestamp_ms: p.timestamp_ms, confidence: 0.95 });
const measurement = (p = pose()): EquipmentMeasurementFrame => ({ schema_version: '1.0.0', ...context, tracked_subject_id: 'athlete', frame_id: p.frame_id, timestamp_ms: p.timestamp_ms, retrospective: false, measurements: [{ measurement_id: 'height', equipment_id: 'racket', quantity: 'height_above_hip_torso', value: 0.4, unit: 'normalized', confidence: 0.95, source: { model_id: 'test-tracker', version: '1' }, validation_status: 'provisional', contact: contact(p) }] });
const courtInput: CourtCalibrationInput = { ...context, calibration_id: 'court-1', source: { model_id: 'manual-correspondences', version: '1' }, valid_from_ms: 0, valid_until_ms: 10000, confidence: 0.9, max_reprojection_error_m: 1e-6, correspondences: [{ image: [0, 0], court_m: [0, 0] }, { image: [1, 0], court_m: [10, 0] }, { image: [1, 1], court_m: [10, 20] }, { image: [0, 1], court_m: [0, 20] }] };

describe('equipment frame contracts and binding', () => {
  it('validates a bound observation and rejects malformed/nonfinite/duplicate/contact-mismatched input', () => {
    expect(validate('equipmentMeasurementFrame', measurement()).ok).toBe(true);
    for (const value of [NaN, Infinity]) { const m = measurement(); m.measurements[0].value = value; expect(validate('equipmentMeasurementFrame', m).ok).toBe(false); expect(() => validateEquipmentFrame(m)).toThrow(); }
    const duplicate = measurement(); duplicate.measurements.push(duplicate.measurements[0]); expect(() => validateEquipmentFrame(duplicate)).toThrow(/duplicate/);
    const staleContact = measurement(); staleContact.measurements[0].contact!.timestamp_ms++; expect(() => validateEquipmentFrame(staleContact)).toThrow(/contact/);
    const groundAsBall = measurement(); groundAsBall.measurements[0].contact!.event = 'foot_ground'; expect(() => validateEquipmentFrame(groundAsBall)).toThrow(/contact/);
    const reviewed = measurement(); reviewed.measurements[0].contact!.kind = 'reviewed_annotation'; expect(() => validateEquipmentFrame(reviewed)).toThrow(/retrospective/);
    reviewed.retrospective = true; expect(() => validateEquipmentFrame(reviewed)).not.toThrow();
  });
  it.each([
    [{ timestamp_ms: 1 }, 'STALE_FRAME'], [{ frame_id: 1 }, 'STALE_FRAME'],
    [{ camera_id: 'other' }, 'VIEW_INVALID'], [{ view: 'back' }, 'VIEW_INVALID'],
    [{ tracked_subject_id: 'other' }, 'AMBIGUOUS_SUBJECT'], [{ session_id: 'other' }, 'AMBIGUOUS_SUBJECT'],
    [{ mirror: true }, 'VIEW_INVALID'], [{ image_size: [640, 480] }, 'VIEW_INVALID'],
  ])('rejects a mismatched binding %j', (changes, reason) => {
    expect(equipmentFrameMismatch({ ...measurement(), ...changes } as EquipmentMeasurementFrame, pose(), 'front')).toBe(reason);
  });
});

describe('existing offline TrackSet integration', () => {
  const tracks: TrackSet = { schema_version: '1.0.0', session_id: context.session_id, source: { model_id: 'cotracker', version: 'test' }, kind: 'point', coordinate_system: 'image_pixel', image_size: context.image_size, frame_count: 1, retrospective: true, tracks: [{ track_id: 'racket-head', assigned_subject_id: 'athlete', label: 'implement_head', points: [{ frame_id: 0, timestamp_ms: 0, x: 640, y: 180, visible: true, confidence: 0.9 }] }, { track_id: 'ball', assigned_subject_id: 'athlete', points: [{ frame_id: 0, timestamp_ms: 0, x: 800, y: 360, visible: true, confidence: 0.8 }] }] };
  const binding = { track_id: 'racket-head', subject_id: 'athlete', equipment_id: 'racket', measurement_id: 'height', quantity: 'y_image' as const };
  it('maps explicit racket and ball tracks and preserves retrospective provenance without inventing contact', () => {
    const adapter = new TrackSetEquipmentAdapter(tracks, context, [binding, { ...binding, track_id: 'ball', equipment_id: 'ball', measurement_id: 'ball_x', quantity: 'x_image' }]);
    const result = adapter.measure(pose());
    expect(result.retrospective).toBe(true);
    expect(result.measurements.map((m) => m.value)).toEqual([0.25, 0.625]);
    expect(result.measurements.every((m) => !m.contact && m.validation_status === 'provisional')).toBe(true);
    expect(adapter.measure(pose(), contact()).measurements[0].contact?.kind).toBe('sensor');
  });
  it('never treats invisible or timestamp-unbound points as measurements', () => {
    for (const change of [{ visible: false }, { timestamp_ms: undefined }, { timestamp_ms: 1 }]) {
      const input = structuredClone(tracks); Object.assign(input.tracks[0].points[0], change);
      expect(new TrackSetEquipmentAdapter(input, context, [binding]).measure(pose()).measurements).toHaveLength(0);
    }
  });
  it('rejects ambiguous track identity and explicitly incompatible camera/session metadata', () => {
    expect(() => new TrackSetEquipmentAdapter(tracks, context, [{ ...binding, subject_id: 'other' }])).toThrow(/subject/);
    expect(() => new TrackSetEquipmentAdapter({ ...tracks, session_id: 'other' }, context, [binding])).toThrow(/session/);
    expect(() => new TrackSetEquipmentAdapter(tracks, context, [binding]).measure({ ...pose(), camera_id: 'other' })).toThrow(/camera/);
  });
});

describe('explicit floor-plane court calibration', () => {
  it('recovers known geometry and signed whole-footprint boundary clearance', () => {
    const c = calibrateCourt(courtInput);
    expect(projectCourtPoint(c, [0.25, 0.75])[0]).toBeCloseTo(2.5);
    expect(projectCourtPoint(c, [0.25, 0.75])[1]).toBeCloseTo(15);
    const observation: GroundFootprintObservation = { subject_id: 'athlete', measurement_id: 'foot', equipment_id: 'court_lines', footprint_image: [[0.2, 0.1], [0.3, 0.1], [0.3, 0.15], [0.2, 0.15]], region_court_m: [[0, 0], [10, 0], [10, 20], [0, 20]], confidence: 0.9, ground_contact: contact(pose(), 'foot_ground'), source: { model_id: 'footprint-tracker', version: 'test' } };
    const measured = courtFootprintMeasurements(c, pose(), [observation]);
    expect(measured.measurements[0].value).toBeCloseTo(2);
    expect(measured.measurements[0].ground_contact?.event).toBe('foot_ground');
    expect(measured.measurements[0].contact).toBeUndefined();
    const crossed = { ...observation, region_court_m: [[2.5, 0], [10, 0], [10, 20], [2.5, 20]] as [number, number][] };
    expect(courtFootprintMeasurements(c, pose(), [crossed]).measurements[0].value).toBeCloseTo(-0.5);
  });
  it('rejects degenerate correspondences, excess residual and stale calibration', () => {
    expect(() => calibrateCourt({ ...courtInput, correspondences: Array.from({ length: 4 }, (_, i) => ({ image: [i / 4, 0] as [number, number], court_m: [i, 0] as [number, number] })) })).toThrow(/degenerate/);
    expect(() => calibrateCourt({ ...courtInput, correspondences: [...courtInput.correspondences, { image: [0.5, 0.5], court_m: [9, 18] }] })).toThrow(/reprojection/);
    expect(() => courtFootprintMeasurements(calibrateCourt(courtInput), { ...pose(), timestamp_ms: 20000 }, [])).toThrow(/validity/);
  });
  it('rejects a finite projected footprint on the opposite side of the calibrated horizon', () => {
    const corners: [number, number][] = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]];
    const c = calibrateCourt({ ...courtInput, correspondences: corners.map(([u, v]) => ({ image: [u, v], court_m: [u / (1 - 2 * u), v / (1 - 2 * u)] })) });
    expect(projectCourtPoint(c, [0.2, 0.2])[0]).toBeCloseTo(1 / 3);
    expect(() => projectCourtPoint(c, [0.6, 0.2])).toThrow(/horizon/);
    expect(() => courtFootprintMeasurements(c, pose(), [{ subject_id: 'athlete', measurement_id: 'foot', equipment_id: 'court_lines', footprint_image: [[0.4, 0.1], [0.6, 0.1], [0.6, 0.2], [0.4, 0.2]], region_court_m: [[-100, -100], [100, -100], [100, 100], [-100, 100]], confidence: 0.9, ground_contact: contact(pose(), 'foot_ground'), source: { model_id: 'test', version: '1' } }])).toThrow(/horizon/);
  });
  it('rejects missing ground-contact evidence rather than assuming an ankle lies on the floor', () => {
    const observation = { subject_id: 'athlete', measurement_id: 'foot', equipment_id: 'court_lines', footprint_image: [[0.2, 0.1], [0.3, 0.1], [0.3, 0.15]], region_court_m: [[0, 0], [10, 0], [10, 20], [0, 20]], confidence: 0.9, source: { model_id: 'test', version: '1' } } as GroundFootprintObservation;
    expect(() => courtFootprintMeasurements(calibrateCourt(courtInput), pose(), [observation])).toThrow(/ground-contact/);
  });
  it('merges compatible adapters and rejects duplicate IDs or camera bindings', () => {
    const another = measurement(); another.measurements[0].measurement_id = 'other';
    expect(mergeEquipmentFrames(measurement(), another).measurements).toHaveLength(2);
    expect(() => mergeEquipmentFrames(measurement(), measurement())).toThrow(/duplicate/);
    expect(() => mergeEquipmentFrames(measurement(), { ...another, camera_id: 'other' })).toThrow(/binding/);
  });
});

async function equipmentRuntime(strict: boolean, comparator = true, requiresContact = true) {
  const bundle = await loadSportPack(await readPackDir(path.join(PACKS_DIR, 'shooting')), { platform: 'web', hmac_keys: DEV_KEYS });
  const movement = bundle.movement_catalog.movements.find((m) => m.id === 'shooting.setup_stance')!;
  const original = bundle.technique_criteria.criteria.find((c) => c.movement_id === movement.id)!;
  const criterion = { ...original, criterion_id: 'test.equipment', required_features: [], requires_capabilities: ['optional_implement' as const], evaluator: { kind: 'equipment_dependent' as const, limit: 0.5, params: { equipment: 'racket', measurement_id: 'height', measurement_unit: 'normalized', requires_contact: requiresContact, ...(comparator ? { comparison_kind: 'max_value' } : {}) } } };
  bundle.technique_criteria.criteria = [criterion]; movement.criteria = [criterion.criterion_id];
  const runtime = new BrainRuntime({ hmac_keys: DEV_KEYS, strict_rubrics: strict, allow_draft_feedback: true, capabilities_available: ['body_pose', 'optional_implement'] });
  runtime.installBundle(bundle); runtime.activatePack(bundle.manifest.id, bundle.manifest.version);
  const calibration = sessionCalibration(); runtime.calibrate(calibration, 0);
  runtime.start({ session_id: context.session_id, sport_pack_id: 'shooting', sport_pack_version: '1.0.0', movement_id: movement.id, calibration, pinned_models: [] }, 0);
  return runtime;
}
async function replay(strict = false, mutate?: (frame: EquipmentMeasurementFrame) => EquipmentMeasurementFrame | undefined, comparator = true) {
  const runtime = await equipmentRuntime(strict, comparator);
  const ticks = Array.from({ length: 60 }, (_, i) => { const p = pose(i); const m = measurement(p); return runtime.process(p, p.timestamp_ms, mutate ? mutate(m) : m)!; });
  return { runtime, ticks, result: ticks.flatMap((t) => t.assessment?.criteria ?? []).at(-1)! };
}
describe('runtime equipment scoring vertical slice', () => {
  it('cannot reuse old continuous measurements or pass from one recent frame in an otherwise missing phase', async () => {
    const lastAssessmentFrame = (await replay()).ticks.filter((t) => t.assessment).at(-1)!.frame_id;
    for (const sparse of [false, true]) {
      const runtime = await equipmentRuntime(false, true, false);
      const ticks = Array.from({ length: 60 }, (_, i) => { const p = pose(i); return runtime.process(p, p.timestamp_ms, (sparse ? i === lastAssessmentFrame : i < 30) ? measurement(p) : undefined)!; });
      const last = ticks.flatMap((t) => t.assessment?.criteria ?? []).at(-1)!;
      expect(last.score).toBeNull();
      expect(last.measurement.reason).toBe(sparse ? 'LOW_CONFIDENCE' : 'STALE_FRAME');
    }
  });
  it('uses supplied contact measurements in provisional scoring, and strict mode retains the measured abstention', async () => {
    const development = await replay(); expect(development.result.state).toBe('PASS'); expect(development.result.measurement.value).toBe(0.4);
    const strict = await replay(true); expect(strict.result.state).toBe('UNCERTAIN'); expect(strict.result.measurement.reason).toBe('RUBRIC_UNVALIDATED'); expect(strict.result.measurement.value).toBe(0.4);
  });
  it('does not invent a numeric limit when the current equipment criterion has no comparison', async () => {
    expect((await replay(false, undefined, false)).result.measurement).toMatchObject({ value: 0.4, reason: 'RUBRIC_UNVALIDATED' });
  });
  it('gates the confidence of independently supplied ground contact, even for direct host measurements', async () => {
    const { result } = await replay(false, (m) => { m.measurements[0].ground_contact = { ...m.measurements[0].contact!, event: 'foot_ground', confidence: 0.1 }; return m; });
    expect(result.state).toBe('UNCERTAIN'); expect(result.measurement.reason).toBe('LOW_CONFIDENCE'); expect(result.score).toBeNull();
  });
  it.each(['camera', 'subject', 'stale', 'confidence', 'contact', 'missing'] as const)('withholds invalid %s evidence', async (fault) => {
    const { result } = await replay(false, (m) => {
      if (fault === 'missing') return undefined;
      if (fault === 'camera') m.camera_id = 'other';
      if (fault === 'subject') m.tracked_subject_id = 'other';
      if (fault === 'stale') { m.timestamp_ms += 1; m.measurements[0].contact!.timestamp_ms += 1; }
      if (fault === 'confidence') m.measurements[0].confidence = 0.1;
      if (fault === 'contact') delete m.measurements[0].contact;
      return m;
    });
    expect(['UNCERTAIN', 'NOT_ASSESSABLE']).toContain(result.state); expect(result.score).toBeNull();
  });
  it('marks offline evidence retrospective and never speaks its correction as a live cue', async () => {
    const { ticks, result } = await replay(false, (m) => { m.retrospective = true; m.measurements[0].value = 2; return m; });
    expect(result.state).toBe('IMPROVE'); expect(result.retrospective).toBe(true);
    expect(ticks.filter((t) => t.assessment).every((t) => t.assessment!.retrospective && t.feedback === null)).toBe(true);
  });
});
