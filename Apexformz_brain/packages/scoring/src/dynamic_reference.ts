import type { CriterionState, Handedness, MissingReason, Unit, ViewLabel } from '@apexformz/contracts';
import { validateDynamicReferenceModel, type DynamicReferenceModel } from '../../contracts/src/dynamic_reference';
import type { FeatureMap } from '@apexformz/features';

type Reference = DynamicReferenceModel['references'][number];
type ReferenceFeature = DynamicReferenceModel['features'][number];
interface Sample { timestamp_ms: number; frame_id: number; values: Array<number | null> }
interface Path {
  reference: Reference;
  values: Array<Array<number | null>>;
  weights: number[];
  costs: number[];
  frames: number;
  best: number;
  previous_best: number;
  cumulative_error: number;
  faults: Map<string, DynamicReferenceDeviation>;
  sequenceErrors: number;
}

export interface DynamicReferenceDeviation {
  feature_id: string;
  observed: number;
  reference: number;
  unit: Unit;
  tolerance: number;
  normalized_error: number;
  weighted_squared_contribution: number;
  outside_reference_band: boolean;
  reference_progress?: number;
}

export interface DynamicReferenceComparison {
  attempt_id: string | null;
  status: 'waiting' | 'active' | 'complete' | 'incomplete' | 'unavailable';
  state: CriterionState;
  progress: number;
  reference_id: string | null;
  confidence: number;
  distance: number | null;
  coverage: number;
  deviations: DynamicReferenceDeviation[];
  sequence_mismatch: boolean;
  alignment_ambiguous: boolean;
  reason: MissingReason | null;
  /** Current-frame evidence only. Finished attempt evidence must never recolour the current body. */
  current: boolean;
  completed: boolean;
  /** End of the available reference segment reached; does not establish a whole movement. */
  segment_matched: boolean;
  cue_allowed: boolean;
  since_ms: number | null;
  timestamp_ms: number;
  frame_id: number;
  evidence_frames: number[];
}

export interface DynamicReferenceOptions {
  view: ViewLabel;
  handedness: Handedness;
  handedness_assumed?: boolean;
  minimum_confidence?: number;
  emit_interval_ms?: number;
  max_gap_ms?: number;
}

export interface DynamicReferenceObservation {
  timestamp_ms: number;
  frame_id: number;
  features: FeatureMap;
  quality_ok: boolean;
  continuity_broken?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Causal selected-target comparison against measured recordings. This is a
 * provisional similarity assessment, never a movement recognizer, contact
 * detector or repetition counter. A bounded monotonic path allows speed
 * changes while retaining the observed order of the reference trajectory.
 */
export class DynamicReferenceComparator {
  private readonly references: Reference[];
  private readonly unavailableReason: MissingReason | null;
  private history: Sample[] = [];
  private active: { id: string; start: Sample; samples: Sample[]; paths: Path[]; quiet: Sample[] } | null = null;
  private last: Sample | null = null;
  private lastEmit = -Infinity;
  private sequence = 0;
  private previousDeviations = new Map<string, { frame_id: number; timestamp_ms: number }>();
  private latestResult: DynamicReferenceComparison | null = null;
  private awaitingRest = false;
  private rearmQuiet: Sample[] = [];
  private completedAttemptId: string | null = null;

  constructor(private readonly model: DynamicReferenceModel, private readonly options: DynamicReferenceOptions) {
    try { validateDynamicReferenceModel(model); }
    catch { this.references = []; this.unavailableReason = 'MODEL_UNAVAILABLE'; return; }
    const usable = model.references.filter(r => r.samples.length >= 5 && r.duration_ms >= 300 &&
      r.samples.every((s, i) => finite(s.t_ms) && s.values.length === model.features.length && (!i || s.t_ms > r.samples[i - 1].t_ms)));
    const view = usable.filter(r => r.view === options.view);
    this.references = view.filter(r => r.handedness === options.handedness && r.handedness !== 'unknown');
    this.unavailableReason = options.view === 'unknown' || !view.length && usable.length ? 'VIEW_INVALID'
      : options.handedness === 'unknown' || options.handedness_assumed || !this.references.length && view.length ? 'HANDEDNESS_UNKNOWN'
      : !this.references.length ? 'MODEL_UNAVAILABLE' : null;
  }

