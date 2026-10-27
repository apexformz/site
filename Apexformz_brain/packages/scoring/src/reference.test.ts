import { describe, expect, it } from 'vitest';
import type { CriterionDefinition, FeedbackTemplates, PhaseGraph } from '@apexformz/contracts';
import type { TemporalUpdate } from '@apexformz/analysis';
import type { FeatureMap } from '@apexformz/features';
import { CriterionEvaluator, type ReferenceSetModel, type ScoringContext } from './evaluator';
import { DEFAULT_HUMAN_VARIANCE } from './variance';
import { readFileSync } from 'node:fs';

const graph: PhaseGraph = { id: 'g', movement_id: 'm', kind: 'static_hold', phases: [], edges: [], initial: 'hold', terminal: ['hold'], validation_status: 'approved' };
const feedback: FeedbackTemplates = { schema_version: '1.0.0', sport_id: 'test', catalog_version: '1', default_locale: 'en', entries: [], generic: {} };
const criterion: CriterionDefinition = {
  criterion_id: 'reference', movement_id: 'm', phase_ids: ['hold'], required_features: ['dominant_elbow_angle'],
  evaluator: { kind: 'reference_nearest', model_reference: 'ref', min_confidence: 0.7 },
  view_constraints: 'any', missing_data_policy: 'not_assessable', severity: 'low', weight: 1,
  expert_citation: { source: 'synthetic test', status: 'approved' }, athlete_context: 'any', requires_capabilities: [],
  validation_status: 'approved', validation_version: '1', error_id: 'error',
};
const base: ReferenceSetModel = { features: ['dominant_elbow_angle'], reference_vectors: [[10], [90]], threshold: 5, tolerance: 5 };
function assess(model: ReferenceSetModel, confidence = 0.95, context: Partial<ScoringContext> = {}, values: Record<string, number> = { dominant_elbow_angle: 10 }, additional: CriterionDefinition[] = []) {
  const evaluator = new CriterionEvaluator([{ ...criterion, required_features: model.features }, ...additional], graph, feedback, {
    session_id: 's', sport_pack_id: 'test', sport_pack_version: '1', rubric_version: '1',
    view: 'front', athlete_context: 'unknown', capabilities_available: [], strict_rubrics: false,
    allow_draft_feedback: false, minimum_coverage: 0.6, human_variance: DEFAULT_HUMAN_VARIANCE,
    featureUnit: () => 'deg', models: { ref: model }, ...context,
  });
  const update: TemporalUpdate = {
    frame_id: 1, timestamp_ms: 0, state: 'CONFIRMED', previous_state: 'CONFIRMED', movement_id: 'm',
    phase_id: 'hold', previous_phase_id: null, phase_changed: false, phase_entered_ms: 0, phase_duration_ms: 0,
    ended_phase: null, execution_id: 'e', execution_started_ms: 0, completed: false, aborted_reason: null,
    unknown_reason: null, confidence: 1, evidence_frames: [1], execution_phases: [], cue_allowed: true,
    contact_evidence: 'none', events: [], blocked_reasons: [],
  };
  const features: FeatureMap = new Map(Object.entries(values).map(([id, value]) => [id, {
    spec_id: id, name: 'angle', value, unit: 'deg' as const, valid: true,
    evidence_frame_ids: [1], confidence, view_applicability: 'any', coordinate_system: 'body_relative', timestamp_ms: 0,
  }]));
  return evaluator.observe(update, features, true)!.criteria[0];
}

