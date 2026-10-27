import { describe, expect, it } from 'vitest';
import { SESSION_REVIEW_MAX_CRITERIA, type AssessmentSet, type CriterionEvidence, type FeatureSpec } from '@apexformz/contracts';
import { createTechniqueReview, recordTechniqueAssessment, reviewFromLastAssessment, reviewMissingExplanation, sessionReviewPresentation } from './sessionTechniqueReview';

const criterion = (state: CriterionEvidence['state'], time: number, extra: Partial<CriterionEvidence> = {}): CriterionEvidence => ({
  criterion_id: 'squash.dynamic.0040.lunge', movement_id: 'squash.dynamic.0040', phase_id: 'swing', timestamp_ms: time, state, score: null,
  measurement: { value: state === 'NOT_ASSESSABLE' ? null : 160, unit: 'deg', reason: state === 'NOT_ASSESSABLE' ? 'VIEW_INVALID' : null, feature_id: 'knee_angle' },
  confidence: { movement: null, assessment: .9 }, evidence: { frame_ids: [1], view: 'front', feature_ids: ['knee_angle'] },
  feedback: state === 'IMPROVE' ? { error_id: 'bend_knee', cue: 'Bend your lead knee more.', rationale: 'Lower into the shot.' } : null,
  provenance: { sport_pack: 'squash', rubric: '1', validation_status: 'provisional', provisional: true, evaluator: 'range' }, ...extra,
});
const assessment = (criteria: CriterionEvidence[], time = criteria[0]?.timestamp_ms ?? 0): AssessmentSet => ({ session_id: 's1', movement_id: 'squash.dynamic.0040', event_id: `e${time}`, timestamp_ms: time, phase_id: 'swing', criteria } as AssessmentSet);
const context = { featureSpecs: [{ id: 'knee_angle', kind: 'angle_at', params: { a: 'left_hip', b: 'left_knee', c: 'left_ankle' }, version: '1', coordinate_system: 'body_relative', view_applicability: 'any' } as FeatureSpec] };

