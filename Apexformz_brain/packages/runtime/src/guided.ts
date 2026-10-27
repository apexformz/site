import type { FeatureSpec, PhaseDefinition, PhaseGraph } from '@apexformz/contracts';
import { evaluateConditions, type TemporalUpdate } from '@apexformz/analysis';
import type { FeatureMap } from '@apexformz/features';

function motionPredicate(specifications: FeatureSpec[]) {
  const specs = new Map(specifications.map(f => [f.id, f]));
  const motion = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const spec = specs.get(id);
    if (!spec) return false;
    if (['stability_variability', 'angular_velocity', 'linear_velocity', 'time_derivative'].includes(spec.kind)) return true;
    const deps = spec.params.features;
    return Array.isArray(deps) && deps.length > 0 && deps.every(x => typeof x === 'string' && motion(x, new Set(seen)));
  };
  return motion;
}

/** Evidence that an observed attempted phase ended; never infers equipment contact. */
export function guidedPhaseEnd(graph: PhaseGraph, specs: FeatureSpec[], features: FeatureMap, phaseId: string): PhaseDefinition | null {
  const motion = motionPredicate(specs);
  const previous = graph.phases.find(p => p.id === phaseId)!;
  const ownMotion = previous.enter.filter(c => motion(c.feature));
  const previousEvidence = evaluateConditions(ownMotion, features);
  if (!ownMotion.length || !previousEvidence.evaluable || previousEvidence.all_satisfied) return null;
  const nextIds = new Set(graph.edges.filter(e => e.from === phaseId).map(e => e.to));
  const matches = (p: PhaseDefinition) => {
    const conditions = p.enter.filter(c => motion(c.feature));
    // Stable setup or an adjacent motion transition supplies an observed endpoint.
    return conditions.length > 0 && evaluateConditions(conditions, features).all_satisfied;
  };
  const targets = graph.phases.filter(p => nextIds.has(p.id)).filter(matches);
  if (targets.length) return targets.length === 1 ? targets[0] : null;
  const initial = graph.phases.find(p => p.id === graph.initial)!;
  return ['rest', 'hold'].includes(initial.kind) && matches(initial) ? initial : null;
}

/** Candidate coaching context from intent + pack kinematics. Never changes recognition or repetition state. */
export function guidedPhase(graph: PhaseGraph, specifications: FeatureSpec[], features: FeatureMap, temporal: TemporalUpdate): PhaseDefinition | null {
  const initial = graph.phases.find(p => p.id === graph.initial)!;
  // A selected static target is enough context to compare current geometry.
  // Stillness and posture predicates remain requirements for a confirmed hold,
  // never prerequisites for showing the athlete how to reach that position.
  if (graph.kind === 'static_hold') return temporal.state === 'CONFIRMED' ? null : initial;
  const motionFeature = motionPredicate(specifications);
  // Recovery can reach a stationary target but fail its posture gate. Observe
  // that adjacent hold without asserting the movement has completed.
  if (temporal.phase_id && ['CONFIRMED', 'EXECUTING'].includes(temporal.state)) {
    const nextIds = new Set(graph.edges.filter(e => e.from === temporal.phase_id).map(e => e.to));
    const stableSuccessors = graph.phases.filter(p => nextIds.has(p.id) && ['rest', 'hold'].includes(p.kind)).filter(p => {
      const conditions = p.enter.filter(c => motionFeature(c.feature));
      return conditions.length > 0 && conditions.every(c => ['lt', 'lte', 'abs_lt'].includes(c.op) && typeof c.value === 'number' && c.value > 0) && evaluateConditions(conditions, features).all_satisfied;
    });
    if (stableSuccessors.length === 1) return stableSuccessors[0];
    if (stableSuccessors.length > 1) return null;
  }
  // Once a later phase is established its real temporal evidence owns assessment.
  if (!['IDLE', 'CANDIDATE'].includes(temporal.state) && temporal.phase_id !== initial.id) return null;
  const candidates = graph.phases.filter(p => ['action', 'preparation', 'loading'].includes(p.kind) && p.id !== temporal.phase_id).filter(p => {
    const conditions = p.enter.filter(c => motionFeature(c.feature));
    const moving = conditions.some(c => typeof c.value === 'number' && (
      ['gt', 'gte', 'abs_gt'].includes(c.op) && c.value > 0 || ['lt', 'lte'].includes(c.op) && c.value < 0
    ));
    return moving && evaluateConditions(conditions, features).all_satisfied;
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return null;
  if (!['IDLE', 'CANDIDATE'].includes(temporal.state) || !['rest', 'hold', 'preparation'].includes(initial.kind)) return null;
  const motion = initial.enter.filter(c => motionFeature(c.feature));
  const outgoing = graph.edges.filter(e => e.from === initial.id).map(e => graph.phases.find(p => p.id === e.to)!);
  const noAction = outgoing.every(p => { const result = evaluateConditions(p.enter, features); return result.evaluable && !result.all_satisfied; });
  const exitMotion = outgoing.flatMap(p => p.enter).filter(c => motionFeature(c.feature) && typeof c.value === 'number' && c.value !== 0);
  const stableBeforeAction = exitMotion.length > 0 && exitMotion.every(c => {
    const feature = features.get(c.feature);
    return feature?.valid && feature.value !== null && Math.abs(feature.value) < Math.abs(c.value as number);
  });
  const motionOk = motion.length > 0 ? evaluateConditions(motion, features).all_satisfied : stableBeforeAction;
  return motionOk && noAction ? initial : null;
}
