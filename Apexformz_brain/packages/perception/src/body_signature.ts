/**
 * Body-proportion signature: 3D bone-length ratios from MediaPipe world landmarks.
 *
 * The ratios do not change when a person turns around and they ignore clothing. Measured on the squash
 * capture data (docs/11), they reliably separate clearly different builds but not two similar adults,
 * because monocular depth makes bone lengths vary with pose. The pinned tracker therefore uses them only
 * as a veto, never as positive proof of identity.
 *
 * Mirrors packages/perception-py/apexformz_perception/subject/body_signature.py exactly; both are tested
 * against __fixtures__/body_signature.json.
 */
export interface Point3 { x: number; y: number; z: number }

export const SIGNATURE_SEGMENTS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, number]>]> = [
  ['shoulder_width', [[11, 12]]],
  ['hip_width', [[23, 24]]],
  ['upper_arm', [[11, 13], [12, 14]]],
  ['forearm', [[13, 15], [14, 16]]],
  ['thigh', [[23, 25], [24, 26]]],
  ['shin', [[25, 27], [26, 28]]],
];
const TORSO: ReadonlyArray<readonly [number, number]> = [[11, 23], [12, 24]];
export const SIGNATURE_MIN_VISIBILITY = 0.5;
const MIN_SHARED = 3;

/** 6 ratios (NaN where an endpoint is not visible), or null without a visible torso. */
export function bodySignature(world: ReadonlyArray<Point3 | undefined>, visibility: ReadonlyArray<number>, minVisibility = SIGNATURE_MIN_VISIBILITY): number[] | null {
  const length = (pairs: ReadonlyArray<readonly [number, number]>): number => {
    const ls: number[] = [];
    for (const [a, b] of pairs) {
      const pa = world[a];
      const pb = world[b];
      if (!pa || !pb || (visibility[a] ?? 0) < minVisibility || (visibility[b] ?? 0) < minVisibility) continue;
      ls.push(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z));
    }
    return ls.length ? ls.reduce((s, v) => s + v, 0) / ls.length : NaN;
  };
  const torso = length(TORSO);
  if (!Number.isFinite(torso) || torso <= 1e-6) return null;
  return SIGNATURE_SEGMENTS.map(([, pairs]) => length(pairs) / torso);
}

/** Mean absolute log-ratio over the ratios both signatures have (0 = identical proportions). */
export function signatureDistance(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number | null {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < Math.min(a.length, b.length); k++) {
    const x = a[k];
    const y = b[k];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) continue;
    sum += Math.abs(Math.log(x / y));
    n++;
  }
  return n >= MIN_SHARED ? sum / n : null;
}

/** Per-ratio median over the most recent clean samples of one person. */
export class RunningSignature {
  private samples: number[][] = [];
  constructor(private readonly capacity = 90) {}

  add(sig: number[] | null): void {
    if (!sig) return;
    this.samples.push(sig);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  get count(): number { return this.samples.length; }
  get ready(): boolean { return this.samples.length >= 10; }

  value(): number[] | null {
    if (!this.samples.length) return null;
    const dims = this.samples[0].length;
    const out: number[] = [];
    for (let k = 0; k < dims; k++) {
      const col = this.samples.map((s) => s[k]).filter((v) => Number.isFinite(v)).sort((p, q) => p - q);
      if (!col.length) { out.push(NaN); continue; }
      const m = col.length >> 1;
      out.push(col.length % 2 ? col[m] : (col[m - 1] + col[m]) / 2);
    }
    return out;
  }
}