describe('bounded session technique review', () => {
  it('saves dynamic reference corrections, their movement timing, later improvement and missing-reference explanations', () => {
    const make = (state: CriterionEvidence['state'], time: number) => ({ ...criterion(state, time), criterion_id: 'squash.dynamic.0040.dynamic_reference.dynamic_ref_left_knee_angle', phase_id: null,
      measurement: { value: state === 'NOT_ASSESSABLE' ? null : 35, unit: 'deg', feature_id: 'dynamic_ref_left_knee_angle', reason: state === 'NOT_ASSESSABLE' ? 'VIEW_INVALID' : null },
      provenance: { ...criterion(state, time).provenance, evaluator: 'dynamic_reference' },
      feedback: state === 'IMPROVE' ? { error_id: 'reference', cue: 'Bend your left knee toward the recorded position.', rationale: 'Measured during the middle of the recorded movement.' } : null,
      meta: { assessment_source: 'dynamic_reference_completed', reference_deviations: [{ feature_id: 'dynamic_ref_left_knee_angle', observed: 170, reference: 135, unit: 'deg', weighted_squared_contribution: 1225, outside_reference_band: true }] },
    } as unknown as CriterionEvidence);
    const ctx = { featureSpecs: [{ ...context.featureSpecs[0], id: 'dynamic_ref_left_knee_angle' }] };
    const accumulator = createTechniqueReview('s1', 'squash.dynamic.0040');
    for (const [state, time] of [['IMPROVE', 100], ['PASS', 200], ['NOT_ASSESSABLE', 300]] as const) recordTechniqueAssessment(accumulator, { ...assessment([make(state, time)]), phase_id: null }, ctx);
    const saved = JSON.parse(JSON.stringify(accumulator.review));
    expect(saved.criteria[0]).toMatchObject({ name: 'Left knee bend compared with recording', state_counts: { IMPROVE: 1, PASS: 1, NOT_ASSESSABLE: 1 },
      latest_correction: { correction: 'Bend your left knee toward the recorded position.', rationale: 'Measured during the middle of the recorded movement.', source: 'attempt_review', body_areas: ['left hip', 'left knee', 'left ankle'] }, latest_measured: { state: 'PASS' } });
    expect(reviewMissingExplanation(saved.criteria[0].latest_unassessed)).toContain('available recorded views');
    expect(JSON.stringify(saved)).not.toMatch(/reference_deviations|landmarks|source_pose|frame_ids/);
  });
  it('retains earlier instructions and in-range evidence through uncertain and empty tail assessments', () => {
    const accumulator = createTechniqueReview('s1', 'squash.dynamic.0040');
    recordTechniqueAssessment(accumulator, assessment([criterion('IMPROVE', 100)]), context);
    recordTechniqueAssessment(accumulator, assessment([criterion('PASS', 200)]), context);
    recordTechniqueAssessment(accumulator, assessment([criterion('NOT_ASSESSABLE', 300)]), context);
    recordTechniqueAssessment(accumulator, assessment([], 400), context);
    expect(accumulator.review).toMatchObject({ assessments_observed: 4, nonempty_assessments: 3, phases: ['swing'] });
    expect(accumulator.review.criteria[0]).toMatchObject({ observations: 3, state_counts: { IMPROVE: 1, PASS: 1, NOT_ASSESSABLE: 1 },
      first_measured: { state: 'IMPROVE' }, latest_measured: { state: 'PASS' }, latest_correction: { correction: 'Bend your lead knee more.', body_areas: ['left_hip'.replace(/_/g, ' '), 'left knee', 'left ankle'] }, latest_unassessed: { reason: 'VIEW_INVALID' } });
    expect(reviewMissingExplanation(accumulator.review.criteria[0].latest_unassessed!)).toContain('camera view');
    expect(JSON.stringify(accumulator.review)).not.toMatch(/frame_ids|landmarks|confidence|evidence/);
  });
  it('deduplicates worker delivery and rejects another session or movement', () => {
    const accumulator = createTechniqueReview('s1', 'squash.dynamic.0040');
    const a = assessment([criterion('PASS', 100)]);
    for (const candidate of [a, a, { ...a, session_id: 'other' }, { ...a, movement_id: 'other' }]) recordTechniqueAssessment(accumulator, candidate);
    expect(accumulator.review.assessments_observed).toBe(1);
    expect(accumulator.review.criteria[0].observations).toBe(1);
  });
  it('bounds retained criterion and dedup history storage', () => {
    const accumulator = createTechniqueReview('s1', 'squash.dynamic.0040');
    for (let time = 1; time <= 600; time++) recordTechniqueAssessment(accumulator, assessment([criterion('PASS', time, { criterion_id: `criterion-${time}` })]));
    expect(accumulator.review.criteria).toHaveLength(SESSION_REVIEW_MAX_CRITERIA);
    expect(accumulator.seen.size).toBe(512);
    expect(accumulator.criterionSeen.size).toBe(SESSION_REVIEW_MAX_CRITERIA);
  });
  it('does not recount phase evidence repeated in a later complete-execution assessment', () => {
    const accumulator = createTechniqueReview('s1', 'squash.dynamic.0040');
    const first = criterion('IMPROVE', 100);
    recordTechniqueAssessment(accumulator, assessment([first], 100));
    recordTechniqueAssessment(accumulator, assessment([criterion('PASS', 200)], 200));
    recordTechniqueAssessment(accumulator, assessment([first], 300));
    recordTechniqueAssessment(accumulator, { ...assessment([criterion('PASS', 200)], 400), event_id: 'completed-execution' });
    expect(accumulator.review.criteria[0]).toMatchObject({ observations: 2, state_counts: { IMPROVE: 1, PASS: 1 }, latest_measured: { state: 'PASS', timestamp_ms: 200 } });
  });
  it('keeps phase-specific evidence and marks historical snapshots without inventing a verdict', () => {
    const original = assessment([criterion('NOT_ASSESSABLE', 100)]);
    const review = reviewFromLastAssessment(original)!;
    expect(review.criteria[0].latest_measured).toBeNull();
    expect(review.criteria[0].latest_correction).toBeNull();
    const accumulator = createTechniqueReview('s1', 'squash.dynamic.0040');
    recordTechniqueAssessment(accumulator, original);
    recordTechniqueAssessment(accumulator, assessment([criterion('PASS', 200, { phase_id: 'recovery' })]));
    expect(accumulator.review.criteria).toHaveLength(2);
  });
  it('shows never-measured checks as missing, summarizes historical abstentions, and excludes inactive planned templates', () => {
    const measuredId = 'squash.dynamic.0040.dynamic_reference.dynamic_ref_left_knee_angle';
    const missingId = 'squash.dynamic.0040.dynamic_reference.sequence';
    const absentId = 'squash.dynamic.0040.dynamic_reference.dynamic_ref_head_x';
    const accumulator = createTechniqueReview('s1', 'squash.dynamic.0040', [
      { criterion_id: measuredId, name: 'Knee' }, { criterion_id: missingId, name: 'Sequence' },
      { criterion_id: absentId, name: 'Head' }, { criterion_id: 'squash.dynamic.0040.generic_template', name: 'Inactive generic check' },
    ]);
    for (const [state, time] of [['UNCERTAIN', 100], ['IMPROVE', 200], ['PASS', 300], ['NOT_ASSESSABLE', 400]] as const) {
      recordTechniqueAssessment(accumulator, assessment([criterion(state, time, { criterion_id: measuredId })]));
    }
    recordTechniqueAssessment(accumulator, assessment([criterion('NOT_ASSESSABLE', 500, { criterion_id: missingId })]));
    const view = sessionReviewPresentation(accumulator.review);
    expect(view).toMatchObject({ receivedCount: 2, measuredCount: 1, withheldMeasuredChecks: 1, withheldMeasuredObservations: 2 });
    expect(view.corrections.map(c => c.criterion_id)).toEqual([measuredId]);
    expect(view.passed.map(c => c.criterion_id)).toEqual([measuredId]);
    expect(view.passed[0].latest_measured?.timestamp_ms).toBeGreaterThan(view.corrections[0].latest_correction!.timestamp_ms);
    expect(view.missing.map(c => c.criterion_id)).toEqual([missingId]);
    expect(view.unobserved.map(c => c.criterion_id)).toEqual([absentId]);
    // Presentation does not erase historical withheld observations or earlier corrections.
    expect(accumulator.review.criteria[0].state_counts.NOT_ASSESSABLE).toBe(1);
    expect(accumulator.review.planned_checks).toHaveLength(4);
  });
});
