import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CriterionEvidence, FeatureSpec } from '@apexformz/contracts';
import { criterionFeedbackCorrection, criterionFeedbackLabel, criterionVisualCue, prioritizeCorrectionIssues, skeletonFeedbackStyle } from './visual_feedback';
import { createLegacyAdapterState, toLegacyFrameAnalysis } from './legacy_adapter';
import type { BrainTick } from '@apexformz/runtime';

const features = JSON.parse(readFileSync(new URL('../../../sport-packs/squash/technique_criteria.json', import.meta.url), 'utf8')).features as FeatureSpec[];
const context = { handedness: 'left' as const, featureSpecs: features };
function evidence(feature: string, state: CriterionEvidence['state'] = 'IMPROVE', provisional = true): CriterionEvidence {
  return {
    criterion_id: `test.${feature}`, movement_id: 'test', phase_id: 'hold', state, score: state === 'PASS' ? 1 : 0,
    measurement: { value: 180, unit: 'deg', reason: null, feature_id: feature },
    confidence: { movement: 1, assessment: 1, evidence_quality: 1 },
    evidence: { frame_ids: [1], view: 'front', feature_ids: [feature] },
    feedback: { error_id: 'test', cue: 'Adjust posture', rationale: 'Measured deviation' },
    provenance: { sport_pack: '1', rubric: '1', validation_status: provisional ? 'provisional' : 'approved', evaluator: 'max_value', provisional },
    severity: 'low', timestamp_ms: 1000,
  };
}

