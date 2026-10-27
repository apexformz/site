/**
 * Human variance model (TRD 11 "no fabricated normative cutoffs", "avoid assuming one ideal body posture").
 *
 * Humans do not reproduce a movement exactly: skilled athletes vary trial to trial, individuals differ in
 * anthropometry, and the pose pipeline itself has a measurement floor. A criterion therefore cannot treat
 * "one degree past the limit" as an error. This module turns a pack's crisp limit into three zones:
 *
 *   PASS                          inside the acceptable region
 *   WITHIN_NORMAL_VARIANCE        outside it by less than the variance band (UNCERTAIN, no correction)
 *   IMPROVE                       beyond the band
 *
 * The band combines, in quadrature, (a) the pack's relative allowance for natural human variability (a fraction
 * of the reference magnitude, e.g. 5%), and (b) the pack's minimal detectable change for the measurement unit,
 * then applies the pack's athlete-context factor, with the measurement floor and tolerance as lower bounds.
 *
 * A second, longitudinal layer looks at the athlete's own repetitions: a single deviating repetition that sits
 * inside the athlete's recent spread, while most repetitions pass, is treated as natural trial-to-trial
 * variability rather than a technique error. A consistent deviation across repetitions is corrected.
 *
 * The sport pack owns every number (TRD 05 ownership rule): the rubric declares a `human_variance` profile and
 * criteria may set `human_variance_relative`. The core defaults are inert. Nothing here names a sport; the
 * research behind the squash profile is in docs/07_HUMAN_VARIANCE.md.
 */
import type { AthleteContext, CriterionDefinition, Unit } from '@apexformz/contracts';

export interface HumanVarianceConfig {
  /** Fraction of the reference magnitude treated as normal human variability (0.05 = 5%). */
  relative: number;
  /** Minimal detectable change of a single measurement, per unit (same units as the measurement). */
  measurement_floor: Partial<Record<Unit, number>>;
  /** Multiplier on the band by athlete context: novices are more variable, advanced athletes less. */
  context_scale: Record<AthleteContext, number>;
  /** Longitudinal (repetition) layer. */
  consistency: {
    enabled: boolean;
    /** Repetitions of the same criterion kept per session. */
    window: number;
    /** Minimum repetitions before the athlete's own spread is trusted. */
    min_reps: number;
    /** A deviating repetition within k standard deviations of the athlete's own mean is natural variability. */
    k_sd: number;
    /** If at least this fraction of recent repetitions fail, the deviation is consistent and is corrected. */
    fail_fraction: number;
  };
}

/**
 * Core defaults are INERT: no relative allowance, no measurement floor, no context scaling and no repetition
 * layer. The shared Brain carries no variance numbers; every figure comes from the sport pack's rubric profile
 * (`aggregation.human_variance`, per-criterion `evaluator.human_variance_relative`). Without a profile a pack
 * behaves exactly as before: a crisp limit with the pack's own soft tolerance.
 */
export const DEFAULT_HUMAN_VARIANCE: HumanVarianceConfig = {
  relative: 0,
  measurement_floor: {},
  context_scale: { novice: 1, intermediate: 1, advanced: 1, unknown: 1 },
  consistency: { enabled: false, window: 8, min_reps: 3, k_sd: 2.0, fail_fraction: 0.5 },
};

export type HumanVarianceOverrides = Partial<Omit<HumanVarianceConfig, 'consistency' | 'context_scale' | 'measurement_floor'>> & {
  measurement_floor?: Partial<Record<Unit, number>>;
  context_scale?: Partial<Record<AthleteContext, number>>;
  consistency?: Partial<HumanVarianceConfig['consistency']>;
};

export function mergeHumanVariance(...layers: Array<HumanVarianceOverrides | null | undefined>): HumanVarianceConfig {
  const out: HumanVarianceConfig = {
    ...DEFAULT_HUMAN_VARIANCE,
    measurement_floor: { ...DEFAULT_HUMAN_VARIANCE.measurement_floor },
    context_scale: { ...DEFAULT_HUMAN_VARIANCE.context_scale },
    consistency: { ...DEFAULT_HUMAN_VARIANCE.consistency },
  };
  for (const l of layers) {
    if (!l) continue;
    if (typeof l.relative === 'number' && l.relative >= 0 && l.relative <= 0.5) out.relative = l.relative;
    if (l.measurement_floor) for (const [u, v] of Object.entries(l.measurement_floor)) if (typeof v === 'number' && v >= 0) out.measurement_floor[u as Unit] = v;
    if (l.context_scale) for (const [k, v] of Object.entries(l.context_scale)) if (typeof v === 'number' && v > 0) out.context_scale[k as AthleteContext] = v;
    if (l.consistency) out.consistency = { ...out.consistency, ...l.consistency };
  }
  return out;
}

type Evaluator = CriterionDefinition['evaluator'];

