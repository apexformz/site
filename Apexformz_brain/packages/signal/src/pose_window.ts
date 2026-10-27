import type { FilteredPoseFrame } from './types';

export interface ResampledSeries {
  timestamps_ms: number[];
  /** [sample][landmark] -> {x,y,z} or null when masked */
  values: Array<Array<{ x: number; y: number; z: number | null } | null>>;
  /** true where an observation exists (not padded, not dropped) */
  mask: boolean[][];
  padded: boolean[];
}

/**
 * Timestamped, duration-bounded ring buffer of filtered frames (TRD 01/03).
 * Never interpolates across gaps; resampling exposes an explicit mask.
 */
export class PoseWindow {
  private frames: FilteredPoseFrame[] = [];

  constructor(public readonly durationMs: number) {}

  push(frame: FilteredPoseFrame): void {
    this.frames.push(frame);
    const cutoff = frame.timestamp_ms - this.durationMs;
    let drop = 0;
    while (drop < this.frames.length - 1 && this.frames[drop].timestamp_ms < cutoff) drop++;
    if (drop > 0) this.frames.splice(0, drop);
  }

  get size(): number {
    return this.frames.length;
  }

  latest(): FilteredPoseFrame | null {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  all(): readonly FilteredPoseFrame[] {
    return this.frames;
  }

  /** Frames with timestamp >= latest - spanMs (inclusive of latest). */
  recent(spanMs: number): readonly FilteredPoseFrame[] {
    const latest = this.latest();
    if (!latest) return [];
    const cutoff = latest.timestamp_ms - spanMs;
    let i = this.frames.length - 1;
    while (i > 0 && this.frames[i - 1].timestamp_ms >= cutoff) i--;
    return this.frames.slice(i);
  }

  since(timestampMs: number): readonly FilteredPoseFrame[] {
    return this.frames.filter((f) => f.timestamp_ms >= timestampMs);
  }

  clear(): void {
    this.frames = [];
  }

  /**
   * Fixed-rate resampling with missingness masks for model inputs (TRD 10).
   * A sample uses the nearest previous frame within `maxHoldMs`; otherwise it is padded.
   */
  resample(hz: number, spanMs: number, maxHoldMs: number): ResampledSeries {
    const latest = this.latest();
    const out: ResampledSeries = { timestamps_ms: [], values: [], mask: [], padded: [] };
    if (!latest) return out;
    const step = 1000 / hz;
    const n = Math.max(1, Math.round(spanMs / step));
    const start = latest.timestamp_ms - (n - 1) * step;
    let idx = 0;
    for (let k = 0; k < n; k++) {
      const t = start + k * step;
      while (idx + 1 < this.frames.length && this.frames[idx + 1].timestamp_ms <= t) idx++;
      const f = this.frames[idx];
      const usable = f && f.timestamp_ms <= t + 1e-6 && t - f.timestamp_ms <= maxHoldMs && f.normalization_valid;
      out.timestamps_ms.push(t);
      out.padded.push(!usable);
      if (!usable) {
        out.values.push([]);
        out.mask.push([]);
        continue;
      }
      out.values.push(f.body.map((l) => (l.valid ? { x: l.x, y: l.y, z: l.z } : null)));
      out.mask.push(f.body.map((l) => l.valid));
    }
    return out;
  }
}
