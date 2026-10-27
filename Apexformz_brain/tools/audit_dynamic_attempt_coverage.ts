/** Diagnostic inventory of authored graph support; not a technique accuracy claim. */
import fs from 'node:fs';
import { DynamicAttemptObserver, dynamicMotionFeatures } from '../packages/runtime/src/dynamic_attempt';
const graphs = JSON.parse(fs.readFileSync('sport-packs/squash/phase_graphs.json', 'utf8')).graphs;
const rubric = JSON.parse(fs.readFileSync('sport-packs/squash/technique_criteria.json', 'utf8'));
const catalog = JSON.parse(fs.readFileSync('sport-packs/squash/movement_catalog.json', 'utf8')).movements;
const rows = graphs.filter((g: any) => g.kind !== 'static_hold').map((g: any) => {
  const criteria = rubric.criteria.filter((c: any) => c.movement_id === g.movement_id);
  const observer = new DynamicAttemptObserver(g, dynamicMotionFeatures(g, rubric.features, criteria), criteria);
  // Introspect the pure observer's compiled configuration for this audit only.
  const config = observer as unknown as { phase: { id: string } | null; drivers: Array<{ feature: string; excursion: number; direction: number }> };
  return { movement_id: g.movement_id, name: catalog.find((m: any) => m.id === g.movement_id)?.canonical_name, template: g.phases.map((p: any) => p.id).join('>'), supported: Boolean(config.phase && config.drivers.length), assessment_phase: config.phase?.id ?? null, drivers: config.drivers };
});
const summary = Object.entries(Object.groupBy(rows, (r: any) => r.template)).map(([template, rs]) => ({ template, drills: rs!.length, supported: rs!.filter((r: any) => r.supported).length }));
const output = { note: 'Observer support inventory; existing recognized-phase assessment may remain available for unsupported templates. This is not a measured recognition or correctness rate.', summary, rows };
fs.writeFileSync('data/audit/dynamic-investigation/attempt-coverage.json', JSON.stringify(output, null, 2));
console.log(JSON.stringify(summary, null, 2));