  reset(): void {
    this.history = [];
    this.active = null;
    this.last = null;
    this.lastEmit = -Infinity;
    this.previousDeviations.clear();
    this.latestResult = null;
    this.awaitingRest = false;
    this.rearmQuiet = [];
    this.completedAttemptId = null;
  }

  get available(): boolean { return !this.unavailableReason; }

  /** Fresh observed stillness; a missing or stale frame cannot authorize speech. */
  get cueAllowed(): boolean { return this.latestResult?.cue_allowed === true; }

  observe(input: DynamicReferenceObservation): DynamicReferenceComparison | null {
    if (!finite(input.timestamp_ms) || !finite(input.frame_id)) return null;
    if (this.last && (input.timestamp_ms <= this.last.timestamp_ms || input.frame_id <= this.last.frame_id)) return null;
    const gap = this.last && input.timestamp_ms - this.last.timestamp_ms > (this.options.max_gap_ms ?? 400);
    if (!input.quality_ok || input.continuity_broken || gap) {
      this.reset();
      return this.publish(this.empty(input, 'unavailable', gap || input.continuity_broken ? 'TIME_GAP' : 'LOW_CONFIDENCE'), true);
    }
    if (this.unavailableReason) return this.publish(this.empty(input, 'unavailable', this.unavailableReason));
    const values = this.model.features.map(f => {
      const value = input.features.get(f.id);
      return value?.valid && !value.retrospective && Math.abs(value.timestamp_ms - input.timestamp_ms) <= 1 && finite(value.value) && (value.confidence ?? 0) >= (this.options.minimum_confidence ?? 0.5)
        ? value.value : null;
    });
    const current: Sample = { frame_id: input.frame_id, timestamp_ms: input.timestamp_ms, values };
    const weighted = this.model.features.filter(f => f.weight > 0);
    const coverage = weighted.length ? this.model.features.reduce((n, f, i) => n + (f.weight > 0 && values[i] !== null ? f.weight : 0), 0) / weighted.reduce((n, f) => n + f.weight, 0) : 0;
    if (coverage < 0.65) {
      this.reset();
      this.last = current;
      return this.publish(this.empty(input, 'unavailable', 'COVERAGE_INSUFFICIENT'), true);
    }
    const previous = this.last;
    this.last = current;
    if (this.awaitingRest) {
      const quiet = previous && this.motion(previous, current) < 0.2;
      this.rearmQuiet = quiet && (!this.rearmQuiet.length || this.motion(this.rearmQuiet[0], current) < 0.25)
        ? [...this.rearmQuiet, current].slice(-30) : [current];
      const settled = this.rearmQuiet.length >= 3 && current.timestamp_ms - this.rearmQuiet[0].timestamp_ms >= 300;
      const waiting = this.empty(input, 'waiting', 'INSUFFICIENT_HISTORY');
      waiting.cue_allowed = settled;
      if (settled) { this.awaitingRest = false; this.history = [current]; }
      return this.publish(waiting);
    }
    this.history.push(current);
    this.history = this.history.filter(s => input.timestamp_ms - s.timestamp_ms <= 700).slice(-30);
    if (!this.active) {
      // Onset is measured motion, independent of matching the expected start
      // posture. An imperfect attempt must still reach corrective comparison.
      const oldest = this.history[0];
      const movement = this.motion(oldest, current);
      if (this.history.length < 3 || input.timestamp_ms - oldest.timestamp_ms < 100 || movement < 0.35) {
        const quiet = this.history.length >= 3 && input.timestamp_ms - oldest.timestamp_ms >= 300 && this.history.every(s => this.motion(oldest, s) < 0.25);
        const waiting = this.empty(input, 'waiting', 'INSUFFICIENT_HISTORY');
        waiting.cue_allowed = quiet;
        return this.publish(waiting);
      }
      // Keep the sample immediately before observable motion, not an entire
      // idle warm-up. Padding a short reference with a long idle prefix would
      // otherwise force temporal progress ahead of the athlete.
      const firstChange = this.history.findIndex(s => this.motion(oldest, s) > 0.1);
      const onsetIndex = Math.max(0, firstChange - 1);
      const anchor = this.history[onsetIndex];
      this.active = {
        id: `${this.model.movement_id}:reference:${++this.sequence}:${anchor.frame_id}`,
        start: anchor, samples: [], paths: this.references.map(r => this.newPath(r)), quiet: [],
      };
      this.completedAttemptId = null;
      this.previousDeviations.clear();
      for (const sample of this.history.slice(onsetIndex)) this.advance(sample);
    } else this.advance(current);
    const active = this.active;
    if (!active) return null;
    const quiet = previous && this.motion(previous, current) < 0.2;
    // A small frame-to-frame displacement at high FPS is not stillness.
    // Require a small displacement across the entire quiet dwell as well.
    active.quiet = quiet && (!active.quiet.length || this.motion(active.quiet[0], current) < 0.25)
      ? [...active.quiet, current].slice(-30) : [current];
    const settled = active.quiet.length >= 3 && input.timestamp_ms - active.quiet[0].timestamp_ms >= 300;
    const result = this.result(current, coverage);
    if (!result) return this.publish(this.empty(input, 'active', 'MOVEMENT_NOT_CONFIRMED'));
    const path = active.paths.find(p => p.reference.id === result.reference_id)!;
    const elapsed = input.timestamp_ms - active.start.timestamp_ms;
    const maximum = Math.min(20000, Math.max(...this.references.map(r => r.duration_ms)) * 3 + 1000);
    let holdEnd = path.best;
    while (holdEnd + 1 < path.values.length && this.relativeMotion(path.values[path.best], path.values[holdEnd + 1]) < 0.35) holdEnd++;
    const expectedHold = path.reference.samples[holdEnd].t_ms - path.reference.samples[path.best].t_ms;
    const quietMs = active.quiet.length ? input.timestamp_ms - active.quiet[0].timestamp_ms : 0;
    const observedEnd = path.best === path.values.length - 1 || result.progress >= 0.85 && holdEnd === path.values.length - 1;
    // A recorded sequence can contain a legitimate pause between actions. A
    // short quiet period in its middle is not an incomplete execution.
    const finishAtRest = settled && elapsed >= 500 && (observedEnd || result.sequence_mismatch && quietMs >= Math.max(900, expectedHold * 3 + 300));
    const partialEndpoint = !path.reference.complete_capture && observedEnd && active.samples.length >= 5 && elapsed >= 300;
    result.cue_allowed = settled;
    if (finishAtRest || partialEndpoint || elapsed > maximum) {
      const segment = observedEnd && active.samples.length >= 5 &&
        elapsed >= path.reference.duration_ms * 0.3 && !result.alignment_ambiguous;
      const full = path.reference.complete_capture && segment;
      result.status = full ? 'complete' : 'incomplete';
      result.completed = full;
      result.segment_matched = segment;
      result.current = false;
      result.cue_allowed = settled;
      // Retain the worst supported local discrepancy observed earlier in the
      // attempt, rather than replacing it with a correct final rest posture.
      const final = new Map(result.deviations.map(d => [d.feature_id, d]));
      for (const [id, fault] of path.faults) if (!final.get(id)?.outside_reference_band) final.set(id, fault);
      result.deviations = [...final.values()];
      result.sequence_mismatch ||= path.sequenceErrors >= 3;
      result.state = result.sequence_mismatch || path.faults.size ? 'IMPROVE' : full ? 'PASS' : 'UNCERTAIN';
      result.reason = !path.reference.complete_capture ? 'COVERAGE_INSUFFICIENT' : result.sequence_mismatch ? 'MOVEMENT_NOT_CONFIRMED' : null;
      // A partial source is useful for measured local comparison; it is never
      // evidence that the complete catalogue movement was performed.
      if (!path.reference.complete_capture && !path.faults.size && !result.sequence_mismatch) result.state = 'UNCERTAIN';
      this.active = null;
      this.completedAttemptId = active.id;
      this.history = [current];
      this.awaitingRest = true;
      this.rearmQuiet = [];
      this.previousDeviations.clear();
      return this.publish(result, true);
    }
    return this.publish(result);
  }