/** Magnitude the relative allowance applies to: the limit, or the span of a range (never a value near zero). */
export function referenceMagnitude(ev: Evaluator): number {
  switch (ev.kind) {
    case 'range': {
      const [lo, hi] = ev.range as [number, number];
      return Math.max(Math.abs(hi - lo), 1e-9);
    }
    case 'ordering':
      return ev.limit ?? 1;
    default:
      return Math.abs(ev.limit ?? 0);
  }
}

export interface VarianceBand {
  band: number;
  relative_component: number;
  measurement_component: number;
  pack_tolerance: number;
  context_scale: number;
}

/**
 * Effective variance band for one criterion in the measurement's unit:
 *   max(measurement floor, pack tolerance, max(pack tolerance, hypot(relative * reference magnitude, measurement floor)) * context scale).
 */
export function varianceBand(ev: Evaluator, unit: Unit, context: AthleteContext, cfg: HumanVarianceConfig): VarianceBand {
  const relative = typeof ev.human_variance_relative === 'number' ? ev.human_variance_relative : cfg.relative;
  const relComponent = relative * referenceMagnitude(ev);
  const floor = cfg.measurement_floor[unit] ?? 0;
  const packTol = ev.tolerance ?? 0;
  const scale = cfg.context_scale[context] ?? 1;
  // Without a declared profile the model is inert: no band at all, and the pack's tolerance keeps its original
  // meaning (soft score decay on IMPROVE). With a profile, the tolerance is the lower bound of the band.
  const declared = relative > 0 || floor > 0;
  const band = declared ? Math.max(floor, packTol, Math.max(packTol, Math.hypot(relComponent, floor)) * scale) : 0;
  return { band, relative_component: relComponent, measurement_component: floor, pack_tolerance: packTol, context_scale: scale };
}

export type VarianceZone = 'pass' | 'within_variance' | 'improve';

/** Zone of a non-passing distance relative to the band. */
export function zoneFor(pass: boolean, distance: number, band: number): VarianceZone {
  if (pass || distance <= 0) return 'pass';
  return distance <= band ? 'within_variance' : 'improve';
}

export interface RepetitionStats {
  reps: number;
  mean: number;
  sd: number;
  /** Coefficient of variation (sd / |mean|), null when the mean is ~0. */
  cv: number | null;
  fail_fraction: number;
}

/**
 * Per-criterion history of the athlete's own repetitions within a session. One value per execution (the
 * latest verdict of that execution wins), bounded window, deterministic.
 */
export class RepetitionVarianceTracker {
  private history = new Map<string, Array<{ execution: string; value: number; fail: boolean }>>();

  constructor(private readonly cfg: HumanVarianceConfig['consistency']) {}

  reset(): void {
    this.history.clear();
  }

  record(criterionId: string, executionId: string | null, value: number, fail: boolean): void {
    if (!this.cfg.enabled) return;
    const key = executionId ?? 'live';
    const list = this.history.get(criterionId) ?? [];
    const idx = list.findIndex((h) => h.execution === key);
    if (idx >= 0) list[idx] = { execution: key, value, fail };
    else list.push({ execution: key, value, fail });
    while (list.length > this.cfg.window) list.shift();
    this.history.set(criterionId, list);
  }

  stats(criterionId: string, excludeExecutionId?: string | null): RepetitionStats | null {
    const history = this.history.get(criterionId);
    const excluded = excludeExecutionId === null ? 'live' : excludeExecutionId;
    const list = excluded === undefined ? history : history?.filter((h) => h.execution !== excluded);
    if (!list || !list.length) return null;
    const n = list.length;
    const mean = list.reduce((a, h) => a + h.value, 0) / n;
    const sd = n > 1 ? Math.sqrt(list.reduce((a, h) => a + (h.value - mean) ** 2, 0) / (n - 1)) : 0;
    return { reps: n, mean, sd, cv: Math.abs(mean) > 1e-9 ? sd / Math.abs(mean) : null, fail_fraction: list.filter((h) => h.fail).length / n };
  }

  /**
   * Is this failing repetition natural trial-to-trial variability? True when enough repetitions exist, most of
   * them pass, and the value lies within k standard deviations of previous executions. Every update from the
   * current execution is excluded, including earlier live assessments of a static hold. A new outlier cannot
   * inflate its own baseline, whether or not it has already been recorded.
   */
  isNaturalVariation(criterionId: string, value: number, currentExecutionId: string | null): { natural: boolean; stats: RepetitionStats | null } {
    const stats = this.stats(criterionId, currentExecutionId);
    if (!this.cfg.enabled || !stats || stats.reps < this.cfg.min_reps) return { natural: false, stats };
    if (stats.fail_fraction >= this.cfg.fail_fraction) return { natural: false, stats };
    const within = stats.sd > 0 ? Math.abs(value - stats.mean) <= this.cfg.k_sd * stats.sd : false;
    return { natural: within, stats };
  }
}
