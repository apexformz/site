/** Read-only rubric/reference consistency audit; this does not validate human technique. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CriterionDefinition, FeatureSpec, FeatureValue, PhaseGraph, ViewLabel } from '@apexformz/contracts';
import type { TemporalUpdate } from '@apexformz/analysis';
import { CriterionEvaluator, mergeHumanVariance, type ReferenceSetModel } from '@apexformz/scoring';

const root = process.cwd();
const packPath = path.join(root, 'sport-packs/squash');
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(packPath, p), 'utf8'));
const rubric = read('technique_criteria.json');
const graphs = read('phase_graphs.json').graphs as PhaseGraph[];
const movements = read('movement_catalog.json').movements;
const feedback = read('feedback_templates.json');
const specs = new Map<string, FeatureSpec>(rubric.features.map((f: FeatureSpec) => [f.id, f]));
const models: Record<string, ReferenceSetModel> = {};
for (const item of read('manifest.json').models) if (item.role === 'reference_set') models[item.path] = read(item.path);
const checks: Array<Record<string, unknown>> = [];
const referenceRows: Array<Record<string, unknown>> = [];
const criteria = rubric.criteria as CriterionDefinition[];

for (const [modelPath, model] of Object.entries(models)) {
  const movementId = path.basename(modelPath, '.json');
  const graph = graphs.find(g => g.movement_id === movementId)!;
  const movement = movements.find((m: { id: string }) => m.id === movementId);
  const movementCriteria = criteria.filter(c => c.movement_id === movementId);
  model.reference_vectors.forEach((vector, index) => {
    const view = model.reference_views?.[index] ?? 'unknown';
    const values = new Map(model.features.flatMap((id, i) => vector[i] === null ? [] : [[id, vector[i]!] as const]));
    // Only derive declared min/max aliases when all dependencies are present.
    for (let pass = 0; pass < specs.size; pass++) {
      let added = 0;
      for (const f of specs.values()) {
        const deps = f.params.features;
        if (values.has(f.id) || !['min_of', 'max_of'].includes(f.kind) || !Array.isArray(deps) || !deps.length || !deps.every(id => typeof id === 'string' && values.has(id))) continue;
        const input = deps.map(id => values.get(id as string)!);
        values.set(f.id, f.kind === 'min_of' ? Math.min(...input) : Math.max(...input)); added++;
      }
      if (!added) break;
    }
    const features = new Map<string, FeatureValue>([...values].map(([id, value]) => [id, {
      spec_id: id, name: id, value, unit: specs.get(id)?.unit ?? 'none', valid: true, confidence: 1,
      evidence_frame_ids: [1], view_applicability: specs.get(id)?.view_applicability ?? 'any', coordinate_system: specs.get(id)?.coordinate_system ?? 'body_relative', timestamp_ms: 0,
    }]));
    const evaluator = new CriterionEvaluator(movementCriteria, graph, feedback, {
      session_id: 'reference-rubric-audit', sport_pack_id: 'squash', sport_pack_version: '1', rubric_version: rubric.rubric_version,
      view: view as ViewLabel, athlete_context: 'unknown', capabilities_available: ['body_pose'], strict_rubrics: false, allow_draft_feedback: true,
      minimum_coverage: rubric.aggregation.minimum_coverage, human_variance: mergeHumanVariance(rubric.aggregation.human_variance), models,
      featureUnit: id => specs.get(id)?.unit ?? 'none',
    });
    const update: TemporalUpdate = {
      frame_id: 1, timestamp_ms: 0, state: 'CONFIRMED', previous_state: 'CONFIRMED', movement_id: movementId,
      phase_id: graph.initial, previous_phase_id: null, phase_changed: false, phase_entered_ms: 0, phase_duration_ms: 0, ended_phase: null,
      execution_id: 'audit', execution_started_ms: 0, completed: false, aborted_reason: null, unknown_reason: null, confidence: 1,
      evidence_frames: [1], execution_phases: [], cue_allowed: true, contact_evidence: 'none', events: [], blocked_reasons: [],
    };
    const assessment = evaluator.observe(update, features, true)!;
    for (const c of assessment.criteria) {
      if (c.provenance.evaluator === 'reference_nearest') {
        referenceRows.push({ movement_id: movementId, view, state: c.state, reason: c.measurement.reason });
        continue;
      }
      // Only report measurements actually derivable from the stored reference vector.
      if (c.measurement.value === null) continue;
      const definition = movementCriteria.find(x => x.criterion_id === c.criterion_id)!;
      checks.push({ movement_id: movementId, name: movement.canonical_name, view, reference_index: index, criterion_id: c.criterion_id,
        state: c.state, measurement: c.measurement, evaluator: definition.evaluator,
        variance: (c as typeof c & { meta?: Record<string, unknown> }).meta?.variance });
    }
  });
}

const conflicts = checks.filter(c => c.state === 'IMPROVE');
const staticMovements = movements.filter((m: { type: string }) => m.type === 'static');
const dynamicGraphs = graphs.filter(g => g.kind === 'dynamic_sequence');
const withoutReference = staticMovements.filter((m: { id: string }) => !criteria.some(c => c.movement_id === m.id && c.evaluator.kind === 'reference_nearest'));
const report = {
  created_at: new Date().toISOString(),
  method: 'Evaluate each recorded reference vector through the deployed scorer in preview mode. Only declared features and min/max aliases are supplied; missing geometric information is not invented. This is a consistency audit, not labeled accuracy evaluation.',
  hashes: Object.fromEntries(['technique_criteria.json', 'phase_graphs.json', 'movement_catalog.json', ...Object.keys(models)].map(p => [p, createHash('sha256').update(fs.readFileSync(path.join(packPath, p))).digest('hex')])),
  catalog: { static: staticMovements.length, dynamic: dynamicGraphs.length, criteria: criteria.length, approved_criteria: criteria.filter(c => c.validation_status === 'approved').length, static_reference_models: Object.keys(models).length },
  consistency: { measured_scalar_checks: checks.length, reference_scalar_conflicts: conflicts.length, movements_with_conflicts: new Set(conflicts.map(c => c.movement_id)).size,
    conflicts, reference_evaluation_states: referenceRows.reduce<Record<string, number>>((out, x) => { const key = String(x.state); out[key] = (out[key] ?? 0) + 1; return out; }, {}) },
  static_without_reference: withoutReference.map((m: { id: string; canonical_name: string }) => ({ movement_id: m.id, name: m.canonical_name,
    criteria: criteria.filter(c => c.movement_id === m.id).map(c => ({ criterion_id: c.criterion_id, features: c.required_features, evaluator: c.evaluator.kind })) })),
  dynamic_initial_phases_without_criteria: dynamicGraphs.filter(g => !criteria.some(c => c.movement_id === g.movement_id && c.phase_ids?.includes(g.initial))).map(g => g.movement_id),
  findings: [
    'The reference extractor and live runtime use the same feature engine and aspect-corrected body coordinates; the ready-stance conflict is not an old/new feature-extractor mismatch.',
    'Knee and elbow angles are declared as 2D image-projection angles with any-view applicability. Frontal projected knee geometry cannot uniquely determine sagittal knee flexion. Changing these features to 3D silently would invalidate current reference vectors and rubric calibration.',
    'Ready stance front reference knees are 176.1 and 173.1 degrees. Its max-knee criterion limit is 165 degrees, with a 9.6469-degree unknown-athlete variance band; the recorded reference itself fails that provisional criterion.',
    'Captured movement labels and simulation success do not establish expert-reviewed technique correctness. Scalar rubrics and reference targets disagree for some recordings.',
    'One-leg balance stance currently has only a trunk lateral-lean check and no reference model; it cannot establish that a leg is raised.',
    'All dynamic drills contain later geometric criteria, but no dynamic initial phase has an authored criterion. Initial setup cannot be fully graded from absent rules.',
  ],
  changes_not_made: ['No signed pack, model weight, threshold, validation status, or reference vector was changed by this audit.'],
};
const output = path.join(root, 'data/audit/static-investigation-2/reference-rubric-audit.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, catalog: report.catalog, consistency: { measured: checks.length, conflicts: conflicts.length, movements: report.consistency.movements_with_conflicts }, static_without_reference: withoutReference.length, dynamic_without_initial_criteria: report.dynamic_initial_phases_without_criteria.length }, null, 2));