  private newPath(reference: Reference): Path {
    const values = reference.samples.map(s => this.transform(s.values, reference.samples[0].values));
    const weights = this.model.features.map((f, i) => {
      const observed = values.map(v => v[i]).filter(finite);
      const spread = observed.length ? (Math.max(...observed) - Math.min(...observed)) / f.tolerance : 0;
      // Dynamic dimensions drive alignment; fixed posture still contributes a
      // small amount and is independently assessed for local corrections.
      return f.weight * clamp(spread, 0.2, 3);
    });
    return { reference, values, weights, costs: Array(values.length).fill(Infinity), frames: 0, best: 0, previous_best: 0, cumulative_error: 0, faults: new Map(), sequenceErrors: 0 };
  }

  private transform(values: Array<number | null>, baseline: Array<number | null>): Array<number | null> {
    return this.model.features.map((feature, i) => {
      const f = feature as ReferenceFeature & { relative_to_start?: boolean; scale_feature_id?: string };
      if (!finite(values[i])) return null;
      let value = values[i]!;
      if (f.relative_to_start) {
        if (!finite(baseline[i])) return null;
        value -= baseline[i]!;
      }
      if (f.scale_feature_id) {
        const scale = baseline[this.model.features.findIndex(s => s.id === f.scale_feature_id)];
        if (!finite(scale) || Math.abs(scale) < 1e-6) return null;
        value /= Math.abs(scale);
      }
      return value;
    });
  }

