import type { OnnxSessionLike } from '@apexformz/analysis';
import type { MovementModelLoadOptions } from './movement_model_loader';

/**
 * Movement-model inference in its own worker.
 *
 * The brain worker runs pose tracking for every frame. A movement model can take 15-20 ms per call
 * (ensemble) and phones are 3-5x slower, so running it on the same thread makes the skeleton stutter.
 * This host owns the ONNX session on a separate thread. The brain worker only forwards small input
 * tensors (transferred, not copied) and receives the logits back.
 */
export type Feed = { data: Float32Array; dims: number[] };

export type InferenceRequest =
  | { type: 'load'; id: number; bytes: ArrayBuffer; execution_providers?: MovementModelLoadOptions['execution_providers']; ort_wasm_base_url?: string; expect?: ModelKind }
  | { type: 'run'; id: number; feeds: Record<string, Feed> }
  | { type: 'release'; id: number };

export type InferenceReply =
  | { type: 'ok'; id: number }
  | { type: 'result'; id: number; outputs: Record<string, Feed> }
  | { type: 'error'; id: number; message: string };

export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** 'movement': input+mask -> logits (validated); 'any': a single-input model such as a re-id embedder. */
export type ModelKind = 'movement' | 'any';

export type SessionOpener = (bytes: Uint8Array, options: Pick<MovementModelLoadOptions, 'execution_providers' | 'ort_wasm_base_url'> & { expect?: ModelKind }) => Promise<OnnxSessionLike>;

/** Serve load/run/release requests on `port`. Requests are processed strictly one at a time. */
export function hostInference(port: PortLike, open: SessionOpener): void {
  let session: OnnxSessionLike | null = null;
  let queue: Promise<void> = Promise.resolve();
  const handle = async (msg: InferenceRequest): Promise<void> => {
    try {
      if (msg.type === 'load') {
        await session?.release?.();
        session = await open(new Uint8Array(msg.bytes), { execution_providers: msg.execution_providers, ort_wasm_base_url: msg.ort_wasm_base_url, expect: msg.expect });
        port.postMessage({ type: 'ok', id: msg.id } satisfies InferenceReply);
      } else if (msg.type === 'run') {
        if (!session) throw new Error('inference session is not loaded');
        const raw = await session.run(msg.feeds);
        const outputs: Record<string, Feed> = {};
        const transfer: Transferable[] = [];
        for (const [name, value] of Object.entries(raw)) {
          // copy out of the runtime memory before handing the buffer to the other thread
          const data = value.data instanceof Float32Array ? value.data.slice() : Float32Array.from(value.data);
          outputs[name] = { data, dims: [...(value.dims ?? [data.length])] };
          transfer.push(data.buffer);
        }
        port.postMessage({ type: 'result', id: msg.id, outputs } satisfies InferenceReply, transfer);
      } else {
        await session?.release?.();
        session = null;
        port.postMessage({ type: 'ok', id: msg.id } satisfies InferenceReply);
      }
    } catch (error) {
      port.postMessage({ type: 'error', id: msg.id, message: (error as Error)?.message ?? String(error) } satisfies InferenceReply);
    }
  };
  port.onmessage = (event) => { queue = queue.then(() => handle(event.data as InferenceRequest)); };
}
