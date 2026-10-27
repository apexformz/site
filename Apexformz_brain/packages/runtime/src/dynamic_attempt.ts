import type { Condition, CriterionDefinition, FeatureSpec, PhaseDefinition, PhaseGraph } from '@apexformz/contracts';
import type { FeatureMap } from '@apexformz/features';
import { evaluateConditions } from '@apexformz/analysis';

export interface AttemptSample { frame_id: number; timestamp_ms: number; features: FeatureMap }
interface Driver { feature: string; excursion: number; direction: -1 | 0 | 1 }

/** Companion axis for an authored limb-offset feature; motion only, never a new grading rule. */
export function dynamicMotionFeatures(graph: PhaseGraph, specifications: FeatureSpec[], criteria: CriterionDefinition[]): FeatureSpec[] {
  if (graph.kind !== 'dynamic_sequence') return specifications;
  const action = graph.phases.filter(p => p.kind === 'action');
  if (action.length !== 1) return specifications;
  const specs = new Map(specifications.map(s => [s.id, s]));
  const chains = action[0].enter.flatMap(c => {
    const velocity = specs.get(c.feature);
    const angle = typeof velocity?.params.of === 'string' ? specs.get(velocity.params.of) : null;
    return angle?.kind === 'angle_at' ? [[angle.params.a, angle.params.c]] : [];
  });
  const extras = specifications.filter(s => s.kind === 'landmark_offset' && s.params.axis === 'y' && chains.some(([a, c]) => s.params.a === c && s.params.b === a)
    && criteria.some(c => c.phase_ids?.includes(action[0].id) && c.required_features.includes(s.id) && (c.evaluator.tolerance ?? 0) > 0))
    .map(s => ({ ...s, id: `${s.id}__motion_x`, params: { ...s.params, axis: 'x' }, description: 'Companion axis for continuous attempted-limb-motion observation; not a technique criterion.' }));
  return [...specifications, ...extras];
}
export interface MotionAttempt {
  phase_id: string;
  since_ms: number;
  started: boolean;
  completed: boolean;
  samples: AttemptSample[];
  observed_end?: { timestamp_ms: number; frame_id: number };
}

/**
 * A selected-drill motion observer, separate from recognized phase sequences.
 * It finds a continuous motion interval from the graph's own driving feature.
 * The displacement scale comes from authored gates/dwell, not a new technique
 * cutoff. Slower or imperfect attempts can therefore reach geometric feedback
 * without being promoted to recognized repetitions or observed contact.
 */
export class DynamicAttemptObserver {
  private readonly drivers: Driver[] = [];
  private readonly phase: PhaseDefinition | null;
  private readonly maximumMs: number;
  private readonly quietConditions: Condition[][] = [];
  private history: AttemptSample[] = [];
  private active: { since_ms: number; driver: Driver; samples: AttemptSample[] } | null = null;
  private settled: AttemptSample[] = [];
  private reviewing = false;
  private latestFeatures: FeatureMap | null = null;

