import { describe, expect, it } from 'vitest';
import type { CriterionDefinition, FeatureValue, PhaseGraph } from '@apexformz/contracts';
import type { TemporalUpdate } from '@apexformz/analysis';
import { CriterionEvaluator } from './evaluator';
import { DEFAULT_HUMAN_VARIANCE } from './variance';

describe('dynamic balance in both directions', () => {
  it.each([-45, 45])('retains a %s degree excursion when the athlete returns toward neutral', peak => {
    const criterion = { criterion_id: 'balance', movement_id: 'movement', phase_ids: ['action'], required_features: ['lean'],
      evaluator: { kind: 'max_abs', aggregate: 'phase_max', limit: 20, tolerance: 10 }, view_constraints: 'any',
      missing_data_policy: 'not_assessable', severity: 'low', weight: 1, athlete_context: 'any', requires_capabilities: [],
      validation_status: 'approved', validation_version: '1', error_id: 'balance', expert_citation: { source: 'test', status: 'approved' } } as CriterionDefinition;
    const graph = { id: 'graph', movement_id: 'movement', kind: 'dynamic_sequence', initial: 'action', terminal: [], edges: [], validation_status: 'approved',
      phases: [{ id: 'action', name: 'Action', kind: 'action', enter: [], hold_ms: 0, min_duration_ms: 0, contact_evidence: 'none' }] } as PhaseGraph;
    const scorer = new CriterionEvaluator([criterion], graph, { schema_version: '1.0.0', sport_id: 'sport', catalog_version: '1', default_locale: 'en', entries: [], generic: {} }, {
      session_id: 'session', sport_pack_id: 'sport', sport_pack_version: '1', rubric_version: '1', view: 'front', athlete_context: 'unknown',
      capabilities_available: [], strict_rubrics: true, allow_draft_feedback: false, minimum_coverage: .6,
      human_variance: DEFAULT_HUMAN_VARIANCE, featureUnit: () => 'deg', guided_coaching: true,
    });
    let update!: TemporalUpdate;
    [peak, peak / 3, peak / 9].forEach((value, i) => {
      update = { frame_id: i, timestamp_ms: i * 200, state: 'IDLE', previous_state: 'IDLE', movement_id: 'movement', phase_id: null,
        previous_phase_id: null, phase_changed: false, phase_entered_ms: null, phase_duration_ms: null, ended_phase: null, execution_id: null,
        execution_started_ms: null, completed: false, aborted_reason: null, unknown_reason: null, confidence: 0, evidence_frames: [i], execution_phases: [], cue_allowed: false, contact_evidence: 'none', events: [], blocked_reasons: [] };
      scorer.observeGuided(update, new Map([['lean', { spec_id: 'lean', name: 'lean', value, unit: 'deg', valid: true, reason: null,
        evidence_frame_ids: [i], confidence: 1, view_applicability: 'any', coordinate_system: 'body_relative', timestamp_ms: i * 200 } as FeatureValue]]), 'action', 0);
    });
    const result = scorer.completeGuided({ ...update, timestamp_ms: 600 }, 'action', 0);
    expect(result?.criteria[0].state).toBe('IMPROVE');
    expect(result?.criteria[0].measurement.value).toBe(peak);
    expect(result?.score).toBeNull();
  });
});
