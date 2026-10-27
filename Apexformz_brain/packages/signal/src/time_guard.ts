import type { TimeGuardResult } from './types';

/**
 * Enforces capture-monotonic time (TRD 03). Detects timestamp regression,
 * duplicate samples and gaps. Velocities are never derived from nominal FPS.
 */
export class TimeGuard {
  private lastTs: number | null = null;
  private lastFrameId: number | null = null;
  readonly maxGapMs: number;
  private regressions = 0;
  private duplicates = 0;
  private gaps = 0;

  constructor(maxGapMs: number) {
    this.maxGapMs = maxGapMs;
  }

  get stats() {
    return { regressions: this.regressions, duplicates: this.duplicates, gaps: this.gaps };
  }

  check(timestampMs: number, frameId: number): TimeGuardResult {
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      this.regressions++;
      return { accepted: false, dt_ms: null, gap: false, regression: true, duplicate: false };
    }
    if (this.lastTs === null) {
      this.lastTs = timestampMs;
      this.lastFrameId = frameId;
      return { accepted: true, dt_ms: null, gap: false, regression: false, duplicate: false };
    }
    if (this.lastFrameId !== null && frameId <= this.lastFrameId) {
      // Frame ordering is the exact ordering key inside one camera stream.
      if (frameId === this.lastFrameId && timestampMs === this.lastTs) {
        this.duplicates++;
        return { accepted: false, dt_ms: null, gap: false, regression: false, duplicate: true };
      }
      this.regressions++;
      return { accepted: false, dt_ms: null, gap: false, regression: true, duplicate: false };
    }
    const dt = timestampMs - this.lastTs;
    if (dt < 0) {
      this.regressions++;
      return { accepted: false, dt_ms: null, gap: false, regression: true, duplicate: false };
    }
    if (dt === 0) {
      this.duplicates++;
      return { accepted: false, dt_ms: null, gap: false, regression: false, duplicate: true };
    }
    const gap = dt > this.maxGapMs;
    if (gap) this.gaps++;
    this.lastTs = timestampMs;
    this.lastFrameId = frameId;
    return { accepted: true, dt_ms: gap ? null : dt, gap, regression: false, duplicate: false };
  }

  reset(): void {
    this.lastTs = null;
    this.lastFrameId = null;
  }
}
