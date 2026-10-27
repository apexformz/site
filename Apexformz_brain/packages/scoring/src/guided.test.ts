import { describe, expect, it } from 'vitest';
import type { CriterionDefinition, FeatureValue, PhaseGraph } from '@apexformz/contracts';
import type { TemporalUpdate } from '@apexformz/analysis';
import { CriterionEvaluator } from './evaluator';
import { DEFAULT_HUMAN_VARIANCE } from './variance';

function evaluator(aggregate: 'latest' | 'phase_min' | 'phase_max', kind: 'max_value' | 'max_abs' = 'max_value') {
  const c: CriterionDefinition = { criterion_id: 'depth', movement_id: 'm', phase_ids: ['action'], required_features: ['angle'],
    evaluator: { kind, limit: 150, aggregate }, view_constraints: 'any', missing_data_policy: 'not_assessable', severity: 'medium', weight: 1,
    expert_citation: { source: 'synthetic test only', status: 'approved' }, athlete_context: 'any', requires_capabilities: [], validation_status: 'approved', validation_version: '1', error_id: 'depth' };
  const graph: PhaseGraph = { id: 'g', movement_id: 'm', kind: 'dynamic_sequence', initial: 'ready', terminal: ['action'], validation_status: 'approved', edges: [], phases: [
    { id: 'action', name: 'Action', kind: 'action', enter: [], min_duration_ms: 20, hold_ms: 20, cue_allowed: false, contact_evidence: 'none' },
  ] };
  return new CriterionEvaluator([c], graph, { schema_version: '1.0.0', sport_id: 's', catalog_version: '1', default_locale: 'en', entries: [], generic: {} }, {
    session_id: 's', sport_pack_id: 's', sport_pack_version: '1', rubric_version: '1', view: 'front', athlete_context: 'unknown', capabilities_available: [],
    strict_rubrics: true, allow_draft_feedback: false, minimum_coverage: 0.6, human_variance: DEFAULT_HUMAN_VARIANCE, featureUnit: () => 'deg', guided_coaching: true,
  });
}
const update = (i: number): TemporalUpdate => ({ frame_id: i, timestamp_ms: i * 100, state: 'EXECUTING', previous_state: 'EXECUTING', movement_id: 'm', phase_id: 'action', previous_phase_id: null,
  phase_changed: false, phase_entered_ms: 0, phase_duration_ms: i * 100, ended_phase: null, execution_id: 'e', execution_started_ms: 0, completed: false, aborted_reason: null, unknown_reason: null,
  confidence: 1, evidence_frames: [i], execution_phases: [], cue_allowed: false, contact_evidence: 'none', events: [], blocked_reasons: [] });
const features = (i: number, value = 175) => new Map([['angle', { spec_id: 'angle', name: 'angle', value, unit: 'deg', valid: true, reason: null,
  evidence_frame_ids: [i], confidence: 1, view_applicability: 'any', coordinate_system: 'body_relative', timestamp_ms: i * 100 } as FeatureValue]]);

describe('dynamic guided assessment evidence boundaries', () => {
  it('does not call an unfinished descent too shallow before its phase minimum is known', () => {
    const scorer = evaluator('phase_min');
    for (let i = 0; i < 8; i++) expect(scorer.observe(update(i), features(i), true)).toBeNull();
    const end = { ...update(8), ended_phase: { phase_id: 'action', start_ms: 0, end_ms: 800, start_frame: 0, end_frame: 8 } };
    expect(scorer.observe(end, features(8, 120), true)?.criteria[0].state).toBe('PASS');
  });
  it('can issue a visual criterion verdict for a kinematic attempted phase without claiming execution quality', () => {
    const scorer = evaluator('latest');
    let assessment;
    for (let i = 0; i < 4; i++) assessment = scorer.observeGuided({ ...update(i), state: 'IDLE', phase_id: null, execution_id: null }, features(i), 'action', 0) ?? assessment;
    expect(assessment?.criteria[0].state).toBe('IMPROVE');
    expect(assessment?.score).toBeNull();
    expect(assessment?.execution_id).toBeNull();
    expect(assessment?.criteria[0]).toMatchObject({ meta: { assessment_source: 'guided_attempt', assumed_phase: true } });
  });
  it('does not apply a whole-phase rubric to an assumed incomplete action window', () => {
    const scorer = evaluator('phase_min');
    for (let i = 0; i < 20; i++) expect(scorer.observeGuided(update(i), features(i), 'action', 0)).toBeNull();
  });
  it('assesses a whole attempted phase only at its observed endpoint, with no score or completed rep', () => {
    const scorer = evaluator('phase_min');
    for (let i = 0; i < 7; i++) expect(scorer.observeGuided({ ...update(i), execution_id: null }, features(i), 'action', 0)).toBeNull();
    const assessment = scorer.completeGuided({ ...update(7), execution_id: null }, 'action', 0);
    expect(assessment?.criteria[0].state).toBe('IMPROVE');
    expect(assessment?.criteria[0].measurement.value).toBe(175);
    expect(assessment?.criteria[0]).toMatchObject({ meta: { assessment_source: 'guided_attempt_completed', assumed_phase: true } });
    expect(assessment?.score).toBeNull();
    expect(assessment?.execution_id).toBeNull();
    scorer.reset();
    expect(scorer.completeGuided(update(8), 'action', 0)).toBeNull();
  });

  it.each(['recognized', 'guided'])('reports an irreversible upper-bound violation during a %s action', mode => {
    const scorer = evaluator('phase_max', 'max_abs');
    let assessment;
    for (let i = 0; i < 4; i++) {
      const frame = features(i, i < 2 ? -175 : 120);
      assessment = (mode === 'guided' ? scorer.observeGuided(update(i), frame, 'action', 0) : scorer.observe(update(i), frame, true)) ?? assessment;
    }
    expect(assessment?.criteria[0].state).toBe('IMPROVE');
    expect(assessment?.criteria[0].measurement.value).toBe(-175);
    expect(assessment?.criteria[0]).toMatchObject({ meta: { partial_interval: true, monotonic_violation: true } });
  });

  it.each(['all-pass', 'one-noisy-peak', 'low-confidence'])('withholds incomplete peak verdicts for %s evidence', kind => {
    const scorer = evaluator('phase_max');
    for (let i = 0; i < 8; i++) {
      const frame = features(i, kind === 'all-pass' || kind === 'one-noisy-peak' && i > 0 ? 120 : 175);
      if (kind === 'low-confidence') frame.get('angle')!.confidence = .3;
      expect(scorer.observeGuided(update(i), frame, 'action', 0)).toBeNull();
    }
  });
});
