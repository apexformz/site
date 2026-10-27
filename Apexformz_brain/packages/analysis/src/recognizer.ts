import { BrainError, type ModelProvenance } from '@apexformz/contracts';
import type { ResampledSeries } from '@apexformz/signal';

/**
 * Within-domain movement recognizer interface (TRD 10). Produces per-sport
 * class probabilities including UNKNOWN. The heuristic segmenter is the
 * baseline; a learned TCN/ST-GCN challenger plugs in through this interface.
 */
export interface RecognizerOutput {
  probabilities: Record<string, number>;
  unknown_probability: number;
  model: ModelProvenance;
}

export interface MovementRecognizer {
  readonly model: ModelProvenance;
  readonly classes: string[];
  predict(series: ResampledSeries): RecognizerOutput;
}

export interface OpenSetDecision {
  movement_id: string | null;
  probability: number;
  unknown: boolean;
  reason?: 'BELOW_THRESHOLD' | 'UNKNOWN_CLASS' | 'AMBIGUOUS_TOP2';
}

/**
 * Open-set decision with per-movement thresholds (no universal 0.8 cutoff,
 * TRD 10). `margin` guards against near-duplicate movements.
 */
export function decideOpenSet(out: RecognizerOutput, thresholds: Record<string, number>, margin = 0.1): OpenSetDecision {
  const entries = Object.entries(out.probabilities).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { movement_id: null, probability: 0, unknown: true, reason: 'UNKNOWN_CLASS' };
  const [top, p] = entries[0];
  const second = entries[1]?.[1] ?? 0;
  if (out.unknown_probability >= p) return { movement_id: null, probability: p, unknown: true, reason: 'UNKNOWN_CLASS' };
  const thr = thresholds[top];
  if (thr === undefined) throw new BrainError('PACK_VALIDATION_FAILED', `no calibrated threshold for movement ${top}`, { recoverable: false });
  // Export uses 1 as an explicit abstention gate until negatives/calibration are available.
  // A saturated floating-point softmax can equal 1, so comparison alone is insufficient.
  if (thr >= 1 || p < thr) return { movement_id: null, probability: p, unknown: true, reason: 'BELOW_THRESHOLD' };
  if (p - second < margin) return { movement_id: null, probability: p, unknown: true, reason: 'AMBIGUOUS_TOP2' };
  return { movement_id: top, probability: p, unknown: false };
}

/** Pluggable ONNX session factory so the core never bundles a runtime it may not have. */
export interface OnnxSessionLike {
  run(feeds: Record<string, { data: Float32Array; dims: number[] }>): Promise<Record<string, { data: Float32Array | number[]; dims?: readonly number[] }>>;
  release?(): Promise<void>;
}

export class OnnxRecognizer implements MovementRecognizer {
  private session: OnnxSessionLike | null = null;

  constructor(
    public readonly model: ModelProvenance,
    public readonly classes: string[],
    private readonly factory: (() => Promise<OnnxSessionLike>) | null,
    private readonly temperature = 1,
  ) {}

  async load(): Promise<void> {
    if (!this.factory) throw new BrainError('UNKNOWN_MODEL_ID', `no ONNX session factory for ${this.model.model_id}`, { recoverable: false });
    this.session = await this.factory();
  }

  /**
   * Synchronous predict contract: returns MODEL_UNAVAILABLE output when the
   * async session has not been loaded. Live loop never blocks on inference.
   */
  predict(): RecognizerOutput {
    if (!this.session) {
      return { probabilities: {}, unknown_probability: 1, model: this.model };
    }
    throw new BrainError('INTERNAL', 'OnnxRecognizer.predictAsync must be used once a session is loaded', { recoverable: true });
  }

  async predictAsync(series: ResampledSeries): Promise<RecognizerOutput> {
    if (!this.session) return { probabilities: {}, unknown_probability: 1, model: this.model };
    let lastValid = series.mask.length - 1;
    while (lastValid >= 0 && (series.padded[lastValid] || !series.mask[lastValid].some(Boolean))) lastValid--;
    if (lastValid < 0) return { probabilities: {}, unknown_probability: 1, model: this.model };
    const tensor = seriesToTensor(series);
    const out = await this.session.run({ input: tensor.input, mask: tensor.mask });
    if (!out.logits) throw new Error('movement model has no logits output');
    const logits = finalFrameLogits(out.logits, this.classes.length, series.timestamps_ms.length, lastValid);
    if (!(this.temperature > 0) || !Number.isFinite(this.temperature)) throw new Error('invalid calibration temperature');
    const probs = softmax(logits.map((x) => x / this.temperature));
    const probabilities: Record<string, number> = {};
    this.classes.forEach((c, i) => {
      if (c !== 'UNKNOWN') probabilities[c] = probs[i] ?? 0;
    });
    const unknownIdx = this.classes.indexOf('UNKNOWN');
    return { probabilities, unknown_probability: unknownIdx >= 0 ? probs[unknownIdx] : 0, model: this.model };
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.release?.();
  }
}

/** Causal TCN exports [1,T,C], not a single flat class vector. Reject mismatched exports. */
export function finalFrameLogits(output: { data: Float32Array | number[]; dims?: readonly number[] }, classes: number, frames: number, lastValid = frames - 1): number[] {
  const dims = output.dims;
  let start = 0;
  if (dims?.length === 3) {
    if (dims[0] !== 1 || dims[1] !== frames || dims[2] !== classes) throw new Error('movement logits must have shape [1,T,C]');
    start = lastValid * classes;
  } else if (dims?.length === 2) {
    if (dims[0] !== 1 || dims[1] !== classes) throw new Error('movement logits must have shape [1,C]');
  } else if (dims || output.data.length !== classes) {
    throw new Error('movement logits require shape metadata');
  }
  const expected = dims?.length === 3 ? frames * classes : classes;
  if (output.data.length !== expected || lastValid < 0 || lastValid >= frames) throw new Error('movement logits size mismatch');
  const logits = Array.from(output.data.slice(start, start + classes));
  if (!logits.every(Number.isFinite)) throw new Error('movement logits contain non-finite values');
  return logits;
}

/** Input tensor contract shared with ml/training: [T, V*3] values and [T, V] mask; padded frames carry mask 0. */
export function seriesToTensor(series: ResampledSeries): { input: { data: Float32Array; dims: number[] }; mask: { data: Float32Array; dims: number[] } } {
  const T = series.timestamps_ms.length;
  const V = series.mask.find((m) => m.length)?.length ?? 33;
  const input = new Float32Array(T * V * 3);
  const mask = new Float32Array(T * V);
  for (let t = 0; t < T; t++) {
    const vals = series.values[t];
    for (let v = 0; v < V; v++) {
      const p = vals?.[v];
      const base = (t * V + v) * 3;
      if (p && series.mask[t]?.[v] && !series.padded[t] && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.z === null || Number.isFinite(p.z))) {
        input[base] = p.x;
        input[base + 1] = p.y;
        input[base + 2] = p.z ?? 0;
        mask[t * V + v] = 1;
      }
    }
  }
  return { input: { data: input, dims: [1, T, V * 3] }, mask: { data: mask, dims: [1, T, V] } };
}

export function softmax(xs: number[]): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((x) => x / s);
}