describe('reference assessment metadata and evidence gates', () => {
  it('keeps legacy reference models without view metadata compatible', () => {
    expect(assess(base).state).toBe('PASS');
  });
  it('cannot select a perfect match from the wrong camera and retains the angular unit', () => {
    const result = assess({ ...base, reference_views: ['back', 'front'], unit: 'deg' });
    expect(result.state).toBe('IMPROVE');
    expect(result.measurement.value).toBe(80);
    expect(result.measurement.unit).toBe('deg');
    expect((result as unknown as { meta: Record<string, unknown> }).meta).toMatchObject({
      reference_index: 1, reference_view: 'front',
      reference_deviations: [{ feature_id: 'dominant_elbow_angle', observed: 10, reference: 90, delta: -80, outside_reference_band: true }],
    });
  });
  it('abstains when the current view has no reference, including unknown camera view', () => {
    expect(assess({ ...base, reference_views: ['back', 'right'] }).measurement.reason).toBe('VIEW_INVALID');
    expect(assess({ ...base, reference_views: ['unknown', 'front'] }, 0.95, { view: 'unknown' }).measurement.reason).toBe('VIEW_INVALID');
  });
  it('rejects misaligned reference metadata instead of silently ignoring it', () => {
    expect(assess({ ...base, reference_views: ['front'] }).measurement.reason).toBe('MODEL_UNAVAILABLE');
  });
  it('abstains on low-confidence feature evidence even for an exact reference match', () => {
    expect(assess(base, 0.1).measurement.reason).toBe('LOW_CONFIDENCE');
    expect(assess(base, 0.1).score).toBeNull();
  });
  it('never treats unknown or assumed source handedness as a verified dominant-side reference', () => {
    expect(assess({ ...base, reference_handedness: ['unknown', 'unknown'], reference_handedness_assumed: [false, false] }).measurement.reason).toBe('HANDEDNESS_UNKNOWN');
    expect(assess({ ...base, reference_handedness: ['right', 'left'], reference_handedness_assumed: [true, true] }).measurement.reason).toBe('HANDEDNESS_UNKNOWN');
    expect(assess({ ...base, reference_handedness: ['right', 'left'], reference_handedness_assumed: [false, false] }).state).toBe('PASS');
  });
  it('strict mode also checks reference-model approval, independently of criterion approval', () => {
    expect(assess({ ...base, validation_status: 'provisional' }, 0.95, { strict_rubrics: true }).measurement.reason).toBe('RUBRIC_UNVALIDATED');
  });
  it('preserves reference-model provisional status even when its criterion was approved', () => {
    expect(assess({ ...base, validation_status: 'provisional' }).provenance.provisional).toBe(true);
  });
  it('uses the same human-variance allowance for localized contributors and the whole reference verdict', () => {
    const result = assess({ ...base, reference_vectors: [[18]], unit: 'deg' }, 0.95, {
      human_variance: { ...DEFAULT_HUMAN_VARIANCE, measurement_floor: { deg: 2 } },
    });
    expect(result.state).toBe('UNCERTAIN');
    expect(result.measurement.reason).toBe('WITHIN_NORMAL_VARIANCE');
    expect((result as unknown as { meta: Record<string, unknown> }).meta.reference_deviations).toMatchObject([
      { absolute_delta: 8, localization_threshold: 10, outside_reference_band: false },
    ]);
  });
  it('does not claim localization when reference and feature units are not comparable', () => {
    const result = assess({ ...base, reference_vectors: [[90]] });
    expect(result.state).toBe('IMPROVE');
    expect((result as unknown as { meta: Record<string, unknown> }).meta.reference_deviations).toMatchObject([
      { outside_reference_band: false },
    ]);
  });
  it('retains only finite weighted residuals of the selected nearest reference', () => {
    const model: ReferenceSetModel = { features: ['a', 'b', 'c'], reference_vectors: [[10, null, 50], [20, 20, 60]], weights: [1, 1, 0], unit: 'deg', threshold: 5 };
    const result = assess(model, 0.95, {}, { a: 10, b: 100, c: 999 });
    expect(result.state).toBe('PASS');
    expect((result as unknown as { meta: Record<string, unknown> }).meta.reference_deviations).toEqual([
      { feature_id: 'a', observed: 10, reference: 10, delta: 0, absolute_delta: 0, weight: 1, weighted_squared_contribution: 0, unit: 'deg', localization_threshold: 5, outside_reference_band: false, constraint_conflict: false, conflicting_criteria: [] },
    ]);
  });
  it.each([
    ['raised arms', { dominant_arm_elevation: 160, nondominant_arm_elevation: 160 }, ['dominant_arm_elevation', 'nondominant_arm_elevation']],
    ['deep knee bend', { left_knee_angle: 90, right_knee_angle: 90 }, ['left_knee_angle', 'right_knee_angle']],
    ['straight arms', { dominant_elbow_angle: 180, nondominant_elbow_angle: 180 }, ['dominant_elbow_angle', 'nondominant_elbow_angle']],
  ] as const)('localizes %s against the actual ready-stance reference without marking unchanged body parts', (_name, changed, expected) => {
    const model = JSON.parse(readFileSync(new URL('../../../sport-packs/squash/models/reference/squash.static.0001.json', import.meta.url), 'utf8')) as ReferenceSetModel;
    const values = Object.fromEntries(model.features.map((id, index) => [id, model.reference_vectors[1][index] as number]));
    const result = assess(model, 0.95, { human_variance: { ...DEFAULT_HUMAN_VARIANCE, relative: 0.05, measurement_floor: { deg: 2 } } }, { ...values, ...changed });
    expect(result.state).toBe('IMPROVE');
    expect(result.provenance.provisional).toBe(true);
    const deviations = (result as unknown as { meta: { reference_deviations: Array<{ feature_id: string; outside_reference_band: boolean }> } }).meta.reference_deviations;
    expect(deviations.filter(d => d.outside_reference_band).map(d => d.feature_id).sort()).toEqual([...expected].sort());
  });
  it('withholds a reference knee target rejected by the same-phase scalar rubric while preserving arm evidence', () => {
    const model: ReferenceSetModel = { features: ['left_knee_angle', 'right_knee_angle', 'dominant_elbow_angle'], reference_vectors: [[176.1, 173.1, 93]], unit: 'deg', threshold: 15, tolerance: 10 };
    const limit: CriterionDefinition = { ...criterion, criterion_id: 'knees', required_features: ['max_knee_angle'], evaluator: { kind: 'max_value', limit: 165, tolerance: 8 } };
    const feature_specs: NonNullable<ScoringContext['feature_specs']> = [{ id: 'max_knee_angle', kind: 'max_of', params: { features: ['left_knee_angle', 'right_knee_angle'] }, unit: 'deg', coordinate_system: 'body_relative', view_applicability: 'any', version: '1' }];
    const result = assess(model, 0.95, { feature_specs, human_variance: { ...DEFAULT_HUMAN_VARIANCE, relative: 0.05, measurement_floor: { deg: 5 } } }, { left_knee_angle: 90, right_knee_angle: 90, max_knee_angle: 90, dominant_elbow_angle: 180 }, [limit]);
    const deviations = (result as unknown as { meta: { reference_deviations: Array<{ feature_id: string; constraint_conflict: boolean; conflicting_criteria: string[] }> } }).meta.reference_deviations;
    expect(deviations.filter(d => d.constraint_conflict).map(d => d.feature_id).sort()).toEqual(['left_knee_angle', 'right_knee_angle']);
    expect(deviations.find(d => d.feature_id === 'dominant_elbow_angle')?.constraint_conflict).toBe(false);
    expect(deviations.find(d => d.feature_id === 'left_knee_angle')?.conflicting_criteria).toEqual(['knees']);
    const allConflicted = assess(model, 0.95, { feature_specs, human_variance: { ...DEFAULT_HUMAN_VARIANCE, relative: 0.05, measurement_floor: { deg: 5 } } }, { left_knee_angle: 90, right_knee_angle: 90, max_knee_angle: 90, dominant_elbow_angle: 93 }, [limit]);
    expect(allConflicted.state).toBe('UNCERTAIN');
    expect(allConflicted.measurement.reason).toBe('CONTRADICTORY_EVIDENCE');
    expect(allConflicted.measurement.value).toBeGreaterThan(25);
    expect(allConflicted.feedback).toBeNull();
    expect(allConflicted.score).toBeNull();
    const unrelated = assess(model, 0.95, { feature_specs }, { left_knee_angle: 90, right_knee_angle: 90, max_knee_angle: 90, dominant_elbow_angle: 180 }, [{ ...limit, phase_ids: ['other'] }, { ...limit, criterion_id: 'side-view-only', view_constraints: ['left'] }]);
    expect((unrelated as unknown as { meta: { reference_deviations: Array<{ constraint_conflict: boolean }> } }).meta.reference_deviations.every(d => !d.constraint_conflict)).toBe(true);
  });
});
