/**
 * ByteTrack-style multi-object tracker for person boxes (Zhang et al., ECCV 2022;
 * reference implementation ifzhang/ByteTrack, MIT). Pure TypeScript, dependency free.
 *
 * Kalman state: [cx, cy, a (aspect), h, vcx, vcy, va, vh] with a constant-velocity model.
 * Association: two stages (high-score detections first, then low-score detections against the
 * remaining tracks) by IoU with greedy matching; unmatched tracks are kept for `trackBuffer`
 * frames before removal. Defaults mirror the reference: track_thresh 0.5, match_thresh 0.8,
 * track_buffer 30. No sport knowledge; subjects are generic persons.
 */
export interface Detection {
  /** Normalized image box [x0, y0, x1, y1]. */
  box: [number, number, number, number];
  score: number;
  /** Opaque payload (e.g. the landmarks) carried to the matched track. */
  ref?: unknown;
}

export interface TrackState {
  id: string;
  box: [number, number, number, number];
  score: number;
  age: number;
  hits: number;
  timeSinceUpdate: number;
  state: 'tentative' | 'tracked' | 'lost';
  ref?: unknown;
}

export interface ByteTrackConfig {
  trackThresh: number;
  matchThresh: number;
  lowMatchThresh: number;
  trackBuffer: number;
  minHits: number;
}

export const DEFAULT_BYTETRACK: ByteTrackConfig = { trackThresh: 0.5, matchThresh: 0.8, lowMatchThresh: 0.5, trackBuffer: 30, minHits: 2 };

type Vec8 = [number, number, number, number, number, number, number, number];

function boxToXyah(b: [number, number, number, number]): [number, number, number, number] {
  const w = Math.max(1e-6, b[2] - b[0]);
  const h = Math.max(1e-6, b[3] - b[1]);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, w / h, h];
}

function xyahToBox(x: Vec8): [number, number, number, number] {
  const w = x[2] * x[3];
  return [x[0] - w / 2, x[1] - x[3] / 2, x[0] + w / 2, x[1] + x[3] / 2];
}

export function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua <= 0 ? 0 : inter / ua;
}

/** Minimal constant-velocity Kalman filter (8-state) with diagonal covariance approximation. */
class Kalman {
  x: Vec8;
  p: Vec8;
  private readonly q = 1e-4;
  private readonly r = 1e-3;

  constructor(xyah: [number, number, number, number]) {
    this.x = [...xyah, 0, 0, 0, 0];
    this.p = [1e-2, 1e-2, 1e-2, 1e-2, 1e-1, 1e-1, 1e-1, 1e-1];
  }

  predict(): void {
    for (let i = 0; i < 4; i++) {
      this.x[i] += this.x[i + 4];
      this.p[i] += this.p[i + 4] + this.q;
      this.p[i + 4] += this.q;
    }
  }

  update(z: [number, number, number, number]): void {
    for (let i = 0; i < 4; i++) {
      const k = this.p[i] / (this.p[i] + this.r);
      const innovation = z[i] - this.x[i];
      this.x[i] += k * innovation;
      this.x[i + 4] += 0.5 * k * innovation; // velocity nudged toward the observed change
      this.p[i] *= 1 - k;
    }
  }
}

interface Internal extends TrackState {
  kf: Kalman;
}

/** Greedy IoU assignment (adequate for the small person counts the Brain deals with). */
function greedyMatch(tracks: Internal[], dets: Detection[], thresh: number): { pairs: Array<[number, number]>; unTracks: number[]; unDets: number[] } {
  const candidates: Array<[number, number, number]> = [];
  tracks.forEach((t, ti) => dets.forEach((d, di) => {
    const s = iou(t.box, d.box);
    if (s >= thresh) candidates.push([s, ti, di]);
  }));
  candidates.sort((a, b) => b[0] - a[0]);
  const usedT = new Set<number>();
  const usedD = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const [, ti, di] of candidates) {
    if (usedT.has(ti) || usedD.has(di)) continue;
    usedT.add(ti);
    usedD.add(di);
    pairs.push([ti, di]);
  }
  return {
    pairs,
    unTracks: tracks.map((_, i) => i).filter((i) => !usedT.has(i)),
    unDets: dets.map((_, i) => i).filter((i) => !usedD.has(i)),
  };
}

export class ByteTracker {
  private tracks: Internal[] = [];
  private nextId = 1;
  readonly config: ByteTrackConfig;

  constructor(config: Partial<ByteTrackConfig> = {}) {
    this.config = { ...DEFAULT_BYTETRACK, ...config };
  }

  reset(): void {
    this.tracks = [];
  }

  /** Advance one frame with the current detections; returns confirmed tracks. */
  update(detections: Detection[]): TrackState[] {
    for (const t of this.tracks) {
      t.kf.predict();
      t.box = xyahToBox(t.kf.x);
      t.age++;
      t.timeSinceUpdate++;
    }
    const high = detections.filter((d) => d.score >= this.config.trackThresh);
    const low = detections.filter((d) => d.score < this.config.trackThresh && d.score > 0.1);

    const active = this.tracks.filter((t) => t.state !== 'lost');
    const lost = this.tracks.filter((t) => t.state === 'lost');
    const pool = [...active, ...lost];

    const m1 = greedyMatch(pool, high, 1 - this.config.matchThresh);
    for (const [ti, di] of m1.pairs) this.hit(pool[ti], high[di]);

    const remaining = m1.unTracks.map((i) => pool[i]).filter((t) => t.state === 'tracked');
    const m2 = greedyMatch(remaining, low, 1 - this.config.lowMatchThresh);
    for (const [ti, di] of m2.pairs) this.hit(remaining[ti], low[di]);
    const matchedSecond = new Set(m2.pairs.map(([ti]) => remaining[ti]));

    for (const t of m1.unTracks.map((i) => pool[i])) {
      if (matchedSecond.has(t)) continue;
      // Reference behaviour: an unmatched track leaves the active set immediately and
      // lives on as "lost" for trackBuffer frames so it can be re-associated.
      t.state = 'lost';
    }
    for (const di of m1.unDets) {
      const d = high[di];
      const kf = new Kalman(boxToXyah(d.box));
      this.tracks.push({ id: `track-${this.nextId++}`, box: d.box, score: d.score, age: 1, hits: 1, timeSinceUpdate: 0, state: 'tentative', ref: d.ref, kf });
    }
    this.tracks = this.tracks.filter((t) => !(t.state === 'lost' && t.timeSinceUpdate > this.config.trackBuffer));
    return this.tracks.filter((t) => t.state === 'tracked').map(({ kf: _kf, ...rest }) => ({ ...rest }));
  }

  private hit(t: Internal, d: Detection): void {
    t.kf.update(boxToXyah(d.box));
    t.box = d.box;
    t.score = d.score;
    t.hits++;
    t.timeSinceUpdate = 0;
    t.ref = d.ref;
    if (t.state === 'tentative' && t.hits >= this.config.minHits) t.state = 'tracked';
    else if (t.state === 'lost') t.state = 'tracked';
    else if (t.state === 'tentative' && this.config.minHits <= 1) t.state = 'tracked';
  }

  all(): TrackState[] {
    return this.tracks.map(({ kf: _kf, ...rest }) => ({ ...rest }));
  }
}
