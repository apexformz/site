import type { Orientation, PoseFrame } from '@apexformz/contracts';
import { ByteSubjectTracker, PinnedSubjectTracker, fromKeypointSet, type AppearanceRequest, type PinStatus, type GenericKeypoint, type KeypointSetId } from '@apexformz/perception';

/**
 * Browser ONNX pose backend (onnxruntime-web, MIT) for industry models exported by
 * OpenMMLab/rtmlib (Apache-2.0): RTMO (one-stage, dets + keypoints) and RTMPose /
 * RTMW / DWPose (SimCC heads). WebGPU execution provider with WASM fallback.
 *
 * Pre/post-processing is implemented here as pure functions (letterbox, SimCC
 * decoding, RTMO decoding) so they are unit-tested in Node; only `init`/`detect`
 * touch the browser.
 */
export interface OnnxPoseOptions {
  model_url: string;
  model_kind: 'rtmo' | 'simcc';
  /** Network input [width, height]; RTMO 640x640, RTMPose-m 192x256, RTMW 288x384. */
  input_size: [number, number];
  keypoint_set: KeypointSetId;
  execution_providers?: Array<'webgpu' | 'wasm' | 'webgl'>;
  /** Base URL for onnxruntime-web wasm artifacts (defaults to the package's CDN layout). */
  ort_wasm_base_url?: string;
  /** Channel order and normalisation; defaults match rtmlib (BGR input, ImageNet mean/std in BGR order). */
  color_order?: 'bgr' | 'rgb';
  mean?: [number, number, number];
  std?: [number, number, number];
  score_threshold?: number;
  simcc_split_ratio?: number;
  /** Input tensor name; auto-detected from the session when omitted. */
  input_name?: string;
  model_version_label?: string;
  /** Max persons returned (RTMO). */
  max_persons?: number;
  /** Explicit normalized capture-space region used by subject selection. */
  subject_roi?: { x0: number; y0: number; x1: number; y1: number };
}

export interface Letterbox {
  scale: number;
  pad_x: number;
  pad_y: number;
  src_w: number;
  src_h: number;
  dst_w: number;
  dst_h: number;
}

/** Scale-preserving resize with padding (pad value 114 as in mmdet/rtmlib). */
export function computeLetterbox(srcW: number, srcH: number, dstW: number, dstH: number): Letterbox {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const newW = srcW * scale;
  const newH = srcH * scale;
  return { scale, pad_x: (dstW - newW) / 2, pad_y: (dstH - newH) / 2, src_w: srcW, src_h: srcH, dst_w: dstW, dst_h: dstH };
}

/** Map a point in network input pixels back to normalized source image coordinates. */
export function unletterbox(x: number, y: number, lb: Letterbox): [number, number] {
  return [(x - lb.pad_x) / lb.scale / lb.src_w, (y - lb.pad_y) / lb.scale / lb.src_h];
}

/** RGBA pixels (letterboxed to dst size) -> normalized NCHW float32 tensor. */
export function pixelsToTensor(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, opts: { color_order: 'bgr' | 'rgb'; mean: [number, number, number]; std: [number, number, number] }): Float32Array {
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  const order = opts.color_order === 'bgr' ? [2, 1, 0] : [0, 1, 2];
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    for (let c = 0; c < 3; c++) {
      const v = rgba[p + order[c]];
      out[c * plane + i] = (v - opts.mean[c]) / opts.std[c];
    }
  }
  return out;
}

export interface RtmoOutput {
  /** [N,5] flattened: x0,y0,x1,y1,score in input pixels */
  dets: Float32Array | number[];
  /** [N,K,3] flattened: x,y,score */
  keypoints: Float32Array | number[];
  num: number;
  num_keypoints: number;
}

