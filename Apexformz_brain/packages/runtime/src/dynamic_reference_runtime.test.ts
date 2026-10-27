import { describe, expect, it } from 'vitest';
import { SignalPipeline, syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { FeatureEngine } from '@apexformz/features';
import { validate, type DynamicReferenceModel } from '@apexformz/contracts';
import { createLegacyAdapterState, skeletonFeedbackStyle, toLegacyFrameAnalysis } from '@apexformz/brain-client';
import { calibration, runtimeWithPacks, startRequest } from '../../../tests/helpers/packs';
import { DYNAMIC_REFERENCE_FEATURES, DYNAMIC_REFERENCE_FEATURE_SPECS } from '../../../tools/extract_dynamic_references';
import { createTechniqueReview, recordTechniqueAssessment } from '../../../apps/frontend/src/lib/brain/sessionTechniqueReview';
import type { BrainRuntime, BrainRuntimeConfig, BrainTick } from './index';
import { dynamicReferenceAssessment } from './dynamic_reference_assessment';
import type { DynamicReferenceComparison } from '@apexformz/scoring';

const movement = 'squash.dynamic.0040';
const session = 'dynamic-reference-runtime';
const dt = 100;
const geometry = (p: number, wrong = false): SyntheticPoseOptions => ({
  right_arm_raise: 25 + 85 * p, right_elbow_flexion: 100 - 75 * p,
  left_arm_raise: 20, left_elbow_flexion: 35, left_knee_flexion: wrong && p >= .25 && p <= .75 ? 0 : 40,
  right_knee_flexion: 20 + 20 * Math.sin(p * Math.PI), trunk_lean: 8, stance_width: .4,
});

/** A known geometry fixture, not a real athlete or a claim of perception accuracy. */
function knownGeometryModel(completeCapture = true): DynamicReferenceModel {
  const signal = new SignalPipeline({ view: 'front', allow_short_gap_prediction: false });
  const features = new FeatureEngine(DYNAMIC_REFERENCE_FEATURE_SPECS);
  const samples = Array.from({ length: 21 }, (_, i) => {
    const t = i * dt;
    signal.process(syntheticPoseFrame(i, t, geometry(i / 20)));
    const values = features.compute(signal.window, { view: 'front', handedness: 'right', handedness_assumed: false });
    return { t_ms: t, values: DYNAMIC_REFERENCE_FEATURES.map(f => values.get(f.id)?.value ?? null) };
  });
  return { kind: 'dynamic_reference', schema_version: '1.0.0', movement_id: movement, validation_status: 'provisional',
    features: structuredClone(DYNAMIC_REFERENCE_FEATURES), feature_specs: structuredClone(DYNAMIC_REFERENCE_FEATURE_SPECS),
    references: [{ id: 'controlled-known-geometry', view: 'front', handedness: 'right', source_execution_id: 'synthetic-fixture', source_pose_sha256: 'a'.repeat(64), source_media_sha256: 'b'.repeat(64),
      start_ms: 0, end_ms: 2000, duration_ms: 2000, samples, boundary_method: 'observed_motion', complete_capture: completeCapture }],
    unsupported_reasons: [], provenance: { dataset_sha256: 'c'.repeat(64), extraction_version: 'synthetic-runtime-test', phase_labels_reviewed: false, tolerances_reviewed: false } };
}

async function setup(options: { strict?: boolean; model?: DynamicReferenceModel; config?: Partial<BrainRuntimeConfig> } = {}) {
  const rt = await runtimeWithPacks(['squash'], { guided_coaching: true, strict_rubrics: options.strict ?? false, allow_draft_feedback: !options.strict, ...options.config });
  const pack = rt.registry.getActive('squash')!;
  const definitions = pack.technique_criteria.criteria.filter(c => c.movement_id === movement && c.evaluator.kind === 'dynamic_reference');
  expect(definitions.length).toBeGreaterThan(0);
  const modelPath = definitions[0].evaluator.model_reference!;
  const model = options.model ?? knownGeometryModel();
  // Replace only this test runtime's already-loaded model. No pack files or source recordings change.
  pack.models![modelPath] = model;
  const cal = calibration();
  rt.calibrate(cal, 0);
  const ctx = rt.start(startRequest(session, 'squash', movement, cal), 0);
  return { rt, ctx, model, definitions };
}

function replay(rt: BrainRuntime, wrong = false, duration = 2000, begin = 0, startFrame = 0): BrainTick[] {
  const ticks: BrainTick[] = [];
  for (let t = 0, frame = startFrame; t <= duration + 1400; t += dt, frame++) {
    const timestamp = begin + t;
    const p = Math.min(1, t / duration);
    const tick = rt.process(syntheticPoseFrame(frame, timestamp, geometry(p, wrong), { session_id: session }), timestamp);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

describe('dynamic reference through the assembled runtime and feedback adapters', () => {
  it('compares the selected recording without generic template verdicts or recognizer target switching', async () => {
    const { rt } = await setup();
    rt.noteRecognition({ timestamp_ms: 100, family_id: 'another-family', group_id: 'another-group', movement_id: 'another-movement', probability: 1, validated: false, level: 'movement' });
    const ticks = replay(rt);
    const assessments = ticks.flatMap(t => t.assessment ? [t.assessment] : []);
    expect(ticks.some(t => t.dynamic_reference?.status === 'active')).toBe(true);
    expect(assessments.length).toBeGreaterThan(0);
    expect(assessments.every(a => a.movement_id === movement && a.session_id === session && a.criteria.every(c => c.provenance.evaluator === 'dynamic_reference'))).toBe(true);
    expect(assessments.every(a => a.score === null && a.execution_id === null && validate('assessmentSet', a).ok)).toBe(true);
    expect(assessments.flatMap(a => a.criteria).some(c => c.state === 'IMPROVE')).toBe(false);
    expect(assessments.flatMap(a => a.criteria).some(c => c.state === 'PASS')).toBe(true);
    expect(ticks.every(t => !t.feedback || t.feedback.kind !== 'technique_cue')).toBe(true);
    expect(ticks.some(t => t.dynamic_reference?.status === 'complete')).toBe(true);
    // Reference matching alone must not fabricate a canonical squash repetition.
    expect(ticks.filter(t => t.temporal?.completed)).toHaveLength(0);
  });

  it('turns supported wrong knee geometry red, speaks its measured correction at rest and retains it in the session review', async () => {
    const { rt, ctx } = await setup();
    const ticks = replay(rt, true);
    const adapter = createLegacyAdapterState();
    const review = createTechniqueReview(session, movement);
    const visual = { handedness: 'right' as const, featureSpecs: ctx.feature_specs };
    let redKnee = false;
    for (const tick of ticks) {
      recordTechniqueAssessment(review, tick.assessment, visual);
      const body = toLegacyFrameAnalysis(tick, adapter, [], visual);
      if (skeletonFeedbackStyle(body.visual_cues, 'left_knee', 'left_ankle').state === 'improve') {
        redKnee = true;
        expect(tick.dynamic_reference?.current).toBe(true);
        expect(skeletonFeedbackStyle(body.visual_cues, 'right_shoulder', 'right_elbow').state).not.toBe('improve');
      }
      if (tick.dynamic_reference?.status === 'complete' || tick.dynamic_reference?.status === 'incomplete') expect(body.visual_cues).toEqual([]);
    }
    expect(redKnee).toBe(true);
    const cues = ticks.filter(t => t.feedback?.kind === 'technique_cue');
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.every(t => t.dynamic_reference?.cue_allowed && validate('feedbackAction', t.feedback!).ok)).toBe(true);
    expect(cues.some(t => /left knee|left foot|left hip/.test(t.feedback!.text))).toBe(true);
    const saved = JSON.parse(JSON.stringify(review.review));
    expect(saved.criteria.some((c: { latest_correction?: { correction: string; body_areas: string[] } }) => c.latest_correction?.correction && c.latest_correction.body_areas.includes('left knee'))).toBe(true);
    expect(JSON.stringify(saved)).not.toMatch(/landmarks|reference_deviations|frame_ids/);
  });

  it('strict mode withholds provisional reference verdicts and speech', async () => {
    const { rt } = await setup({ strict: true });
    const ticks = replay(rt, true);
    const criteria = ticks.flatMap(t => t.assessment?.criteria ?? []);
    expect(criteria.length).toBeGreaterThan(0);
    expect(criteria.every(c => c.state === 'UNCERTAIN' && c.measurement.reason === 'RUBRIC_UNVALIDATED')).toBe(true);
    expect(ticks.every(t => !t.feedback || t.feedback.kind !== 'technique_cue')).toBe(true);
  });

  it('retains a partial-reference correction until fresh quiet permits speech, without colouring the unrecorded tail', async () => {
    const { rt, ctx } = await setup({ model: knownGeometryModel(false) });
    const ticks = replay(rt, true);
    const finished = ticks.find(t => t.dynamic_reference?.status === 'incomplete');
    expect(finished).toBeDefined();
    expect(finished!.dynamic_reference?.cue_allowed).toBe(false);
    expect(finished!.assessment?.criteria.some(c => c.state === 'IMPROVE')).toBe(true);
    const after = ticks.filter(t => t.timestamp_ms > finished!.timestamp_ms);
    const adapter = createLegacyAdapterState();
    for (const tick of after) {
      expect(toLegacyFrameAnalysis(tick, adapter, [], { handedness: 'right', featureSpecs: ctx.feature_specs }).visual_cues).toEqual([]);
    }
    const cues = after.filter(t => t.feedback?.kind === 'technique_cue');
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.every(t => t.dynamic_reference?.cue_allowed)).toBe(true);
    expect(cues.some(t => /left knee|left foot|left hip/.test(t.feedback!.text))).toBe(true);
    expect(ticks.some(t => t.temporal?.completed)).toBe(false);
  });

  it.each(['view', 'hand', 'recording'] as const)('explicitly withholds unsupported %s references rather than grading another target', async kind => {
    const model = knownGeometryModel();
    if (kind === 'view') model.references[0].view = 'back';
    if (kind === 'hand') model.references[0].handedness = 'left';
    if (kind === 'recording') model.references = [];
    const { rt } = await setup({ model });
    const ticks = replay(rt, true);
    expect(ticks.every(t => t.dynamic_reference?.status === 'unavailable')).toBe(true);
    const reason = kind === 'view' ? 'VIEW_INVALID' : kind === 'hand' ? 'HANDEDNESS_UNKNOWN' : 'MODEL_UNAVAILABLE';
    expect(ticks.flatMap(t => t.assessment?.criteria ?? []).every(c => c.state === 'NOT_ASSESSABLE' && c.measurement.reason === reason && c.movement_id === movement)).toBe(true);
    expect(ticks.some(t => t.feedback?.kind === 'technique_cue')).toBe(false);
  });

  it('tracking gaps, pause/resume and identity changes cannot carry old reference faults into a new attempt', async () => {
    const { rt } = await setup();
    for (let t = 0; t <= 1000; t += dt) rt.process(syntheticPoseFrame(t / dt, t, geometry(t / 2000, true), { session_id: session }), t);
    const gap = rt.process(syntheticPoseFrame(30, 1900, geometry(.5), { session_id: session }), 1900)!;
    expect(gap.signal.time_gap).toBe(true);
    expect(gap.assessment).toBeNull();
    expect(gap.dynamic_reference).toBeNull();
    expect(gap.feedback?.kind).not.toBe('technique_cue');
    rt.pause(2000); rt.resume(5000);
    const resumed = rt.process(syntheticPoseFrame(31, 5100, geometry(0), { session_id: session }), 5100)!;
    expect(resumed.assessment?.criteria.some(c => c.state === 'PASS' || c.state === 'IMPROVE')).not.toBe(true);
    expect(resumed.feedback?.kind).not.toBe('technique_cue');
    const changed = rt.process(syntheticPoseFrame(32, 5200, geometry(.5), { session_id: session, tracked_subject_id: 'other-athlete' }), 5200)!;
    expect(changed.signal.track_changed).toBe(true);
    expect(changed.dynamic_reference).toBeNull();
    expect(changed.assessment).toBeNull();
  });

  it('does not present a truncated attempt’s last in-range pose as a passed reference segment', async () => {
    const { definitions, model } = await setup();
    const feature = model.features.find(f => f.id === 'dynamic_ref_left_knee_angle')!;
    const incomplete: DynamicReferenceComparison = { attempt_id: 'cut-short', status: 'incomplete', state: 'UNCERTAIN', progress: .3, reference_id: model.references[0].id,
      confidence: .9, distance: .1, coverage: 1, sequence_mismatch: false, alignment_ambiguous: false, reason: 'COVERAGE_INSUFFICIENT', current: false, completed: false, segment_matched: false,
      cue_allowed: true, since_ms: 0, timestamp_ms: 500, frame_id: 5, evidence_frames: [1, 2, 3, 4, 5],
      deviations: [{ feature_id: feature.id, observed: 140, reference: 140, unit: feature.unit, tolerance: feature.tolerance, normalized_error: 0, weighted_squared_contribution: 0, outside_reference_band: false }] };
    const a = dynamicReferenceAssessment(incomplete, model, definitions, { session_id: session, sport_pack_id: 'squash', sport_pack_version: '1.0.0', rubric_version: 'test', movement_id: movement, view: 'front', strict: false, allow_draft_feedback: true }, 5, 500);
    expect(a.criteria.some(c => c.state === 'PASS')).toBe(false);
    const partialModel = structuredClone(model); partialModel.references[0].complete_capture = false;
    const matched = dynamicReferenceAssessment({ ...incomplete, segment_matched: true }, partialModel, definitions, { session_id: session, sport_pack_id: 'squash', sport_pack_version: '1.0.0', rubric_version: 'test', movement_id: movement, view: 'front', strict: false, allow_draft_feedback: true }, 5, 500);
    expect(matched.criteria.find(c => c.measurement.feature_id === feature.id)?.state).toBe('PASS');
    expect(matched.criteria.find(c => !c.measurement.feature_id)?.state).toBe('UNCERTAIN');
    expect(matched.score).toBeNull();

    const fault = dynamicReferenceAssessment({ ...incomplete, progress: 1, state: 'IMPROVE', sequence_mismatch: true,
      deviations: [{ ...incomplete.deviations[0], observed: 175, outside_reference_band: true, reference_progress: .5 }] }, partialModel, definitions,
    { session_id: session, sport_pack_id: 'squash', sport_pack_version: '1.0.0', rubric_version: 'test', movement_id: movement, view: 'front', strict: false, allow_draft_feedback: true }, 5, 500);
    const local = fault.criteria.find(c => c.measurement.feature_id === feature.id)!;
    expect(local.feedback?.rationale).toContain('middle part');
    expect((local as typeof local & { meta: { dynamic_reference: { progress: number; phase_label: string } } }).meta.dynamic_reference).toMatchObject({ progress: .5, phase_label: 'middle part' });
    const sequenceCue = fault.criteria.find(c => !c.measurement.feature_id)?.feedback?.cue;
    expect(sequenceCue).toContain('available recorded portion');
    expect(sequenceCue).not.toContain('full sequence');
  });
});
