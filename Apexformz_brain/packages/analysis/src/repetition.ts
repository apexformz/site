import type { FeatureValue } from '@apexformz/contracts';
import type { FeatureMap } from '@apexformz/features';

/**
 * Class-agnostic repetition and periodicity estimation on skeleton feature
 * streams, inspired by RepNet (Dwibedi et al., CVPR 2020: temporal
 * self-similarity -> period). Operates on the pack-requested features only,
 * contains no sport knowledge, is strictly causal and resets on time gaps.
 *
 * Method per evaluation:
 *  1. Uniformly resample the multivariate feature history (z-normalised per feature).
 *  2. Temporal self-similarity S[i,j] = -||x_i - x_j||^2 over the window.
 *  3. Period score r(k) = mean of S along diagonal offset k, normalised by r(0);
 *     the best offset in [min_period, max_period] gives the period; its prominence
 *     over the mean gives a periodicity score in [0,1].
 *  4. Repetition boundaries are peaks of the dominant (highest-variance) feature spaced
 *     at least 0.6 periods apart; boundaries are counted once (monotonic counter).
 */
export interface RepetitionConfig {
  window_ms: number;
  sample_hz: number;
  min_period_ms: number;
  max_period_ms: number;
  evaluate_every_ms: number;
  /** Below this normalised motion energy the stream is considered still. */
  min_energy: number;
  /** Periodicity score required to report a period. */
  min_periodicity: number;
  /** Only features with these units take part (angles and normalised positions). */
  units: string[];
}

export const DEFAULT_REPETITION_CONFIG: RepetitionConfig = {
  window_ms: 6000,
  sample_hz: 15,
  min_period_ms: 400,
  max_period_ms: 4000,
  evaluate_every_ms: 250,
  min_energy: 0.05,
  min_periodicity: 0.35,
  units: ['deg', 'normalized', 'ratio'],
};

export interface RepetitionEstimate {
  evaluated_at_ms: number;
  periodic: boolean;
  period_ms: number | null;
  periodicity: number;
  energy: number;
  rep_count: number;
  last_boundary_ms: number | null;
  dominant_feature: string | null;
  samples: number;
  retrospective: false;
}

interface Sample {
  t: number;
  values: Map<string, number>;
}

export class RepetitionDetector {
  private history: Sample[] = [];
  private lastEval: number | null = null;
  private repCount = 0;
  private lastBoundary: number | null = null;
  private lastEstimate: RepetitionEstimate | null = null;
  readonly config: RepetitionConfig;

  constructor(config: Partial<RepetitionConfig> = {}) {
    this.config = { ...DEFAULT_REPETITION_CONFIG, ...config };
  }

  reset(): void {
    this.history = [];
    this.lastEval = null;
    this.lastBoundary = null;
    this.lastEstimate = null;
    // rep_count is cumulative for the session; callers reset the detector per session.
  }

  get estimate(): RepetitionEstimate | null {
    return this.lastEstimate;
  }

  /** Feed one frame of features; returns a fresh estimate when due, else the last one. */
  update(features: FeatureMap, timestampMs: number): RepetitionEstimate | null {
    const values = new Map<string, number>();
    for (const f of features.values()) {
      if (f.valid && f.value !== null && this.config.units.includes(f.unit) && Number.isFinite(f.value)) values.set(f.spec_id, f.value);
    }
    this.history.push({ t: timestampMs, values });
    const cutoff = timestampMs - this.config.window_ms;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
    if (this.lastEval !== null && timestampMs - this.lastEval < this.config.evaluate_every_ms) return this.lastEstimate;
    this.lastEval = timestampMs;
    this.lastEstimate = this.evaluate(timestampMs);
    return this.lastEstimate;
  }

