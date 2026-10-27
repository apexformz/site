import { describe, expect, it } from 'vitest';
import { assertValid, type CriterionDefinition, type DynamicReferenceModel, type FeedbackTemplates } from '@apexformz/contracts';
import { CoachingPolicy } from '@apexformz/coaching';
import type { DynamicReferenceComparison } from '@apexformz/scoring';
import { dynamicReferenceAssessment, type DynamicReferenceAssessmentContext } from './dynamic_reference_assessment';

const feature = 'dynamic_ref_left_knee_angle';
const model = { references: [{ id: 'recorded', complete_capture: true }], unsupported_reasons: [] } as unknown as DynamicReferenceModel;
const definition = (id: string | null): CriterionDefinition => ({
  criterion_id: `test.swing.dynamic_reference.${id ?? 'sequence'}`, movement_id: 'test.swing', phase_ids: null,
  required_features: id ? [id] : [feature], evaluator: { kind: 'dynamic_reference', params: { reference_feature: id } },
  view_constraints: 'any', missing_data_policy: 'not_assessable', severity: 'medium', weight: 1,
  expert_citation: { source: 'test', status: 'provisional' }, athlete_context: 'any', requires_capabilities: ['body_pose'],
  validation_status: 'provisional', validation_version: '1', error_id: `test.cue.${id ?? 'sequence'}`,
});
const definitions = [definition(null), definition(feature)];
const context: DynamicReferenceAssessmentContext = { session_id: 'session', sport_pack_id: 'test', sport_pack_version: '1.0.0', rubric_version: '1.0.0', movement_id: 'test.swing', view: 'front', strict: false, allow_draft_feedback: true };
function comparison(overrides: Partial<DynamicReferenceComparison> = {}): DynamicReferenceComparison {
  return {
    attempt_id: 'attempt-1', status: 'active', state: 'IMPROVE', progress: 0.5, reference_id: 'recorded', confidence: 0.85,
    distance: 0.8, coverage: 1, current: true, completed: false, segment_matched: false, cue_allowed: false,
    since_ms: 0, timestamp_ms: 1000, frame_id: 10, evidence_frames: [8, 9, 10], reason: null,
    sequence_mismatch: false, alignment_ambiguous: false,
    deviations: [{ feature_id: feature, observed: 170, reference: 120, unit: 'deg', tolerance: 18, normalized_error: 50 / 18,
      weighted_squared_contribution: (50 / 18) ** 2, outside_reference_band: true }], ...overrides,
  };
}
const assess = (result = comparison(), ctx = context) => dynamicReferenceAssessment(result, model, definitions, ctx, result.frame_id, result.timestamp_ms);

describe('dynamic reference evidence and spoken corrections', () => {
  it('retains body localization and exact correction with no fabricated execution score', () => {
    const a = assess();
    assertValid('assessmentSet', a);
    expect(a.execution_id).toBeNull();
    expect(a.score).toBeNull();
    expect(a.criteria[1].state).toBe('IMPROVE');
    expect(a.criteria[1].evidence.feature_ids).toEqual([feature]);
    expect(a.criteria[1].feedback?.cue).toContain('Bend your left knee');
    expect(a.criteria[1].feedback?.rationale).toContain('middle part');
  });
  it('withholds provisional verdicts and cues in reviewed mode', () => {
    const a = assess(comparison(), { ...context, strict: true, allow_draft_feedback: false });
    expect(a.criteria.every(c => c.state === 'UNCERTAIN' && c.measurement.reason === 'RUBRIC_UNVALIDATED' && c.feedback === null)).toBe(true);
  });
  it('reports unavailable view and never creates local fault from ambiguous alignment', () => {
    expect(assess(comparison({ status: 'unavailable', reason: 'VIEW_INVALID', deviations: [] })).criteria.every(c => c.state === 'NOT_ASSESSABLE')).toBe(true);
    const a = assess(comparison({ alignment_ambiguous: true, confidence: 0.3, sequence_mismatch: true }));
    expect(a.criteria[0].state).toBe('IMPROVE');
    expect(a.criteria[0].evidence.feature_ids).toEqual([]);
    expect(a.criteria[1].state).toBe('UNCERTAIN');
  });
  it('records an observed part in range without claiming a complete sequence', () => {
    const r = comparison({ status: 'incomplete', state: 'UNCERTAIN', current: false, segment_matched: true,
      reason: 'COVERAGE_INSUFFICIENT', deviations: [{ ...comparison().deviations[0], observed: 122, normalized_error: 2 / 18, outside_reference_band: false }] });
    const a = assess(r);
    expect(a.criteria[0].state).toBe('UNCERTAIN');
    expect(a.criteria[1].state).toBe('PASS');
    expect((a.criteria[1] as any).meta.assessment_source).toBe('dynamic_reference_completed');
  });
  it('speaks original measured text after waiting for a fresh safe pause', () => {
    const templates: FeedbackTemplates = { schema_version: '1.0.0', sport_id: 'test', catalog_version: '1', default_locale: 'en', generic: {},
      entries: definitions.map(d => ({ error_id: d.error_id, cue: { en: 'Generic reference cue.' }, rationale: { en: 'Generic rationale.' }, review_status: 'draft', cooldown_ms: 1000, persistence_count: 2, severity: 'medium' })),
      policy: { global_min_interval_ms: 100 } };
    const p = new CoachingPolicy(templates, { session_id: 'session', sport_pack_id: 'test', sport_pack_version: '1', allow_draft_cues: true, deferred_cue_max_age_ms: 8000 });
    const input = (a: ReturnType<typeof assess> | null, t: number, safe: boolean) => ({ timestamp_ms: t, frame_id: t, assessment: a, quality_ok: true, quality_reasons: [], cue_allowed: safe, recognition_state: 'IDLE' as const, movement_id: 'test.swing', evidence_scope: 'attempt-1', deferred_cue_allowed: safe });
    expect(p.decide(input(assess(), 1000, false))).toBeNull();
    expect(p.decide(input(assess(comparison({ timestamp_ms: 1200, frame_id: 12, evidence_frames: [10, 11, 12] })), 1200, false))).toBeNull();
    expect(p.decide(input(null, 1300, false))).toBeNull();
    const cue = p.decide(input(null, 1600, true));
    expect(cue?.text).toBe('For your next attempt: Bend your left knee more toward the recorded movement.');
    expect(cue?.rationale).toContain('middle part');
  });
});
