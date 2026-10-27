import { describe, expect, it } from 'vitest';
import type { AssessmentSet, CriterionDefinition, FeatureValue } from '@apexformz/contracts';
import type { TemporalUpdate } from '@apexformz/analysis';
import { CriterionEvaluator } from './evaluator';
import { DEFAULT_HUMAN_VARIANCE } from './variance';

function assess(kind: 'max_value' | 'reference_nearest', validFrames: number, options: { omitInvalid?: boolean; badQualityFrames?: number; minConfidence?: number } = {}) {
  const criterion: CriterionDefinition = {
    criterion_id: 'c', movement_id: 'm', phase_ids: ['hold'], required_features: ['angle'],
    evaluator: { kind, limit: 100, model_reference: 'ref', min_confidence: options.minConfidence ?? 0.7 },
    view_constraints: 'any', missing_data_policy: 'not_assessable', severity: 'low', weight: 1,
    expert_citation: { source: 'synthetic test', status: 'approved' }, athlete_context: 'any', requires_capabilities: [],
    validation_status: 'approved', validation_version: '1', error_id: 'c',
  };
  const evaluator = new CriterionEvaluator([criterion],
    { id: 'g', movement_id: 'm', kind: 'static_hold', phases: [], edges: [], initial: 'hold', terminal: ['hold'], validation_status: 'approved' },
    { schema_version: '1.0.0', sport_id: 's', catalog_version: '1', default_locale: 'en', entries: [], generic: {} },
    { session_id: 's', sport_pack_id: 's', sport_pack_version: '1', rubric_version: '1', view: 'front', athlete_context: 'unknown',
      capabilities_available: [], strict_rubrics: true, allow_draft_feedback: false, minimum_coverage: 0.6,
      human_variance: DEFAULT_HUMAN_VARIANCE, featureUnit: () => 'deg', live_interval_ms: 1,
      models: { ref: { features: ['angle'], reference_vectors: [[90]], threshold: 5, tolerance: 5, unit: 'deg', validation_status: 'approved' } } });
  let output: AssessmentSet | null = null;
  for (let i = 0; i < 100; i++) {
    const update: TemporalUpdate = {
      frame_id: i, timestamp_ms: i * 40, state: 'CONFIRMED', previous_state: 'CONFIRMED', movement_id: 'm', phase_id: 'hold',
      previous_phase_id: null, phase_changed: false, phase_entered_ms: 0, phase_duration_ms: i * 40, ended_phase: null,
      execution_id: 'e', execution_started_ms: 0, completed: false, aborted_reason: null, unknown_reason: null, confidence: 1,
      evidence_frames: [i], execution_phases: [], cue_allowed: true, contact_evidence: 'none', events: [], blocked_reasons: [],
    };
    const valid = i < validFrames;
    const feature: FeatureValue = { spec_id: 'angle', name: 'angle', value: valid ? 90 : null, unit: 'deg', valid,
      reason: valid ? null : 'DEGENERATE_GEOMETRY', evidence_frame_ids: [i], confidence: valid ? 1 : 0,
      view_applicability: 'any', coordinate_system: 'body_relative', timestamp_ms: i * 40 };
    output = evaluator.observe(update, new Map(valid || !options.omitInvalid ? [['angle', feature]] : []), i >= (options.badQualityFrames ?? 0), ['LOW_CONFIDENCE']);
  }
  return output!;
}

describe.each(['max_value', 'reference_nearest'] as const)('%s evidence coverage gates', (kind) => {
  it('one valid frame out of 100 cannot become a PASS or contribute to aggregate score coverage', () => {
    const result = assess(kind, 1);
    expect(result.criteria[0].state).toBe('UNCERTAIN');
    expect(result.criteria[0].measurement.reason).toBe('LOW_CONFIDENCE');
    expect(result.criteria[0].score).toBeNull();
    expect(result.score).toBeNull();
    expect(result.coverage).toMatchObject({ evaluated: 0, required: 1, ratio: 0 });
  });
  it('counts entirely omitted feature rows as missing evidence too', () => {
    expect(assess(kind, 1, { omitInvalid: true }).criteria[0].state).toBe('UNCERTAIN');
  });
  it('accepts sufficient evidence using the existing declared confidence threshold', () => {
    const result = assess(kind, 80);
    expect(result.criteria[0].state).toBe('PASS');
    expect(result.criteria[0].confidence.assessment).toBeCloseTo(0.8);
    expect(result.coverage.ratio).toBe(1);
  });
  it('retains the typed missing-data abstention when there are no usable feature samples', () => {
    const result = assess(kind, 0);
    expect(result.criteria[0].state).toBe('NOT_ASSESSABLE');
    expect(result.score).toBeNull();
  });
  it('includes window-level pose quality in the same declared threshold', () => {
    expect(assess(kind, 100, { badQualityFrames: 10, minConfidence: 0.95 }).criteria[0].measurement.reason).toBe('LOW_CONFIDENCE');
  });
});
