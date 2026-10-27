import { validateDynamicReferenceModel, type FeatureSpec, type PhaseGraph, type SportPackBundle } from '@apexformz/contracts';

/**
 * Cross-reference validation of a parsed pack (TRD 05 "Sports package validation").
 * Returns human-readable problems; empty array means the pack is consistent.
 */
export function crossValidate(b: SportPackBundle): string[] {
  const problems: string[] = [];
  const sportId = b.manifest.id;
  const same = (label: string, v: string) => {
    if (v !== sportId) problems.push(`${label}.sport_id '${v}' does not match manifest id '${sportId}'`);
  };
  same('court_geometry', b.court_geometry.sport_id);
  same('competition_rules', b.competition_rules.sport_id);
  same('equipment_catalog', b.equipment_catalog.sport_id);
  same('movement_catalog', b.movement_catalog.sport_id);
  same('phase_graphs', b.phase_graphs.sport_id);
  same('technique_criteria', b.technique_criteria.sport_id);
  same('feedback_templates', b.feedback_templates.sport_id);
  if (b.provenance.pack_id !== sportId) problems.push(`provenance.pack_id '${b.provenance.pack_id}' does not match manifest id`);
  if (b.provenance.version !== b.manifest.version) problems.push(`provenance.version '${b.provenance.version}' does not match manifest version '${b.manifest.version}'`);

  const graphs = new Map(b.phase_graphs.graphs.map((g) => [g.id, g]));
  const criteria = new Map(b.technique_criteria.criteria.map((c) => [c.criterion_id, c]));
  const features = new Map(b.technique_criteria.features.map((f) => [f.id, f]));
  const feedback = new Map(b.feedback_templates.entries.map((e) => [e.error_id, e]));
  const movements = new Map(b.movement_catalog.movements.map((m) => [m.id, m]));
  const modelPaths = new Set(b.manifest.models.map((m) => m.path));
  for (const [path, model] of Object.entries(b.models ?? {})) {
    if ((model as { kind?: string } | null)?.kind !== 'dynamic_reference') continue;
    try {
      validateDynamicReferenceModel(model);
      if (!movements.has(model.movement_id)) problems.push(`dynamic reference ${path} has an unknown movement`);
      for (const spec of model.feature_specs) {
        if (JSON.stringify(features.get(spec.id)) !== JSON.stringify(spec)) problems.push(`dynamic reference ${path} disagrees with feature ${spec.id}`);
      }
    } catch (error) { problems.push(`${path}: ${(error as Error).message}`); }
  }

  // Movements
  const uuids = new Set<string>();
  for (const m of b.movement_catalog.movements) {
    if (!m.id.startsWith(`${sportId}.`)) problems.push(`movement ${m.id} must be namespaced under '${sportId}.'`);
    if (uuids.has(m.uuid)) problems.push(`duplicate movement uuid ${m.uuid}`);
    uuids.add(m.uuid);
    const g = graphs.get(m.phase_graph_id);
    if (!g) problems.push(`movement ${m.id} references unknown phase graph ${m.phase_graph_id}`);
    else {
      if (g.movement_id !== m.id) problems.push(`phase graph ${g.id} belongs to ${g.movement_id}, not ${m.id}`);
      if (m.type === 'static' && g.kind !== 'static_hold') problems.push(`static movement ${m.id} needs a static_hold graph`);
      if (m.type === 'dynamic' && g.kind !== 'dynamic_sequence') problems.push(`dynamic movement ${m.id} needs a dynamic_sequence graph`);
    }
    for (const cid of m.criteria) {
      const c = criteria.get(cid);
      if (!c) problems.push(`movement ${m.id} references unknown criterion ${cid}`);
      else if (c.movement_id !== m.id) problems.push(`criterion ${cid} belongs to ${c.movement_id} but is listed under ${m.id}`);
    }
    for (const s of m.similar) {
      if (!s.movement_id.startsWith(`${sportId}.`)) problems.push(`movement ${m.id} has a similar edge to another sport (${s.movement_id}); cross-sport edges are forbidden`);
      if (s.movement_id === m.id) problems.push(`movement ${m.id} is marked similar to itself`);
    }
    for (const cap of m.required_capabilities) {
      if (!b.manifest.capabilities.includes(cap)) problems.push(`movement ${m.id} requires capability ${cap} not declared in manifest`);
    }
  }

  // Taxonomy (family -> group -> movement)
  const taxonomy = b.movement_catalog.taxonomy;
  if (taxonomy) {
    const placed = new Map<string, { family: string; group: string }>();
    const ids = new Set<string>();
    for (const f of taxonomy.families) {
      if (!f.id.startsWith(`${sportId}.`)) problems.push(`taxonomy family ${f.id} must be namespaced under '${sportId}.'`);
      if (ids.has(f.id)) problems.push(`duplicate taxonomy id ${f.id}`);
      ids.add(f.id);
      for (const g of f.groups) {
        if (!g.id.startsWith(`${sportId}.`)) problems.push(`taxonomy group ${g.id} must be namespaced under '${sportId}.'`);
        if (ids.has(g.id)) problems.push(`duplicate taxonomy id ${g.id}`);
        ids.add(g.id);
        for (const mid of g.members) {
          const m = movements.get(mid);
          if (!m) problems.push(`taxonomy group ${g.id} references unknown movement ${mid}`);
          else if (m.type !== f.type) problems.push(`taxonomy family ${f.id} is ${f.type} but member ${mid} is ${m.type}`);
          if (placed.has(mid)) problems.push(`movement ${mid} is placed in more than one taxonomy group`);
          placed.set(mid, { family: f.id, group: g.id });
        }
      }
    }
    for (const m of b.movement_catalog.movements) {
      const p = placed.get(m.id);
      if (!p) { problems.push(`movement ${m.id} is not placed in the taxonomy`); continue; }
      if (m.family_id && m.family_id !== p.family) problems.push(`movement ${m.id} family_id ${m.family_id} disagrees with the taxonomy (${p.family})`);
      if (m.group_id && m.group_id !== p.group) problems.push(`movement ${m.id} group_id ${m.group_id} disagrees with the taxonomy (${p.group})`);
    }
  } else {
    for (const m of b.movement_catalog.movements) if (m.family_id || m.group_id) problems.push(`movement ${m.id} declares a family/group but the catalog has no taxonomy`);
  }

  // Phase graphs
  for (const g of b.phase_graphs.graphs) {
    if (!movements.has(g.movement_id)) problems.push(`phase graph ${g.id} references unknown movement ${g.movement_id}`);
    const ids = new Set(g.phases.map((p) => p.id));
    if (ids.size !== g.phases.length) problems.push(`phase graph ${g.id} has duplicate phase ids`);
    if (!ids.has(g.initial)) problems.push(`phase graph ${g.id} initial phase ${g.initial} missing`);
    for (const t of g.terminal) if (!ids.has(t)) problems.push(`phase graph ${g.id} terminal phase ${t} missing`);
    for (const e of g.edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`phase graph ${g.id} edge ${e.from}->${e.to} references unknown phase`);
    }
    for (const p of g.phases) {
      for (const c of p.enter) {
        if (!features.has(c.feature)) problems.push(`phase ${g.id}/${p.id} condition references unknown feature ${c.feature}`);
        if (c.op === 'between' && !Array.isArray(c.value)) problems.push(`phase ${g.id}/${p.id} 'between' needs a [lo, hi] value`);
        if (c.op !== 'between' && Array.isArray(c.value)) problems.push(`phase ${g.id}/${p.id} op ${c.op} needs a scalar value`);
      }
    }
    problems.push(...checkCycles(g));
    if (g.kind === 'static_hold' && g.phases.length !== 1) problems.push(`static_hold graph ${g.id} must have exactly one phase`);
  }

  // Criteria
  for (const c of b.technique_criteria.criteria) {
    if (!movements.has(c.movement_id)) problems.push(`criterion ${c.criterion_id} references unknown movement ${c.movement_id}`);
    const m = movements.get(c.movement_id);
    if (m && !m.criteria.includes(c.criterion_id)) problems.push(`criterion ${c.criterion_id} is not listed in movement ${c.movement_id}`);
    for (const f of c.required_features) if (!features.has(f)) problems.push(`criterion ${c.criterion_id} requires unknown feature ${f}`);
    if (c.feature_selector) for (const f of c.feature_selector.candidates) if (!features.has(f)) problems.push(`criterion ${c.criterion_id} selector references unknown feature ${f}`);
    if (c.phase_ids && m) {
      const g = graphs.get(m.phase_graph_id);
      const ids = new Set(g?.phases.map((p) => p.id) ?? []);
      for (const pid of c.phase_ids) if (!ids.has(pid)) problems.push(`criterion ${c.criterion_id} references unknown phase ${pid}`);
    }
    if (!feedback.has(c.error_id)) problems.push(`criterion ${c.criterion_id} error_id ${c.error_id} has no feedback template`);
    if (c.validation_status === 'approved' && c.expert_citation.status !== 'approved') problems.push(`criterion ${c.criterion_id} is approved without an approved expert citation`);
    const ev = c.evaluator;
    if (ev.kind === 'range' && (!ev.range || ev.range.length !== 2)) problems.push(`criterion ${c.criterion_id} range evaluator needs range`);
    if (ev.kind === 'range' && ev.range && ev.range[0] > ev.range[1]) problems.push(`criterion ${c.criterion_id} range lo > hi`);
    if ((ev.kind === 'max_abs' || ev.kind === 'min_value' || ev.kind === 'max_value' || ev.kind === 'stability') && (ev.limit === undefined || ev.limit === null)) problems.push(`criterion ${c.criterion_id} ${ev.kind} evaluator needs limit`);
    if (ev.kind === 'ordering' && (!ev.expected_order || ev.expected_order.length < 2)) problems.push(`criterion ${c.criterion_id} ordering evaluator needs expected_order`);
    if (ev.kind === 'reference_nearest' || ev.kind === 'dynamic_reference') {
      if (!ev.model_reference) problems.push(`criterion ${c.criterion_id} ${ev.kind} needs model_reference`);
      else if (!modelPaths.has(ev.model_reference)) problems.push(`criterion ${c.criterion_id} model_reference ${ev.model_reference} not declared in manifest models`);
    }
    if (ev.kind === 'phase_duration' && m) {
      const g = graphs.get(m.phase_graph_id);
      const params = (ev.params ?? {}) as { phase_id?: string; from_phase_id?: string; measure?: string };
      const phaseId = params.phase_id ?? c.phase_ids?.[0];
      const ids = new Set(g?.phases.map((p) => p.id) ?? []);
      if (!phaseId || !ids.has(phaseId)) problems.push(`criterion ${c.criterion_id} phase_duration references unknown phase ${phaseId}`);
      if (params.from_phase_id && !ids.has(params.from_phase_id)) problems.push(`criterion ${c.criterion_id} phase_duration from_phase_id ${params.from_phase_id} is not a phase of ${m.phase_graph_id}`);
      const measure = params.measure ?? (params.from_phase_id ? 'since_phase_start' : 'span');
      if (measure !== 'span' && !params.from_phase_id) problems.push(`criterion ${c.criterion_id} phase_duration measure ${measure} needs from_phase_id`);
      if (measure === 'span' && phaseId && g?.terminal.includes(phaseId) && g.kind !== 'static_hold') {
        problems.push(`criterion ${c.criterion_id} measures the span of terminal phase ${phaseId}, which is only its confirmation dwell; use from_phase_id to measure the time taken to reach it`);
      }
    }
    if (ev.kind === 'equipment_dependent' && !c.requires_capabilities.some((cap) => cap !== 'body_pose' && cap !== 'hands')) {
      problems.push(`criterion ${c.criterion_id} is equipment_dependent but requires no equipment capability`);
    }
    for (const cap of c.requires_capabilities) if (!b.manifest.capabilities.includes(cap)) problems.push(`criterion ${c.criterion_id} requires undeclared capability ${cap}`);
  }

  // Human variance profile is sport knowledge: when declared it must be sourced like any other rubric value.
  const hv = b.technique_criteria.aggregation.human_variance;
  if (hv) {
    if (!hv.validation_status) problems.push('technique_criteria.aggregation.human_variance must declare validation_status (provisional until fitted on recordings)');
    if (hv.validation_status === 'approved' && !b.provenance.sources.some((s) => s.status === 'approved' && (s.type === 'dataset' || s.type === 'coach_review'))) {
      problems.push('human_variance is approved without an approved dataset or coach_review source in provenance');
    }
  }
  for (const c of b.technique_criteria.criteria) {
    if (c.evaluator.human_variance_relative !== undefined && !hv) problems.push(`criterion ${c.criterion_id} sets human_variance_relative but the rubric declares no human_variance profile`);
  }

  // Feature dependency graph
  problems.push(...checkFeatureDeps(b.technique_criteria.features));

  // Court geometry: no numeric claim without an approved source
  for (const l of b.court_geometry.named_landmarks) {
    if (l.value_m !== null && l.validation_status === 'approved' && b.court_geometry.provenance.status !== 'approved') {
      problems.push(`court landmark ${l.id} is approved but the geometry provenance is not`);
    }
  }
  // Rules: pose can never adjudicate official game events
  for (const rs of b.competition_rules.rule_sets) {
    for (const r of rs.rules) if (r.kind === 'official' && r.adjudicable_from_pose === true) problems.push(`rule ${r.id} claims pose adjudication of an official rule`);
  }
  // Feedback approved entries must be approved text
  for (const e of b.feedback_templates.entries) if (!e.cue.en?.trim()) problems.push(`feedback ${e.error_id} has no English cue`);
  return problems;
}

