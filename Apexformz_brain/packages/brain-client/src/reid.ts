import type { OnnxSessionLike } from '@apexformz/analysis';

/**
 * Appearance re-identification for the pinned tracker: cut person crops from the camera frame, normalize them
 * and embed them off-thread (dedicated inference worker when available).
 *
 * The default model is OSNet-AIN x0.25 (public/models/reid/reid.json). Its weights were trained on research
 * re-ID datasets and are development-only until replaced or licensed; see docs/12.
 */
export interface ReidConfig {
  schema_version: '1.0.0';
  model_id: string;
  digest: string;
  model_url: string;
  input: { height: number; width: number; layout: 'NCHW'; color: 'RGB'; mean: number[]; std: number[]; crop_padding: [number, number] };
  embedding_dim: number;
}

export function validateReidConfig(value: unknown): ReidConfig {
  const c = value as ReidConfig;
  const fail = (why: string): never => { throw new Error(`invalid re-id config: ${why}`); };
  if (!c || c.schema_version !== '1.0.0' || typeof c.model_id !== 'string' || typeof c.model_url !== 'string') fail('identity');
  if (!/^sha256:[a-f0-9]{64}$/i.test(c.digest)) fail('sha256 digest');
  const i = c.input;
  if (!i || !Number.isInteger(i.height) || !Number.isInteger(i.width) || i.height < 32 || i.width < 16 || i.height > 512 || i.width > 512) fail('input size');
  if (i.layout !== 'NCHW' || i.color !== 'RGB' || i.mean?.length !== 3 || i.std?.length !== 3 || i.std.some((s) => !(s > 0))) fail('normalization');
  if (!Array.isArray(i.crop_padding) || i.crop_padding.length !== 2) fail('crop padding');
  if (!Number.isInteger(c.embedding_dim) || c.embedding_dim < 8) fail('embedding size');
  return c;
}

/** Pixel rectangle of a normalized box with padding, clamped to the frame (null when too small to embed). */
export function cropRect(box: { x0: number; y0: number; x1: number; y1: number }, frameW: number, frameH: number, pad: [number, number]): { sx: number; sy: number; sw: number; sh: number } | null {
  const px = pad[0] * (box.x1 - box.x0);
  const py = pad[1] * (box.y1 - box.y0);
  const x0 = Math.max(0, Math.floor((box.x0 - px) * frameW));
  const y0 = Math.max(0, Math.floor((box.y0 - py) * frameH));
  const x1 = Math.min(frameW, Math.ceil((box.x1 + px) * frameW));
  const y1 = Math.min(frameH, Math.ceil((box.y1 + py) * frameH));
  return x1 - x0 >= 8 && y1 - y0 >= 16 ? { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 } : null;
}

/** RGBA pixels (already resized to width x height) to normalized planar RGB, written into `out` at `offset`. */
export function rgbaToTensor(rgba: Uint8ClampedArray, width: number, height: number, mean: number[], std: number[], out: Float32Array, offset = 0): void {
  const plane = width * height;
  for (let p = 0; p < plane; p++) {
    for (let ch = 0; ch < 3; ch++) out[offset + ch * plane + p] = (rgba[p * 4 + ch] / 255 - mean[ch]) / std[ch];
  }
}

interface Canvas2DLike {
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

export class ReidEmbedder {
  private ctx: Canvas2DLike | null = null;
  private running = false;

  constructor(private readonly session: OnnxSessionLike, readonly config: ReidConfig) {}

  get busy(): boolean { return this.running; }

  /**
   * Cut, resize and normalize the crops synchronously, before the frame is released.
   * Returns the NCHW batch, or null without OffscreenCanvas or when every box is too small.
   */
  crop(source: { width: number; height: number }, boxes: { x0: number; y0: number; x1: number; y1: number }[]): { batch: Float32Array; kept: number[] } | null {
    const { width: W, height: H, mean, std, crop_padding } = this.config.input;
    if (!this.ctx) {
      if (typeof OffscreenCanvas === 'undefined') return null;
      this.ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true }) as unknown as Canvas2DLike | null;
      if (!this.ctx) return null;
    }
    const kept: number[] = [];
    const rects = boxes.map((b) => cropRect(b, source.width, source.height, crop_padding));
    const batch = new Float32Array(rects.filter(Boolean).length * 3 * W * H);
    rects.forEach((r, k) => {
      if (!r) return;
      this.ctx!.drawImage(source, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
      rgbaToTensor(this.ctx!.getImageData(0, 0, W, H).data, W, H, mean, std, batch, kept.length * 3 * W * H);
      kept.push(k);
    });
    return kept.length ? { batch, kept } : null;
  }

  /** Embed a cropped batch; one request at a time, so the caller drops work while busy. */
  async embed(batch: Float32Array, count: number): Promise<Float32Array[]> {
    if (this.running) throw new Error('re-id embedder is busy');
    this.running = true;
    try {
      const { width: W, height: H } = this.config.input;
      const out = await this.session.run({ input: { data: batch, dims: [count, 3, H, W] } });
      const emb = Object.values(out)[0];
      const data = emb.data instanceof Float32Array ? emb.data : Float32Array.from(emb.data);
      const dim = data.length / count;
      return Array.from({ length: count }, (_, k) => data.slice(k * dim, (k + 1) * dim));
    } finally {
      this.running = false;
    }
  }

  close(): Promise<void> {
    return this.session.release?.() ?? Promise.resolve();
  }
}

/** Fetch the config and model, verify the model's SHA-256, then open the session (off-thread when given a remote factory). */
export async function loadReidEmbedder(configUrl: string, createSession: (bytes: Uint8Array) => Promise<OnnxSessionLike>, fetchImpl: typeof fetch = fetch): Promise<ReidEmbedder> {
  const cfgRes = await fetchImpl(configUrl);
  if (!cfgRes.ok) throw new Error(`re-id config fetch failed: ${cfgRes.status}`);
  const config = validateReidConfig(await cfgRes.json());
  const modelUrl = new URL(config.model_url, new URL(configUrl, typeof location !== 'undefined' ? location.href : 'http://localhost/')).toString();
  const res = await fetchImpl(modelUrl);
  if (!res.ok) throw new Error(`re-id model fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024) throw new Error('re-id model is empty or exceeds 32 MiB');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const digest = `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (digest !== config.digest.toLowerCase()) throw new Error('re-id model SHA-256 digest mismatch');
  return new ReidEmbedder(await createSession(bytes), config);
}
