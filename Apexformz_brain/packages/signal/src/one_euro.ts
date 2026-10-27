/**
 * One-Euro filter (Casiez, Roussel, Vogel, CHI 2012), ported from the
 * existing ApexFormz Python `signal_filter.py` and made timestamp-aware.
 * Parameters are candidates (TRD 03), not validated constants.
 */
class LowPass {
  private s = 0;
  private initialized = false;

  filter(value: number, alpha: number): number {
    const a = Math.max(0, Math.min(1, alpha));
    if (!this.initialized) {
      this.s = value;
      this.initialized = true;
    } else {
      this.s = a * value + (1 - a) * this.s;
    }
    return this.s;
  }

  get last(): number {
    return this.s;
  }

  get ready(): boolean {
    return this.initialized;
  }

  reset(): void {
    this.s = 0;
    this.initialized = false;
  }
}

export class OneEuroFilter {
  private readonly x = new LowPass();
  private readonly dx = new LowPass();
  private lastT: number | null = null;

  constructor(
    public minCutoff = 1.0,
    public beta = 0.007,
    public dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dtSeconds: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dtSeconds);
  }

  /** `tSeconds` must be monotonic; a non-positive dt falls back to 1/30 s. */
  filter(value: number, tSeconds: number): number {
    let dt = this.lastT === null ? 1 / 30 : tSeconds - this.lastT;
    if (!(dt > 0)) dt = 1 / 30;
    this.lastT = tSeconds;

    const prev = this.x.last;
    const rawDx = this.x.ready ? (value - prev) / dt : 0;
    const edx = this.dx.filter(rawDx, OneEuroFilter.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastT = null;
  }
}

/**
 * Per-landmark, per-axis One-Euro smoothing with a shared parameter set.
 * Invalid observations are passed through untouched and do not update state.
 */
export class LandmarkSmoother {
  private filters = new Map<string, OneEuroFilter>();

  constructor(
    private readonly params: { min_cutoff: number; beta: number; d_cutoff: number },
  ) {}

  private get(key: string): OneEuroFilter {
    let f = this.filters.get(key);
    if (!f) {
      f = new OneEuroFilter(this.params.min_cutoff, this.params.beta, this.params.d_cutoff);
      this.filters.set(key, f);
    }
    return f;
  }

  smooth(id: number, axis: 'x' | 'y' | 'z', value: number, tSeconds: number): number {
    return this.get(`${id}${axis}`).filter(value, tSeconds);
  }

  /** Drop filter state for one landmark (e.g. after a rejected outlier). */
  resetLandmark(id: number): void {
    for (const axis of ['x', 'y', 'z'] as const) this.filters.get(`${id}${axis}`)?.reset();
  }

  reset(): void {
    this.filters.clear();
  }
}