/** Cycles are only permitted through edges that return to the initial phase (repetition). */
function checkCycles(g: PhaseGraph): string[] {
  const adj = new Map<string, string[]>();
  for (const p of g.phases) adj.set(p.id, []);
  for (const e of g.edges) {
    if (e.to === g.initial) continue;
    adj.get(e.from)?.push(e.to);
  }
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, WHITE);
  const problems: string[] = [];
  const dfs = (u: string, path: string[]) => {
    color.set(u, GREY);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GREY) problems.push(`phase graph ${g.id} has a disallowed cycle ${[...path, u, v].join('->')}`);
      else if (color.get(v) === WHITE) dfs(v, [...path, u]);
    }
    color.set(u, BLACK);
  };
  for (const id of adj.keys()) if (color.get(id) === WHITE) dfs(id, []);
  return problems;
}

function checkFeatureDeps(specs: FeatureSpec[]): string[] {
  const problems: string[] = [];
  const ids = new Map(specs.map((s) => [s.id, s]));
  const deps = (s: FeatureSpec): string[] => {
    const p = s.params as Record<string, unknown>;
    const d: string[] = [];
    if (typeof p.of === 'string') d.push(p.of);
    if (Array.isArray(p.features)) d.push(...(p.features as string[]));
    return d;
  };
  const state = new Map<string, number>();
  const visit = (id: string, chain: string[]) => {
    const st = state.get(id) ?? 0;
    if (st === 2) return;
    if (st === 1) {
      problems.push(`feature dependency cycle ${[...chain, id].join('->')}`);
      return;
    }
    const s = ids.get(id);
    if (!s) {
      problems.push(`feature ${chain.at(-1)} depends on unknown feature ${id}`);
      return;
    }
    state.set(id, 1);
    for (const d of deps(s)) visit(d, [...chain, id]);
    state.set(id, 2);
  };
  for (const s of specs) visit(s.id, []);
  return problems;
}