/** Decode RTMO outputs into per-person normalized keypoints ordered by score. */
export function decodeRtmo(out: RtmoOutput, lb: Letterbox, scoreThreshold = 0.3, maxPersons = 5): Array<{ keypoints: GenericKeypoint[]; score: number; box: [number, number, number, number] }> {
  const persons: Array<{ keypoints: GenericKeypoint[]; score: number; box: [number, number, number, number] }> = [];
  for (let n = 0; n < out.num; n++) {
    const score = out.dets[n * 5 + 4];
    if (!(score >= scoreThreshold)) continue;
    const [x0, y0] = unletterbox(out.dets[n * 5], out.dets[n * 5 + 1], lb);
    const [x1, y1] = unletterbox(out.dets[n * 5 + 2], out.dets[n * 5 + 3], lb);
    const kps: GenericKeypoint[] = [];
    for (let k = 0; k < out.num_keypoints; k++) {
      const base = (n * out.num_keypoints + k) * 3;
      const [x, y] = unletterbox(out.keypoints[base], out.keypoints[base + 1], lb);
      kps.push({ x, y, score: out.keypoints[base + 2] });
    }
    persons.push({ keypoints: kps, score, box: [x0, y0, x1, y1] });
  }
  persons.sort((a, b) => b.score - a.score);
  return persons.slice(0, maxPersons);
}

/**
 * Decode SimCC heads ([K, Wx] and [K, Wy] flattened) into keypoints in input pixels,
 * then back to normalized source coordinates through the letterbox.
 */
export function decodeSimcc(simccX: Float32Array | number[], simccY: Float32Array | number[], K: number, splitRatio: number, lb: Letterbox): GenericKeypoint[] {
  const Wx = simccX.length / K;
  const Wy = simccY.length / K;
  const kps: GenericKeypoint[] = [];
  for (let k = 0; k < K; k++) {
    let bx = 0;
    let mx = -Infinity;
    for (let i = 0; i < Wx; i++) {
      const v = simccX[k * Wx + i];
      if (v > mx) {
        mx = v;
        bx = i;
      }
    }
    let by = 0;
    let my = -Infinity;
    for (let i = 0; i < Wy; i++) {
      const v = simccY[k * Wy + i];
      if (v > my) {
        my = v;
        by = i;
      }
    }
    const [x, y] = unletterbox(bx / splitRatio, by / splitRatio, lb);
    kps.push({ x, y, score: Math.max(0, Math.min(1, Math.min(mx, my))) });
  }
  return kps;
}

interface OrtSessionLike {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | Int32Array | BigInt64Array; dims: number[] }>>;
  release?(): Promise<void>;
}

interface OrtModule {
  InferenceSession: { create(url: string, opts: Record<string, unknown>): Promise<OrtSessionLike> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  env: { wasm: { wasmPaths?: string; numThreads?: number } };
}

export class OnnxPoseBackend {
  private session: OrtSessionLike | null = null;
  private ort: OrtModule | null = null;
  private canvas: OffscreenCanvas | null = null;
  private tracker: PinnedSubjectTracker;
  private lastTs = -1;
  private trackingGeneration = 0;
  readonly options: Required<Pick<OnnxPoseOptions, 'color_order' | 'mean' | 'std' | 'score_threshold' | 'simcc_split_ratio' | 'execution_providers' | 'max_persons'>> & OnnxPoseOptions;
  provider: string | null = null;

  constructor(options: OnnxPoseOptions) {
    this.tracker = new PinnedSubjectTracker(new ByteSubjectTracker({ subject_roi: options.subject_roi }));
    this.options = {
      color_order: 'bgr',
      mean: [103.53, 116.28, 123.675],
      std: [57.375, 57.12, 58.395],
      score_threshold: 0.3,
      simcc_split_ratio: 2.0,
      execution_providers: ['webgpu', 'wasm'],
      max_persons: 5,
      ...options,
    };
  }

  get ready(): boolean {
    return this.session !== null;
  }