  constructor(private graph: PhaseGraph, specifications: FeatureSpec[], criteria: CriterionDefinition[]) {
    const actions = graph.kind === 'dynamic_sequence' ? graph.phases.filter(p => p.kind === 'action') : [];
    const action = actions.length === 1 ? actions[0] : null;
    this.maximumMs = graph.abort_timeout_ms ?? graph.window_ms ?? 4000;
    this.phase = action ? this.assessmentPhase(action, criteria) : null;
    const specs = new Map(specifications.map(s => [s.id, s]));
    const motion = (id: string): boolean => {
      const spec = specs.get(id);
      return !!spec && (['angular_velocity', 'linear_velocity', 'time_derivative', 'stability_variability'].includes(spec.kind)
        || Array.isArray(spec.params.features) && spec.params.features.every(child => typeof child === 'string' && motion(child)));
    };
    this.quietConditions = graph.phases.filter(p => p.cue_allowed).map(p => p.enter.filter(c => motion(c.feature)
      && ['lt', 'lte', 'abs_lt'].includes(c.op) && typeof c.value === 'number' && c.value > 0)).filter(c => c.length > 0);
    if (!action || !this.phase) return;
    const add = (feature: string, threshold: number, op: string, seen = new Set<string>()) => {
      if (seen.has(feature)) return;
      seen.add(feature);
      const spec = specs.get(feature);
      if (!spec) return;
      const initial = graph.phases.find(p => p.id === graph.initial);
      const start = initial?.enter.find(c => c.feature === feature && typeof c.value === 'number' && c.value !== threshold);
      if (['angle_at', 'min_of'].includes(spec.kind) && start && typeof start.value === 'number') {
        this.drivers.push({ feature, excursion: Math.abs(start.value - threshold), direction: ['lt', 'lte'].includes(op) ? -1 : 1 });
      } else if (['max_of', 'min_of'].includes(spec.kind) && Array.isArray(spec.params.features)) {
        for (const child of spec.params.features) if (typeof child === 'string') add(child, threshold, op, new Set(seen));
      } else if (['angular_velocity', 'linear_velocity', 'time_derivative'].includes(spec.kind) && typeof spec.params.of === 'string') {
        const dwell = Math.max(action.hold_ms ?? 0, action.min_duration_ms ?? 0, 30);
        const excursion = Math.abs(threshold) * dwell / 1000;
        if (excursion > 0) this.drivers.push({ feature: spec.params.of, excursion, direction: op.startsWith('abs_') ? 0 : threshold > 0 ? 1 : -1 });
      } else if (spec.kind === 'stability_variability' && typeof spec.params.of === 'string' && threshold > 0 && ['gt', 'gte', 'abs_gt'].includes(op)) {
        // A standard-deviation gate implies a nonzero positional excursion.
        this.drivers.push({ feature: spec.params.of, excursion: threshold * 2, direction: 0 });
      } else if (['angle_at', 'min_of', 'max_of'].includes(spec.kind) || spec.unit === 'deg') {
        const initial = graph.phases.find(p => p.id === graph.initial);
        const start = initial?.enter.find(c => c.feature === feature && typeof c.value === 'number' && c.value !== threshold);
        if (start && typeof start.value === 'number') this.drivers.push({ feature, excursion: Math.abs(start.value - threshold), direction: ['lt', 'lte'].includes(op) ? -1 : 1 });
      }
    };
    for (const condition of action.enter) if (typeof condition.value === 'number') add(condition.feature, condition.value, condition.op);
    // An extended-arm stroke can move at the shoulder with little elbow-angle
    // change. Use the same authored limb-offset tolerance as a motion deadband
    // on both image-plane axes; it does not decide technique correctness.
    for (const spec of specifications.filter(s => s.id.endsWith('__motion_x'))) {
      const originalId = spec.id.slice(0, -'__motion_x'.length);
      const rule = criteria.find(c => c.phase_ids?.includes(action.id) && c.required_features.includes(originalId) && (c.evaluator.tolerance ?? 0) > 0);
      if (rule) for (const feature of [originalId, spec.id]) this.drivers.push({ feature, excursion: rule.evaluator.tolerance!, direction: 0 });
    }
  }

  private assessmentPhase(action: PhaseDefinition, criteria: CriterionDefinition[]): PhaseDefinition | null {
    const geometric = (id: string) => criteria.some(c => c.phase_ids?.includes(id) && !['phase_duration', 'ordering', 'equipment_dependent'].includes(c.evaluator.kind));
    if (geometric(action.id)) return action;
    const next = this.graph.edges.filter(e => e.from === action.id).map(e => this.graph.phases.find(p => p.id === e.to)!).filter(Boolean);
    // An observed turning point can supply body geometry for an otherwise
    // correctness-gated contact-position phase. Equipment evidence remains absent.
    return next.length === 1 && geometric(next[0].id) ? next[0] : null;
  }

  reset(): void { this.history = []; this.active = null; this.settled = []; this.reviewing = false; this.latestFeatures = null; }
  get reviewIsCurrent(): boolean { return this.reviewing && this.active === null; }

