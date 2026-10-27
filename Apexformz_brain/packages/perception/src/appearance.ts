/**
 * Appearance re-identification evidence for the pinned tracker (model-agnostic: any L2-normalisable embedding).
 *
 * Measured with OSNet-AIN x0.25 on the squash captures (tools/eval_appearance_reid.py, docs/12):
 * - the athlete versus other people: AUC 0.954 in colour, 0.865 in greyscale (a proxy for identical kit);
 * - deciding a crossing only when similarities differ by at least 0.10: 98.4 % correct in colour, 97.6 % in greyscale.
 */
export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

/** Running mean of the pinned person's normalized embeddings, taken from clean frames only. */
export class AppearanceGallery {
  private sum: Float32Array | null = null;
  private n = 0;

  add(embedding: Float32Array): void {
    if (!this.valid(embedding)) return;
    const e = normalize(embedding);
    if (!this.sum) this.sum = new Float32Array(e.length);
    for (let i = 0; i < e.length; i++) this.sum[i] += e[i];
    this.n++;
  }

  get size(): number { return this.n; }

  similarity(embedding: Float32Array): number | null {
    if (!this.sum || !this.n || !this.valid(embedding)) return null;
    return cosine(normalize(this.sum), normalize(embedding));
  }

  private valid(embedding: Float32Array): boolean {
    return embedding.length > 0 && (!this.sum || embedding.length === this.sum.length)
      && embedding.every(Number.isFinite) && embedding.some((v) => v !== 0);
  }
}