  async init(): Promise<void> {
    const generation = this.trackingGeneration;
    const ort = (await import('onnxruntime-web')) as unknown as OrtModule;
    if (generation !== this.trackingGeneration) return;
    if (this.options.ort_wasm_base_url) ort.env.wasm.wasmPaths = this.options.ort_wasm_base_url;
    this.ort = ort;
    let lastError: unknown = null;
    for (const ep of this.options.execution_providers) {
      try {
        const session = await ort.InferenceSession.create(this.options.model_url, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        if (generation !== this.trackingGeneration) {
          await session.release?.();
          return;
        }
        this.session = session;
        this.provider = ep;
        break;
      } catch (e) {
        if (generation !== this.trackingGeneration) return;
        lastError = e;
      }
    }
    if (!this.session) throw new Error(`onnx pose backend failed to initialise: ${(lastError as Error)?.message ?? 'no execution provider'}`);
    const [w, h] = this.options.input_size;
    this.canvas = new OffscreenCanvas(w, h);
  }

  resetTracking(): void {
    this.trackingGeneration++;
    this.tracker.reset();
  }

  /** Tap-to-pin: follow the person under a normalized raw-camera point; null unpins. */
  pin(point: { x: number; y: number } | null): PinStatus {
    const status = this.tracker.pin(point);
    this.trackingGeneration++;
    return status;
  }

  get pinStatus(): PinStatus {
    return this.tracker.status;
  }

  /** Person crops the pinned tracker wants embedded for the frame just detected (appearance re-identification). */
  appearanceRequest(): AppearanceRequest | null {
    return this.tracker.appearanceRequest();
  }

  provideAppearance(request: AppearanceRequest, embeddings: Float32Array[]): void {
    this.tracker.provideAppearance(request, embeddings);
  }

  async detect(image: ImageBitmap | HTMLVideoElement | HTMLCanvasElement, meta: { session_id: string; frame_id: number; timestamp_ms: number; camera_id: string; image_size: [number, number]; mirror: boolean; orientation: Orientation }): Promise<PoseFrame | null> {
    if (!this.session || !this.ort || !this.canvas) return null;
    const generation = this.trackingGeneration;
    const session = this.session;
    if (meta.timestamp_ms <= this.lastTs) meta = { ...meta, timestamp_ms: this.lastTs + 1 };
    this.lastTs = meta.timestamp_ms;
    const [dw, dh] = this.options.input_size;
    const [sw, sh] = meta.image_size;
    const lb = computeLetterbox(sw, sh, dw, dh);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, dw, dh);
    ctx.drawImage(image as CanvasImageSource, lb.pad_x, lb.pad_y, sw * lb.scale, sh * lb.scale);
    const rgba = ctx.getImageData(0, 0, dw, dh).data;
    const tensor = pixelsToTensor(rgba, dw, dh, this.options);
    const inputName = this.options.input_name ?? session.inputNames[0];
    const feeds = { [inputName]: new this.ort.Tensor('float32', tensor, [1, 3, dh, dw]) };
    const out = await session.run(feeds);
    // A worker-level result guard runs too late: the adapter below mutates the
    // subject tracker and can consume a newly requested pin. Reject first.
    if (generation !== this.trackingGeneration || session !== this.session) return null;
    const K = this.options.keypoint_set === 'coco_17' ? 17 : this.options.keypoint_set === 'coco_wholebody_133' ? 133 : this.options.keypoint_set === 'halpe_26' ? 26 : 33;
    let persons: GenericKeypoint[][];
    if (this.options.model_kind === 'rtmo') {
      const names = session.outputNames;
      const dets = out[names.find((n) => /det/i.test(n)) ?? names[0]];
      const kpts = out[names.find((n) => /key|kpt/i.test(n)) ?? names[1]];
      const num = dets.dims[dets.dims.length - 2] ?? 0;
      persons = decodeRtmo({ dets: dets.data as Float32Array, keypoints: kpts.data as Float32Array, num, num_keypoints: kpts.dims[kpts.dims.length - 2] ?? K }, lb, this.options.score_threshold, this.options.max_persons).map((p) => p.keypoints);
    } else {
      const names = session.outputNames;
      const sx = out[names.find((n) => /x/i.test(n)) ?? names[0]].data as Float32Array;
      const sy = out[names.find((n) => /y/i.test(n)) ?? names[1]].data as Float32Array;
      persons = [decodeSimcc(sx, sy, K, this.options.simcc_split_ratio, lb)];
    }
    return fromKeypointSet(this.options.keypoint_set, persons, {
      ...meta,
      provenance: { model_id: `onnx:${this.options.model_kind}`, version: this.options.model_version_label ?? this.options.model_url.split('/').pop() ?? 'unknown', delegate: this.provider ?? 'unknown' },
    }, { tracker: this.tracker, min_visibility: this.options.score_threshold });
  }

  async close(): Promise<void> {
    this.trackingGeneration++;
    const session = this.session;
    this.session = null;
    await session?.release?.();
  }
}