  private motion(a: Sample, b: Sample): number {
    const av = this.transform(a.values, a.values), bv = this.transform(b.values, a.values);
    return this.relativeMotion(av, bv);
  }

  private relativeMotion(av: Array<number | null>, bv: Array<number | null>): number {
    const changes = this.model.features.map((f, i) => f.weight > 0 && finite(av[i]) && finite(bv[i]) ? Math.abs(bv[i]! - av[i]!) / f.tolerance : 0);
    // One clearly moving limb is sufficient to begin an attempted action.
    return Math.max(0, ...changes);
  }

  private advance(sample: Sample): void {
    const active = this.active!;
    const previous = active.samples.at(-1);
    if (previous && sample.frame_id <= previous.frame_id) return;
    const observed = this.transform(sample.values, active.start.values);
    const elapsed = sample.timestamp_ms - active.start.timestamp_ms;
    for (const path of active.paths) {
      const n = path.values.length;
      const nominalStep = path.reference.duration_ms / (n - 1);
      const dt = previous ? sample.timestamp_ms - previous.timestamp_ms : 0;
      const maxAdvance = Math.min(Math.ceil((n - 1) * 0.25), Math.max(1, Math.ceil(dt / nominalStep * 3) + 1));
      const row = Array(n).fill(Infinity);
      // At least one third / at most three times recorded speed. The soft
      // early margin absorbs slightly imprecise automatically trimmed starts.
      const low = Math.max(0, Math.floor(elapsed / (path.reference.duration_ms * 3) * (n - 1)) - 2);
      const high = Math.min(n - 1, Math.ceil(elapsed / (path.reference.duration_ms * 0.3) * (n - 1)) + 2);
      for (let j = low; j <= high; j++) {
        const local = this.cost(observed, path.values[j], path.weights);
        if (!finite(local)) continue;
        if (!path.frames) {
          // Never initialize on the middle/end merely because the current
          // posture happens to resemble it.
          if (j === 0) row[j] = local;
        } else {
          for (let k = Math.max(0, j - maxAdvance); k <= j; k++) {
            const temporalPenalty = 0.015 * Math.abs(j - k - dt / nominalStep);
            row[j] = Math.min(row[j], path.costs[k] + local + temporalPenalty);
          }
        }
      }
      path.costs = row;
      path.frames++;
      path.previous_best = path.best;
      let best = path.best;
      let bestCost = Infinity;
      for (let j = path.best; j <= Math.min(n - 1, path.best + maxAdvance); j++) if (row[j] < bestCost) { best = j; bestCost = row[j]; }
      path.best = best;
      path.cumulative_error = bestCost / path.frames;
    }
    active.samples.push(sample);
    // Bound retained evidence without losing the immutable onset anchor.
    if (active.samples.length > 300) active.samples.splice(1, active.samples.length - 300);
  }

  private cost(observed: Array<number | null>, reference: Array<number | null>, weights: number[]): number {
    let sum = 0, weight = 0, all = 0;
    for (let i = 0; i < weights.length; i++) {
      // A missing source measurement cannot be an expected visible channel.
      // Requiring its weight would discard the correct reference path and
      // accidentally compare the athlete with a different fragment instead.
      if (!finite(reference[i])) continue;
      all += weights[i];
      if (!finite(observed[i])) continue;
      const error = (observed[i]! - reference[i]!) / this.model.features[i].tolerance;
      sum += Math.min(9, error * error) * weights[i];
      weight += weights[i];
    }
    return weight && weight / all >= 0.6 ? sum / weight : Infinity;
  }