  private evaluate(now: number): RepetitionEstimate {
    const base: RepetitionEstimate = { evaluated_at_ms: now, periodic: false, period_ms: null, periodicity: 0, energy: 0, rep_count: this.repCount, last_boundary_ms: this.lastBoundary, dominant_feature: null, samples: 0, retrospective: false };
    if (this.history.length < 8) return base;
    // Features present in at least 80% of samples.
    const counts = new Map<string, number>();
    for (const s of this.history) for (const k of s.values.keys()) counts.set(k, (counts.get(k) ?? 0) + 1);
    const ids = [...counts.entries()].filter(([, n]) => n >= 0.8 * this.history.length).map(([k]) => k);
    if (!ids.length) return base;

    // Uniform resampling (sample-and-hold to the previous observation).
    const step = 1000 / this.config.sample_hz;
    const start = this.history[0].t;
    const T = Math.max(2, Math.floor((now - start) / step) + 1);
    const X: number[][] = [];
    let idx = 0;
    for (let k = 0; k < T; k++) {
      const t = start + k * step;
      while (idx + 1 < this.history.length && this.history[idx + 1].t <= t) idx++;
      X.push(ids.map((id) => this.history[idx].values.get(id) ?? NaN));
    }
    // z-normalise per feature; track variance for dominance and energy.
    const D = ids.length;
    const means = new Array(D).fill(0);
    const stds = new Array(D).fill(0);
    for (let d = 0; d < D; d++) {
      const col = X.map((r) => r[d]).filter((v) => Number.isFinite(v));
      if (!col.length) continue;
      const m = col.reduce((a, b) => a + b, 0) / col.length;
      const v = col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length;
      means[d] = m;
      stds[d] = Math.sqrt(v);
    }
    // Energy: mean normalised std relative to a feature-unit scale (deg ~ 90, normalised ~ 0.5).
    const scales = ids.map((id) => (this.unitOf(id) === 'deg' ? 90 : 0.5));
    const energy = stds.reduce((a, s, d) => a + s / scales[d], 0) / D;
    base.energy = energy;
    base.samples = T;
    if (energy < this.config.min_energy) return base;

    const Z = X.map((r) => r.map((v, d) => (Number.isFinite(v) && stds[d] > 1e-9 ? (v - means[d]) / stds[d] : 0)));
    const dist2 = (a: number[], b: number[]) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);
    const kMin = Math.max(2, Math.round(this.config.min_period_ms / step));
    const kMax = Math.min(T - 2, Math.round(this.config.max_period_ms / step));
    if (kMax <= kMin) return base;
    const r: number[] = [];
    for (let k = kMin; k <= kMax; k++) {
      let s = 0;
      let n = 0;
      for (let i = 0; i + k < T; i++) {
        s += -dist2(Z[i], Z[i + k]);
        n++;
      }
      r.push(n ? s / n : -Infinity);
    }
    // r is <= 0; closer to 0 means similar. Convert to similarity in [0,1] via exp(-dist/D).
    const sim = r.map((v) => Math.exp(v / D));
    let best = 0;
    for (let i = 1; i < sim.length; i++) if (sim[i] > sim[best]) best = i;
    // Require a local maximum (not the window edge) for a credible period.
    const isPeak = best > 0 && best < sim.length - 1 && sim[best] >= sim[best - 1] && sim[best] >= sim[best + 1];
    const mean = sim.reduce((a, b) => a + b, 0) / sim.length;
    const periodicity = Math.max(0, Math.min(1, (sim[best] - mean) / Math.max(1e-6, 1 - mean)));
    const periodMs = (kMin + best) * step;
    const dominant = ids[stds.map((s, d) => s / scales[d]).reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0)];
    base.dominant_feature = dominant;
    base.periodicity = Number(periodicity.toFixed(3));
    if (!isPeak || periodicity < this.config.min_periodicity) return base;
    base.periodic = true;
    base.period_ms = Math.round(periodMs);

    // Count repetitions as peaks of the dominant feature spaced >= 0.6 period, counted once.
    const d = ids.indexOf(dominant);
    const series = X.map((row) => row[d]);
    const minGap = Math.max(1, Math.round((0.6 * periodMs) / step));
    const times = series.map((_, k) => start + k * step);
    for (let k = 1; k < T - 1; k++) {
      if (!(series[k] >= series[k - 1] && series[k] > series[k + 1])) continue;
      const t = times[k];
      if (this.lastBoundary !== null && t - this.lastBoundary < minGap * step) continue;
      if (this.lastBoundary !== null && t <= this.lastBoundary) continue;
      // Ignore peaks too close to the live edge: they may still grow (causal guard).
      if (T - 1 - k < 2) continue;
      // Peak must be prominent relative to the feature's spread.
      if (series[k] - means[d] < 0.3 * stds[d]) continue;
      if (this.lastBoundary !== null) this.repCount++;
      this.lastBoundary = t;
    }
    base.rep_count = this.repCount;
    base.last_boundary_ms = this.lastBoundary;
    return base;
  }

  private units = new Map<string, string>();

  /** Remember units from the latest feature map (cheap lookup used for energy scaling). */
  noteUnits(features: Iterable<FeatureValue>): void {
    for (const f of features) this.units.set(f.spec_id, f.unit);
  }

  private unitOf(id: string): string {
    return this.units.get(id) ?? 'normalized';
  }
}