describe('evidence-led joint feedback for static and dynamic drills', () => {
  it('projects current dynamic reference deviations independently of heuristic phase and never replays completed faults on the body', () => {
    const spec: FeatureSpec = { id: 'dynamic_ref_left_knee_angle', kind: 'angle_at', params: { a: 'left_hip', b: 'left_knee', c: 'left_ankle' }, version: '1', coordinate_system: 'body_relative', view_applicability: 'any' };
    const ref = { ...evidence(spec.id), phase_id: null, feedback: { error_id: 'reference', cue: 'Bend your left knee more during the middle of the recorded movement.', rationale: 'Measured comparison.' },
      provenance: { ...evidence('').provenance, evaluator: 'dynamic_reference' }, meta: { assessment_source: 'dynamic_reference_live', reference_deviations: [
        { feature_id: spec.id, observed: 175, reference: 135, unit: 'deg', weighted_squared_contribution: 1600, outside_reference_band: true },
        { feature_id: 'right_knee_angle', observed: 135, reference: 135, unit: 'deg', weighted_squared_contribution: 0, outside_reference_band: false },
      ] } } as unknown as CriterionEvidence;
    const ctx = { ...context, featureSpecs: [...features, spec] };
    const tick = { frame_id: 1, timestamp_ms: 1000, quality: { ok: true, reasons: [] }, signal: { dropped: false, track_changed: false, time_gap: false }, features: [], temporal: { phase_id: 'ready', state: 'CONFIRMED' }, assessment: { timestamp_ms: 1000, criteria: [ref], score: null, coverage: { ratio: 1 } }, feedback: null } as unknown as BrainTick;
    const state = createLegacyAdapterState();
    const live = toLegacyFrameAnalysis(tick, state, [], ctx);
    expect(skeletonFeedbackStyle(live.visual_cues, 'left_knee', 'left_ankle').color).toBe('#ff4757');
    expect(skeletonFeedbackStyle(live.visual_cues, 'right_knee', 'right_ankle').color).toBe('#00d4ff');
    expect(criterionFeedbackLabel(ref)).toBe('Left knee bend compared with recording');
    expect(criterionFeedbackCorrection(ref)).toBe(ref.feedback!.cue);
    expect(toLegacyFrameAnalysis({ ...tick, frame_id: 2, timestamp_ms: 1050, assessment: null }, state, [], ctx).visual_cues).toEqual([]);
    const complete = { ...ref, meta: { ...((ref as unknown as { meta: object }).meta), assessment_source: 'dynamic_reference_completed' } };
    expect(toLegacyFrameAnalysis({ ...tick, assessment: { ...tick.assessment!, criteria: [complete] } }, createLegacyAdapterState(), [], ctx).visual_cues).toEqual([]);
    expect(criterionVisualCue({ ...ref, state: 'PASS' }, ctx).affected_segments).toEqual([]);
    expect(criterionVisualCue({ ...ref, state: 'UNCERTAIN' }, ctx).affected_segments).toEqual([]);
    expect(toLegacyFrameAnalysis({ ...tick, quality: { ok: false, reasons: ['FRAMING_INVALID'] } }, state, [], ctx).visual_cues).toEqual([]);
  });
  it('highlights only the measured knee side, preserving anatomical left/right under mirrored display', () => {
    const cue = criterionVisualCue(evidence('left_knee_angle'), context);
    expect(skeletonFeedbackStyle([cue], 'left_hip', 'left_knee').state).toBe('improve');
    expect(skeletonFeedbackStyle([cue], 'right_hip', 'right_knee').state).toBe('unassessed');
    expect(cue.affected_segments).toEqual([['left_hip', 'left_knee'], ['left_knee', 'left_ankle']]);
  });
  it('maps stance width to the feet/lower legs without accusing the shoulder-width scale', () => {
    const cue = criterionVisualCue(evidence('stance_width_ratio'), context);
    expect(cue.affected_joints).toEqual(['left_ankle', 'right_ankle']);
    expect(skeletonFeedbackStyle([cue], 'right_knee', 'right_ankle').state).toBe('improve');
    expect(skeletonFeedbackStyle([cue], 'left_shoulder', 'right_shoulder').state).toBe('unassessed');
  });
  it('maps balance to the trunk without marking adjacent arms as faulty', () => {
    const cue = criterionVisualCue(evidence('trunk_lateral_lean'), context);
    expect(skeletonFeedbackStyle([cue], 'left_shoulder', 'left_hip').state).toBe('improve');
    expect(skeletonFeedbackStyle([cue], 'left_shoulder', 'left_elbow').state).toBe('unassessed');
  });
  it('resolves dominant and nondominant wrists/arms using configured handedness', () => {
    const left = criterionVisualCue(evidence('dominant_wrist_rel_y'), context);
    expect(left.affected_segments).toEqual([['left_elbow', 'left_wrist']]);
    const opposite = criterionVisualCue(evidence('nondominant_elbow_angle'), context);
    expect(opposite.affected_segments).toContainEqual(['right_shoulder', 'right_elbow']);
    expect(criterionVisualCue(evidence('dominant_wrist_rel_y'), { ...context, handedness: 'unknown' }).affected_segments).toEqual([]);
  });
  it('projects dynamic feature dependencies, including preparation, lunge, and swing smoothness', () => {
    for (const feature of ['lead_knee_velocity', 'dominant_elbow_velocity', 'dominant_arm_elevation', 'dominant_wrist_jerk', 'stroke_sequencing']) {
      expect(criterionVisualCue(evidence(feature), context).affected_segments.length, feature).toBeGreaterThan(0);
    }
    expect(criterionVisualCue(evidence('left_knee_ankle_offset_x'), context).affected_segments).toEqual([['left_knee', 'left_ankle']]);
  });
  it('does not localize aggregate reference distance or an unknown feature to an invented faulty joint', () => {
    const ref = evidence('left_knee_angle'); ref.provenance.evaluator = 'reference_nearest';
    expect(criterionVisualCue(ref, context).affected_joints).toEqual([]);
    expect(criterionVisualCue(evidence('unknown_feature'), context).affected_joints).toEqual([]);
  });
  it('localizes only measured out-of-band reference contributors and gives their measured target', () => {
    const ref = evidence('left_knee_angle');
    ref.provenance.evaluator = 'reference_nearest';
    Object.assign(ref, { meta: { reference_deviations: [
      { feature_id: 'left_knee_angle', observed: 178, reference: 143, unit: 'deg', weighted_squared_contribution: 1225, outside_reference_band: true },
      { feature_id: 'right_knee_angle', observed: 146, reference: 143, unit: 'deg', weighted_squared_contribution: 9, outside_reference_band: false },
    ] } });
    const cue = criterionVisualCue(ref, context);
    expect(cue.affected_segments).toEqual([['left_hip', 'left_knee'], ['left_knee', 'left_ankle']]);
    expect(skeletonFeedbackStyle([cue], 'left_knee', 'left_ankle')).toEqual({ color: '#ff4757', dashed: true, state: 'improve' });
    expect(skeletonFeedbackStyle([cue], 'right_knee', 'right_ankle').color).toBe('#00d4ff');
    expect(criterionFeedbackCorrection(ref)).toBe('Bend your left knee more toward the recorded position.');
    ref.state = 'UNCERTAIN';
    expect(criterionVisualCue(ref, context).affected_segments).toEqual([]);
  });
  it('excludes reference components that conflict with authored criteria and provides directional arm cues', () => {
    const ref = evidence('dominant_elbow_angle');
    ref.provenance.evaluator = 'reference_nearest';
    const deviation = { feature_id: 'dominant_elbow_angle', observed: 178, reference: 40, unit: 'deg', weighted_squared_contribution: 19044, outside_reference_band: true, constraint_conflict: true };
    Object.assign(ref, { meta: { reference_deviations: [deviation] } });
    expect(criterionVisualCue(ref, context).affected_segments).toEqual([]);
    deviation.constraint_conflict = false;
    expect(criterionFeedbackCorrection(ref)).toBe('Bend your dominant elbow more toward the recorded position.');
    deviation.observed = 20;
    expect(criterionFeedbackCorrection(ref)).toBe('Straighten your dominant elbow more toward the recorded position.');
    deviation.feature_id = 'dominant_arm_elevation';
    expect(criterionFeedbackCorrection(ref)).toBe('Lift your dominant upper arm away from your body toward the recorded position.');
    deviation.observed = 150;
    expect(criterionFeedbackCorrection(ref)).toBe('Bring your dominant upper arm closer to your body toward the recorded position.');
  });
  it('distinguishes provisional correction, reviewed pass, and insufficient evidence', () => {
    const cue = criterionVisualCue(evidence('left_knee_angle'), context);
    expect(skeletonFeedbackStyle([cue], 'left_hip', 'left_knee')).toEqual({ color: '#ff4757', dashed: true, state: 'improve' });
    const pass = criterionVisualCue(evidence('left_knee_angle', 'PASS', false), context);
    expect(skeletonFeedbackStyle([pass], 'left_hip', 'left_knee').state).toBe('pass');
    for (const state of ['UNCERTAIN', 'NOT_ASSESSABLE', 'NOT_APPLICABLE', 'PASS'] as const) {
      const unreviewed = criterionVisualCue(evidence('left_knee_angle', state), context);
      expect(skeletonFeedbackStyle([unreviewed], 'left_hip', 'left_knee')).toEqual({ color: '#00d4ff', dashed: false, state: 'unassessed' });
    }
    expect(skeletonFeedbackStyle([pass, cue], 'left_hip', 'left_knee').state).toBe('improve');
  });
  it('keeps low-severity hand/balance cues visible and sorts priorities without mutating input', () => {
    const issues = [{ severity: 'low' as const, id: 'hand' }, { severity: 'high' as const, id: 'knee' }, { severity: 'none' as const, id: 'none' }];
    expect(prioritizeCorrectionIssues(issues).map(i => i.id)).toEqual(['knee', 'hand']);
    expect(issues[0].id).toBe('hand');
  });
  it('names observable proxies without claiming weight distribution or racket orientation', () => {
    expect(criterionFeedbackLabel({ ...evidence('dominant_wrist_rel_y'), criterion_id: 'squash.static.0001.racket_up' })).toBe('Dominant hand height');
    expect(criterionFeedbackLabel({ ...evidence('trunk_lateral_lean'), criterion_id: 'squash.static.0001.balance' })).toBe('Trunk alignment');
  });
  it('audits every current squash criterion: only known temporal/equipment/reference criteria remain text-only', () => {
    const pack = JSON.parse(readFileSync(new URL('../../../sport-packs/squash/technique_criteria.json', import.meta.url), 'utf8'));
    const counts = { segments: 0, points: 0, text: 0 };
    for (const c of pack.criteria) {
      const item = { ...evidence(c.required_features[0]), criterion_id: c.criterion_id, evidence: { frame_ids: [1], view: 'front' as const, feature_ids: c.required_features }, provenance: { ...evidence('').provenance, evaluator: c.evaluator.kind } };
      const cue = criterionVisualCue(item, context);
      if (cue.affected_segments.length) counts.segments++;
      else if (cue.affected_joints.length) counts.points++;
      else {
        counts.text++;
        expect(['reference_nearest', 'dynamic_reference', 'phase_duration', 'equipment_dependent'], c.criterion_id).toContain(c.evaluator.kind);
      }
    }
    // Compound shot drills now include their swing checks as well as recovery.
    expect(counts).toEqual({ segments: 671, points: 45, text: 225 + pack.criteria.filter((c: { evaluator: { kind: string } }) => c.evaluator.kind === 'dynamic_reference').length });
  });
  it('removes stale or invalid tracking overlays while preserving provisional metadata for text', () => {
    const tick = { timestamp_ms: 1000, quality: { ok: true, reasons: [] }, signal: { dropped: false, track_changed: false, time_gap: false }, features: [], temporal: null, guided_attempt: { phase_id: 'hold', since_ms: 0 }, assessment: { criteria: [evidence('left_knee_angle')], score: null, coverage: { ratio: 0.2 } }, feedback: null, suppressed_reason: null } as unknown as BrainTick;
    const state = createLegacyAdapterState();
    const first = toLegacyFrameAnalysis(tick, state, [], context);
    expect(first.visual_cues).toHaveLength(1);
    expect(first.issues[0].provisional).toBe(true);
    expect(toLegacyFrameAnalysis({ ...tick, assessment: null, timestamp_ms: 4000 }, state, [], context).visual_cues).toEqual([]);
    expect(toLegacyFrameAnalysis({ ...tick, assessment: null, timestamp_ms: 4000 }, state, [], context).issues).toEqual([]);
    expect(toLegacyFrameAnalysis({ ...tick, quality: { ok: false, reasons: [] } }, state, [], context).visual_cues).toEqual([]);
  });
  it('renders new static geometry after a frame gap but never old or track-changed evidence', () => {
    const c = evidence('left_knee_angle');
    c.evidence.frame_ids = [7];
    Object.assign(c, { meta: { current_observation: true, assessment_source: 'guided_attempt' } });
    const tick = { frame_id: 7, timestamp_ms: 1000, quality: { ok: true, reasons: [] }, signal: { dropped: false, track_changed: false, time_gap: true }, features: [], temporal: null, guided_attempt: { phase_id: 'hold', since_ms: 1000 }, assessment: { timestamp_ms: 1000, criteria: [c], score: null, coverage: { ratio: 0.2 } }, feedback: null, suppressed_reason: null } as unknown as BrainTick;
    const state = createLegacyAdapterState();
    expect(toLegacyFrameAnalysis(tick, state, [], context).visual_cues[0].state).toBe('IMPROVE');
    expect(toLegacyFrameAnalysis({ ...tick, frame_id: 8, timestamp_ms: 1500, assessment: null }, state, [], context).visual_cues).toEqual([]);
    expect(toLegacyFrameAnalysis({ ...tick, signal: { ...tick.signal, track_changed: true } }, createLegacyAdapterState(), [], context).visual_cues).toEqual([]);
  });
  it('keeps an earlier action correction in text without coloring the current ready posture red', () => {
    const old = { ...evidence('dominant_elbow_angle'), phase_id: 'swing' };
    const tick = { timestamp_ms: 1100, quality: { ok: true, reasons: [] }, signal: { dropped: false, track_changed: false, time_gap: false }, features: [], temporal: { phase_id: 'ready', state: 'EXECUTING' }, assessment: { criteria: [old], score: null, coverage: { ratio: 0.2 } }, feedback: null, suppressed_reason: null } as unknown as BrainTick;
    const result = toLegacyFrameAnalysis(tick, createLegacyAdapterState(), [], context);
    expect(result.issues[0].phase).toBe('swing');
    expect(result.visual_cues).toEqual([]);
    expect(toLegacyFrameAnalysis({ ...tick, guided_attempt: { phase_id: 'swing', since_ms: 1000, cue_allowed: false } }, createLegacyAdapterState(), [], context).visual_cues).toHaveLength(1);
  });
  it('retains completed attempt text only during the safe review interval and never projects it onto the body', () => {
    const old = { ...evidence('dominant_elbow_angle'), phase_id: 'swing', meta: { assessment_source: 'guided_attempt_completed' } };
    const tick = { timestamp_ms: 6000, quality: { ok: true, reasons: [] }, signal: { dropped: false, track_changed: false, time_gap: false }, features: [], temporal: { phase_id: 'swing', state: 'EXECUTING' }, guided_completion: { phase_id: 'swing' }, assessment: { criteria: [old], score: null, coverage: { ratio: 0.2 } }, feedback: null, suppressed_reason: null } as unknown as BrainTick;
    const result = toLegacyFrameAnalysis(tick, createLegacyAdapterState(), [], context);
    expect(result.issues).toHaveLength(1);
    expect(result.visual_cues).toEqual([]);
    expect(toLegacyFrameAnalysis({ ...tick, guided_completion: null }, createLegacyAdapterState(), [], context).issues).toEqual([]);
    expect(toLegacyFrameAnalysis({ ...tick, timestamp_ms: 10000 }, createLegacyAdapterState(), [], context).issues).toEqual([]);
  });
});
