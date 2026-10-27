/**
 * Numeric primitives (TRD 04). Pure, deterministic, allocation-light.
 */
export interface P3 {
  x: number;
  y: number;
  z: number | null;
}

export const EPS = 1e-9;
export const RAD2DEG = 180 / Math.PI;

export function sub(a: P3, b: P3, use3d: boolean): [number, number, number] {
  return [a.x - b.x, a.y - b.y, use3d && a.z !== null && b.z !== null ? a.z - b.z : 0];
}

export function norm(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/**
 * Angle at vertex B formed by A-B-C.
 * theta = atan2(||u x v||, u . v) which is numerically stable near 0 and 180 degrees.
 * Returns null for degenerate (near-zero) segments.
 */
export function angleAt(a: P3, b: P3, c: P3, use3d: boolean): number | null {
  const u = sub(a, b, use3d);
  const v = sub(c, b, use3d);
  const nu = norm(u);
  const nv = norm(v);
  if (nu < 1e-6 || nv < 1e-6) return null;
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]] as [number, number, number];
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  return Math.atan2(norm(cross), dot) * RAD2DEG;
}

/**
 * Signed inclination (deg) of the line from -> to relative to a reference axis in the image plane.
 * reference 'vertical': 0 when `to` is straight above `from` (-y), positive when leaning to +x.
 * reference 'horizontal': 0 when `to` is to the +x of `from`, positive when tilting to +y (down).
 */
export function lineInclination(from: P3, to: P3, reference: 'vertical' | 'horizontal'): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  if (reference === 'vertical') return Math.atan2(dx, -dy) * RAD2DEG;
  return Math.atan2(dy, dx) * RAD2DEG;
}

/** Orientation angle (deg) of segment from -> to projected onto a plane. */
export function segmentOrientation(from: P3, to: P3, plane: 'xy' | 'xz' | 'yz'): number | null {
  let a: number;
  let b: number;
  if (plane === 'xy') {
    a = to.x - from.x;
    b = to.y - from.y;
  } else if (plane === 'xz') {
    if (from.z === null || to.z === null) return null;
    a = to.x - from.x;
    b = to.z - from.z;
  } else {
    if (from.z === null || to.z === null) return null;
    a = to.y - from.y;
    b = to.z - from.z;
  }
  if (Math.hypot(a, b) < 1e-6) return null;
  return Math.atan2(b, a) * RAD2DEG;
}

export function distance(a: P3, b: P3, use3d: boolean): number {
  return norm(sub(a, b, use3d));
}

/** Timestamp-aware finite difference of the last two samples; null if unavailable. */
export function finiteDifference(values: number[], timesMs: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const dt = (timesMs[n - 1] - timesMs[n - 2]) / 1000;
  if (!(dt > 0)) return null;
  return (values[n - 1] - values[n - 2]) / dt;
}

/** Least-squares slope (per second) of values over times; requires >= 3 samples. */
export function fittedSlope(values: number[], timesMs: number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const t = timesMs.map((x) => (x - timesMs[0]) / 1000);
  const mt = t.reduce((a, b) => a + b, 0) / n;
  const mv = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (t[i] - mt) * (values[i] - mv);
    den += (t[i] - mt) ** 2;
  }
  if (den < EPS) return null;
  return num / den;
}

export function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function std(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Derivative series by central/forward differences with explicit timestamps. */
export function derivativeSeries(values: number[], timesMs: number[]): { values: number[]; timesMs: number[] } {
  const out: number[] = [];
  const t: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const dt = (timesMs[i] - timesMs[i - 1]) / 1000;
    if (dt > 0) {
      out.push((values[i] - values[i - 1]) / dt);
      t.push((timesMs[i] + timesMs[i - 1]) / 2);
    }
  }
  return { values: out, timesMs: t };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
