/** Source replays and explicitly synthetic fault probes. These are NOT independent coaching-accuracy estimates. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FeatureValue } from '@apexformz/contracts';
import type { DynamicReferenceModel, DynamicReferenceSequence } from '../packages/contracts/src/dynamic_reference';
import { DynamicReferenceComparator, type DynamicReferenceComparison } from '../packages/scoring/src/dynamic_reference';

type Sequence = DynamicReferenceSequence;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

export function replayReference(model: DynamicReferenceModel, source: Sequence, speed = 1) {
  const comparator = new DynamicReferenceComparator(model, { view: source.view, handedness: source.handedness, emit_interval_ms: 0 });
  const results: DynamicReferenceComparison[] = [];
  let frame = 0;
  const feed = (values: Array<number | null>, timestamp_ms: number) => {
    const features = new Map<string, FeatureValue>(model.features.map((f, i) => [f.id, {
      spec_id: f.id, name: f.id, value: values[i], valid: values[i] !== null, reason: values[i] === null ? 'MISSING_JOINT' : null,
      confidence: values[i] === null ? 0 : 1, unit: model.feature_specs[i].unit ?? f.unit, timestamp_ms,
      coordinate_system: model.feature_specs[i].coordinate_system, view_applicability: 'any', evidence_frame_ids: [frame], retrospective: false,
    }]));
    const result = comparator.observe({ timestamp_ms, frame_id: frame++, features, quality_ok: true });
    if (result) results.push(result);
  };
  for (let t = 0; t < 600; t += 100) feed(source.samples[0].values, t);
  for (const s of source.samples) feed(s.values, 600 + s.t_ms * speed);
  for (let t = 100; t <= 1000; t += 100) feed(source.samples.at(-1)!.values, 600 + source.duration_ms * speed + t);
  const active = results.filter(r => r.status === 'active' || r.status === 'complete' || r.status === 'incomplete');
  const corrections = results.filter(r => r.state === 'IMPROVE');
  const faultIds = [...new Set(corrections.flatMap(r => r.deviations.filter(d => d.outside_reference_band).map(d => d.feature_id)))];
  return { results, summary: {
    frames: frame, assessments: active.length, correction_updates: corrections.length, correction_features: faultIds,
    unavailable_updates: results.filter(r => r.status === 'unavailable').length,
    reasons: [...new Set(results.flatMap(r => r.reason ? [r.reason] : []))],
    maximum_progress: Math.max(0, ...active.map(r => r.progress)),
    segment_matched: results.some(r => r.segment_matched),
    whole_reference_matched: results.some(r => r.completed),
    sequence_mismatch: results.some(r => r.sequence_mismatch),
    last_state: active.at(-1)?.state ?? null,
  } };
}

function transformed(source: Sequence, change: (values: Array<number | null>, i: number) => Array<number | null>): Sequence {
  return { ...source, samples: source.samples.map((s, i) => ({ ...s, values: change([...s.values], i) })) };
}

function span(source: Sequence, i: number, tolerance: number): number {
  const values = source.samples.map(s => s.values[i]).filter((v): v is number => v !== null);
  return values.length >= source.samples.length * .7 ? (Math.max(...values) - Math.min(...values)) / tolerance : 0;
}

export function dynamicFaultProbes(model: DynamicReferenceModel, source: Sequence) {
  const probes: Array<{ name: string; feature: string | null; source: Sequence; expectation: 'local_correction' | 'negative_probe' }> = [];
  const knee = model.features.findIndex((f, i) => f.id.endsWith('knee_angle') && source.samples.filter(s => s.values[i] !== null).length >= source.samples.length * .7);
  if (knee >= 0) {
    const expected = source.samples.map(s => s.values[knee]).filter((v): v is number => v !== null);
    const shift = expected.reduce((a, b) => a + b, 0) / expected.length > 110 ? -55 : 55;
    probes.push({ name: 'controlled_knee_deviation', feature: model.features[knee].id, expectation: 'local_correction', source: transformed(source, (v, i) => {
      if (i >= source.samples.length * .2 && i <= source.samples.length * .85 && v[knee] !== null) v[knee] = Math.max(15, Math.min(180, v[knee]! + shift));
      return v;
    }) });
  }
  const signed = model.features.map((f, i) => ({ f, i, span: span(source, i, f.tolerance) })).filter(x => x.f.id.includes('wrist_x') && x.span > 1.5).sort((a, b) => b.span - a.span)[0];
  if (signed && source.samples[0].values[signed.i] !== null) probes.push({ name: 'reversed_hand_direction', feature: signed.f.id, expectation: 'negative_probe', source: transformed(source, v => {
    if (v[signed.i] !== null) v[signed.i] = 2 * source.samples[0].values[signed.i]! - v[signed.i]!;
    return v;
  }) });
  const arm = model.features.map((f, i) => ({ f, i })).filter(({ f, i }) => /wrist_[xy]|elbow_angle|arm_elevation/.test(f.id) && span(source, i, f.tolerance) > 1.5 && source.samples[0].values[i] !== null);
  if (arm.length) probes.push({ name: 'reduced_arm_motion', feature: arm[0].f.id, expectation: 'negative_probe', source: transformed(source, v => {
    for (const { i } of arm) if (v[i] !== null) v[i] = source.samples[0].values[i]! + .1 * (v[i]! - source.samples[0].values[i]!);
    return v;
  }) });
  probes.push({ name: 'time_reversed_geometry', feature: null, expectation: 'negative_probe', source: transformed(source, (_v, i) => [...source.samples[source.samples.length - 1 - i].values]) });
  return probes;
}

function main() {
  const arg = (key: string, fallback?: string) => { const i = process.argv.indexOf(`--${key}`); return i >= 0 ? process.argv[i + 1] : fallback; };
  const root = arg('models', 'sport-packs/squash/models/dynamic-reference')!;
  const only = arg('movement');
  const out = arg('out', 'data/audit/dynamic-reference/evaluation.json')!;
  const limit = Number(arg('limit', '0'));
  const all = fs.readdirSync(root).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as DynamicReferenceModel);
  const models = only ? all.filter(m => m.movement_id === only) : all;
  const records: Array<Record<string, unknown>> = [];
  const counter: Record<string, { tests: number; assessed: number; corrections: number; targeted_corrections: number; matched: number }> = {};
  const record = (model: DynamicReferenceModel, ref: Sequence, kind: string, summary: ReturnType<typeof replayReference>['summary'], feature: string | null = null, detail: Record<string, unknown> = {}) => {
    records.push({ movement_id: model.movement_id, reference_id: ref.id, source_execution_id: ref.source_execution_id, view: ref.view, kind, expected_feature: feature, ...detail, ...summary });
    const c = counter[kind] ??= { tests: 0, assessed: 0, corrections: 0, targeted_corrections: 0, matched: 0 };
    c.tests++; c.assessed += Number(summary.assessments > 0); c.corrections += Number(summary.correction_updates > 0);
    c.targeted_corrections += Number(feature !== null && summary.correction_features.includes(feature)); c.matched += Number(summary.segment_matched);
  };
  for (const model of models) {
    const refs = limit ? model.references.slice(0, limit) : model.references;
    for (const ref of refs) {
      for (const speed of [1, .7, 1.4]) record(model, ref, speed === 1 ? 'source_replay' : `source_time_scale_${speed}`, replayReference(model, ref, speed).summary, null, { timestamp_multiplier: speed });
      for (const probe of dynamicFaultProbes(model, ref)) record(model, ref, probe.name, replayReference(model, probe.source).summary, probe.feature, { expectation: probe.expectation });
      const independent = model.references.filter(r => r.view === ref.view && r.handedness === ref.handedness && r.source_execution_id !== ref.source_execution_id);
      if (independent.length) record(model, ref, 'leave_source_capture_out', replayReference({ ...model, references: independent }, ref).summary, null,
        { note: 'Different source capture, same athlete; no independent-athlete claim.' });
    }
    console.log(`${model.movement_id}: ${refs.length} reference sequences evaluated`);
  }
  const crossMovements: Array<Record<string, unknown>> = [];
  for (const [expected, wrong] of [['squash.dynamic.0030', 'squash.dynamic.0040'], ['squash.dynamic.0040', 'squash.dynamic.0030']]) {
    const model = all.find(m => m.movement_id === expected), donor = all.find(m => m.movement_id === wrong);
    if (!model || !donor) continue;
    for (const ref of donor.references.filter(r => model.references.some(p => p.view === r.view && p.handedness === r.handedness))) crossMovements.push({ expected_movement: expected, observed_movement: wrong, reference_id: ref.id, view: ref.view, ...replayReference(model, ref).summary });
  }
  const report = { created_at: new Date().toISOString(), evidence_type: 'source-replay-and-controlled-feature-perturbations',
    limitations: ['Source replays include their own source in the reference bank and test pipeline consistency, not independent accuracy.',
      'Fault probes alter measured feature trajectories directly; they are synthetic, not independently coach-labelled wrong videos.',
      'Reversed/reduced trajectories can overlap valid segments; negative-probe detection is reported without asserting all are semantic faults.',
      'All recordings come from one athlete. No independent-athlete performance estimate is available.'],
    comparator_sha256: sha(fs.readFileSync('packages/scoring/src/dynamic_reference.ts', 'utf8')),
    reference_bank_sha256: sha(fs.readdirSync(root).filter(f => f.endsWith('.json')).sort().map(f => `${f}:${sha(fs.readFileSync(path.join(root, f), 'utf8'))}`).join('\n')),
    catalogue_movements: models.length, movements_with_references: models.filter(m => m.references.length).length, counts: counter,
    movements: models.map(m => ({ movement_id: m.movement_id, references: m.references.length, unsupported_reasons: m.unsupported_reasons,
      source_replay_corrections: records.filter(r => r.movement_id === m.movement_id && r.kind === 'source_replay' && Number(r.correction_updates) > 0).length,
      controlled_knee_misses: records.filter(r => r.movement_id === m.movement_id && r.kind === 'controlled_knee_deviation' && !(r.correction_features as string[]).includes(r.expected_feature as string)).length })),
    cross_movement_negatives: crossMovements, records };
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ counts: counter, cross_movement_tests: crossMovements.length, out }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
