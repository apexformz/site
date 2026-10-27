import { OnnxRecognizer, validateMovementModelConfig, type MovementModelConfig, type OnnxSessionLike } from '@apexformz/analysis';
import { CausalMovementDetector } from './movement_detector';

export interface MovementModelLoadOptions {
  config: MovementModelConfig;
  model_url: string;
  /** Evaluation/development only; provisional recognition remains labelled as provisional. */
  allow_provisional?: boolean;
  execution_providers?: Array<'webgpu' | 'wasm'>;
  ort_wasm_base_url?: string;
}

export interface LoadedMovementModel {
  detector: CausalMovementDetector;
  close(): Promise<void>;
}

interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
  release(): Promise<void>;
}

interface OrtModule {
  InferenceSession: { create(bytes: Uint8Array, options: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown;
  env: { wasm: { wasmPaths?: string } };
}

/** Open an onnxruntime-web session for any single-input model (re-identification embedders). */
export async function openAnyOrtSession(bytes: Uint8Array, options: Pick<MovementModelLoadOptions, 'execution_providers' | 'ort_wasm_base_url'>): Promise<OnnxSessionLike> {
  const ort = await import('onnxruntime-web') as unknown as OrtModule;
  if (options.ort_wasm_base_url) ort.env.wasm.wasmPaths = options.ort_wasm_base_url;
  let session: OrtSession | null = null;
  let lastError: unknown;
  for (const provider of options.execution_providers ?? ['wasm']) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [provider], graphOptimizationLevel: 'all' });
      break;
    } catch (error) { lastError = error; }
  }
  if (!session) throw lastError ?? new Error('no inference provider available');
  const active = session;
  return {
    run: (feeds) => active.run(Object.fromEntries(Object.entries(feeds).map(([name, tensor]) => [name, new ort.Tensor('float32', tensor.data, tensor.dims)]))),
    release: () => active.release(),
  };
}

/** Open an onnxruntime-web session for a movement model (also used inside the dedicated inference worker). */
export async function openOrtSession(bytes: Uint8Array, options: Pick<MovementModelLoadOptions, 'execution_providers' | 'ort_wasm_base_url'>): Promise<OnnxSessionLike> {
  const ort = await import('onnxruntime-web') as unknown as OrtModule;
  if (options.ort_wasm_base_url) ort.env.wasm.wasmPaths = options.ort_wasm_base_url;
  let session: OrtSession | null = null;
  let lastError: unknown;
  for (const provider of options.execution_providers ?? ['wasm']) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: [provider], graphOptimizationLevel: 'all' });
      break;
    } catch (error) { lastError = error; }
  }
  if (!session) throw lastError ?? new Error('no movement inference provider available');
  if (session.inputNames.length !== 2 || !session.inputNames.includes('input') || !session.inputNames.includes('mask') || !session.outputNames.includes('logits')) {
    await session.release();
    throw new Error('movement model must expose input, mask and logits tensors');
  }
  const active = session;
  return {
    run: (feeds) => active.run(Object.fromEntries(Object.entries(feeds).map(([name, tensor]) => [name, new ort.Tensor('float32', tensor.data, tensor.dims)]))),
    release: () => active.release(),
  };
}

/** Verify ONNX bytes against trusted deployment metadata before constructing an inference session. */
export async function loadBrowserMovementModel(options: MovementModelLoadOptions, dependencies: {
  fetch?: typeof fetch;
  createSession?: (bytes: Uint8Array, options: MovementModelLoadOptions) => Promise<OnnxSessionLike>;
} = {}): Promise<LoadedMovementModel> {
  const config = validateMovementModelConfig(options.config);
  const response = await (dependencies.fetch ?? fetch)(options.model_url);
  if (!response.ok) throw new Error(`movement model fetch failed: ${response.status}`);
  const limit = 64 * 1024 * 1024;
  const length = Number(response.headers.get('content-length'));
  if (length > limit) throw new Error('movement model exceeds 64 MiB budget');
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > limit) throw new Error('movement model is empty or exceeds 64 MiB budget');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const digest = `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (digest !== config.model.digest.toLowerCase()) throw new Error('movement model SHA-256 digest mismatch');
  const recognizer = new OnnxRecognizer(config.model, config.classes, () => (dependencies.createSession ?? openOrtSession)(new Uint8Array(bytes), options), config.calibration.temperature);
  await recognizer.load();
  const detector = new CausalMovementDetector(config, recognizer, { allow_provisional: options.allow_provisional });
  return { detector, close: async () => { detector.endSession(); await recognizer.close(); } };
}
