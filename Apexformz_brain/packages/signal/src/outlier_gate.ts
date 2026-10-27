import type { FilteredLandmark } from './types';

interface Track {
  x: number;
  y: number;
  z: number | null;
  t: number;
  vx: number;
  vy: number;
  predicted: boolean;
}

/**
 * Joint outlier gate (TRD 03): rejects physically implausible jumps relative
 * to confidence and elapsed time. Optionally predicts one short gap; predicted
 * samples are flagged so evidence reliability is reduced downstream.
 */
export class OutlierGate {
  private tracks = new Map<number, Track>();
  private rejected = 0;
  private predicted = 0;

  constructor(
    private readonly maxSpeed: number,
    private readonly allowPrediction: boolean,
  ) {}

  get stats() {
    return { rejected: this.rejected, predicted: this.predicted };
  }

  /** `landmarks` are body_relative; `tMs` monotonic; `dtMs` null means no continuity (gap). */
  apply(landmarks: FilteredLandmark[], tMs: number, dtMs: number | null): FilteredLandmark[] {
    if (dtMs === null) {
      // No continuity: accept observations as-is and restart tracks.
      this.tracks.clear();
      for (const l of landmarks) if (l.valid) this.tracks.set(l.id, { x: l.x, y: l.y, z: l.z, t: tMs, vx: 0, vy: 0, predicted: false });
      return landmarks;
    }
    const dt = dtMs / 1000;
    return landmarks.map((l) => {
      const tr = this.tracks.get(l.id);
      if (!l.valid) {
        if (tr && !tr.predicted && this.allowPrediction && tMs - tr.t <= dtMs * 1.5 + 1e-6) {
          this.predicted++;
          tr.predicted = true;
          const px = tr.x + tr.vx * dt;
          const py = tr.y + tr.vy * dt;
          return { ...l, x: px, y: py, z: tr.z, valid: true, predicted: true, confidence: Math.min(l.confidence, 0.4), reason: 'PREDICTED_SAMPLE' };
        }
        // A prediction is only a one-frame bridge, never a new observation
        // from which another missing sample may be extrapolated.
        this.tracks.delete(l.id);
        return l;
      }
      if (!tr) {
        this.tracks.set(l.id, { x: l.x, y: l.y, z: l.z, t: tMs, vx: 0, vy: 0, predicted: false });
        return l;
      }
      const elapsed = Math.max((tMs - tr.t) / 1000, 1e-3);
      const speed = Math.hypot(l.x - tr.x, l.y - tr.y) / elapsed;
      // Lower confidence tightens the plausible speed envelope.
      const limit = this.maxSpeed * (0.5 + 0.5 * Math.min(1, l.confidence));
      if (speed > limit) {
        this.rejected++;
        if (this.allowPrediction && !tr.predicted) {
          this.predicted++;
          const px = tr.x + tr.vx * dt;
          const py = tr.y + tr.vy * dt;
          // Retain one predicted point for a plausible immediate observation.
          // If that observation is also rejected, discard this trajectory so
          // its old velocity cannot run away indefinitely from the real limb.
          this.tracks.set(l.id, { x: px, y: py, z: tr.z, t: tMs, vx: tr.vx, vy: tr.vy, predicted: true });
          return { ...l, x: px, y: py, z: tr.z, valid: true, predicted: true, confidence: Math.min(l.confidence, 0.4), reason: 'PREDICTED_SAMPLE' };
        }
        this.tracks.delete(l.id);
        return { ...l, valid: false, reason: 'OUTLIER_REJECTED' };
      }
      this.tracks.set(l.id, { x: l.x, y: l.y, z: l.z, t: tMs, vx: (l.x - tr.x) / elapsed, vy: (l.y - tr.y) / elapsed, predicted: false });
      return l;
    });
  }

  reset(): void {
    this.tracks.clear();
  }
}