  /** Current observation only: an absent phase or lost arm is never proof of rest. */
  get deferredCueSafe(): boolean {
    if (!this.latestFeatures || !this.quiet(this.latestFeatures) || this.active) return false;
    if (!this.drivers.length) return this.quietConditions.length > 0;
    const latest = this.history.at(-1);
    if (!latest) return false;
    let start = this.history.length - 1;
    while (start >= 0 && this.history[start].timestamp_ms > latest.timestamp_ms - 300) start--;
    start = Math.min(start, this.history.length - 3);
    if (start < 0) return false;
    const samples = this.history.slice(start);
    if (samples.length < 3) return false;
    return this.drivers.every(driver => {
      const values = samples.map(sample => this.value(sample, driver));
      return values.every(v => v !== null) && Math.max(...values as number[]) - Math.min(...values as number[]) <= driver.excursion / 4;
    });
  }

  private value(sample: AttemptSample, driver: Driver): number | null {
    const f = sample.features.get(driver.feature);
    return f?.valid && f.value !== null && (f.confidence ?? 0) >= 0.5 && Number.isFinite(f.value) ? f.value : null;
  }

  private quiet(features: FeatureMap): boolean {
    return !this.quietConditions.length || this.quietConditions.some(conditions => {
      const evidence = evaluateConditions(conditions, features);
      return evidence.all_satisfied && evidence.confidence >= 0.5;
    });
  }

  observe(sample: AttemptSample): MotionAttempt | null {
    this.latestFeatures = sample.features;
    if (!this.phase || !this.drivers.length) return null;
    if (this.drivers.every(driver => this.value(sample, driver) === null)) { this.reset(); return null; }
    // A retained review cannot authorize speech once motion resumes, even before
    // a new complete limb excursion is long enough to establish another attempt.
    if (this.reviewing && !this.quiet(sample.features)) this.reviewing = false;
    this.history.push(sample);
    this.history = this.history.filter(s => sample.timestamp_ms - s.timestamp_ms <= 1000).slice(-90);
    if (!this.active) {
      if (this.history.length < 3) return null;
      const start = this.history[0];
      if (sample.timestamp_ms - start.timestamp_ms < 100) return null;
      const driver = this.drivers.find(d => {
        const values = this.history.map(s => this.value(s, d));
        if (values.some(v => v === null)) return false;
        const delta = (values.at(-1) as number) - (values[0] as number);
        const direction = d.direction || Math.sign(delta);
        const steps = values.slice(1).filter((v, i) => ((v as number) - (values[i] as number)) * direction > d.excursion / 10).length;
        return delta * direction >= d.excursion && steps >= 2;
      });
      if (!driver) return null;
      this.active = { since_ms: start.timestamp_ms, driver, samples: [...this.history] };
      this.settled = [sample];
      this.reviewing = false;
      return { phase_id: this.phase.id, since_ms: start.timestamp_ms, started: true, completed: false, samples: [...this.history] };
    }
    const attempt = this.active;
    attempt.samples.push(sample);
    const current = this.value(sample, attempt.driver);
    if (current === null || sample.timestamp_ms - attempt.since_ms > this.maximumMs) { this.reset(); return null; }
    this.settled.push(sample);
    const moving = this.drivers.some(driver => {
      const values = this.settled.map(s => this.value(s, driver));
      return values.every(v => v !== null) && Math.max(...values as number[]) - Math.min(...values as number[]) > driver.excursion / 4;
    });
    if (moving) this.settled = [sample];
    const stableFor = sample.timestamp_ms - this.settled[0].timestamp_ms;
    const quietBody = this.quiet(sample.features);
    const completed = quietBody && this.settled.length >= 3 && stableFor >= 300 && sample.timestamp_ms - attempt.since_ms >= 400;
    const output: MotionAttempt = { phase_id: this.phase.id, since_ms: attempt.since_ms, started: false, completed, samples: [sample] };
    if (completed) {
      const endpoint = this.settled[0];
      output.samples = attempt.samples.filter(s => s.timestamp_ms <= endpoint.timestamp_ms);
      output.observed_end = { timestamp_ms: endpoint.timestamp_ms, frame_id: endpoint.frame_id };
      this.active = null;
      this.reviewing = true;
      this.history = [...this.settled];
      this.settled = [];
    }
    return output;
  }
}