  private result(sample: Sample, coverage: number): DynamicReferenceComparison | null {
    const active = this.active!;
    const ordered = [...active.paths].filter(p => finite(p.cumulative_error)).sort((a, b) => a.cumulative_error - b.cumulative_error);
    if (!ordered.length) return null;
    // Every candidate has independently aligned the entire observed prefix.
    // Choose the best whole-prefix path as evidence arrives; locking an early
    // shared prefix would reject a legitimate later branch. Fault histories
    // remain source-specific, so references are never spliced into one review.
    const path = ordered[0];
    const observed = this.transform(sample.values, active.start.values), reference = path.values[path.best];
    const progress = path.best / (path.values.length - 1);
    const currentCost = this.cost(observed, reference, path.weights);
    const ambiguous = !finite(currentCost) || path.cumulative_error > 3 || path.best + 2 < path.previous_best;
    const deviations: DynamicReferenceDeviation[] = [];
    for (let i = 0; i < this.model.features.length; i++) {
      const f = this.model.features[i];
      if (f.weight <= 0 || !finite(observed[i]) || !finite(reference[i])) continue;
      const error = Math.abs(observed[i]! - reference[i]!) / f.tolerance;
      const key = `${path.reference.id}:${f.id}`;
      const prior = this.previousDeviations.get(key);
      const supported = error > 1 && !ambiguous && prior !== undefined && prior.frame_id !== sample.frame_id &&
        sample.timestamp_ms - prior.timestamp_ms <= (this.options.max_gap_ms ?? 400);
      if (error > 1 && !ambiguous) this.previousDeviations.set(key, { frame_id: sample.frame_id, timestamp_ms: sample.timestamp_ms });
      else this.previousDeviations.delete(key);
      const deviation: DynamicReferenceDeviation = {
        feature_id: f.id, observed: observed[i]!, reference: reference[i]!, unit: f.unit,
        tolerance: f.tolerance, normalized_error: error,
        weighted_squared_contribution: error * error * f.weight,
        outside_reference_band: supported && !ambiguous,
        reference_progress: progress,
      };
      deviations.push(deviation);
      if (deviation.outside_reference_band && (!path.faults.has(f.id) || path.faults.get(f.id)!.normalized_error < error)) path.faults.set(f.id, deviation);
    }
    const mismatch = path.cumulative_error > 1.6 && active.samples.length >= 5;
    if (mismatch) path.sequenceErrors++;
    const bad = deviations.some(d => d.outside_reference_band);
    return {
      attempt_id: active.id, status: 'active', state: bad || mismatch ? 'IMPROVE' : 'UNCERTAIN',
      progress, reference_id: path.reference.id, confidence: ambiguous ? 0.3 : coverage * 0.85,
      distance: Math.sqrt(path.cumulative_error), coverage, deviations,
      sequence_mismatch: mismatch, alignment_ambiguous: ambiguous, reason: ambiguous ? 'MOVEMENT_NOT_CONFIRMED' : null,
      current: true, completed: false, segment_matched: false, cue_allowed: false,
      since_ms: active.start.timestamp_ms, timestamp_ms: sample.timestamp_ms, frame_id: sample.frame_id,
      evidence_frames: active.samples.slice(-6).map(s => s.frame_id),
    };
  }

  private empty(input: Pick<DynamicReferenceObservation, 'timestamp_ms' | 'frame_id'>, status: DynamicReferenceComparison['status'], reason: MissingReason): DynamicReferenceComparison {
    return { attempt_id: status === 'waiting' ? this.completedAttemptId : null, status, state: status === 'unavailable' ? 'NOT_ASSESSABLE' : 'UNCERTAIN', progress: 0,
      reference_id: null, confidence: 0, distance: null, coverage: 0, deviations: [], sequence_mismatch: false,
      alignment_ambiguous: true, reason, current: false, completed: false, segment_matched: false, cue_allowed: false,
      since_ms: null, timestamp_ms: input.timestamp_ms, frame_id: input.frame_id, evidence_frames: [] };
  }

  private publish(result: DynamicReferenceComparison, force = false): DynamicReferenceComparison | null {
    this.latestResult = result;
    if (!force && result.timestamp_ms - this.lastEmit < (this.options.emit_interval_ms ?? 200)) return null;
    this.lastEmit = result.timestamp_ms;
    return result;
  }
}
