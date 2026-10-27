import type { OnnxSessionLike } from '@apexformz/analysis';
import type { Feed, InferenceReply, InferenceRequest, ModelKind } from './inference_host';
import type { MovementModelLoadOptions } from './movement_model_loader';

/** Structural subset of a browser Worker (handler params are `any` so a real Worker is assignable). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((event: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((event: any) => void) | null;
  terminate(): void;
}

/** Raised when the dedicated worker cannot start or load the model; the caller may fall back to inline inference. */
export class InferenceWorkerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InferenceWorkerUnavailable';
  }
}

type Pending = { resolve: (reply: InferenceReply) => void; reject: (error: Error) => void };

/** Session factory whose runs execute in a dedicated worker (same OnnxSessionLike contract as inline sessions). */
export function remoteSessionFactory(spawn: () => WorkerLike, expect: ModelKind = 'movement') {
  return async (bytes: Uint8Array, options: Pick<MovementModelLoadOptions, 'execution_providers' | 'ort_wasm_base_url'>): Promise<OnnxSessionLike> => {
    let worker: WorkerLike;
    try {
      worker = spawn();
    } catch (error) {
      throw new InferenceWorkerUnavailable(`could not start inference worker: ${(error as Error).message}`);
    }
    let seq = 0;
    let dead: Error | null = null;
    const pending = new Map<number, Pending>();
    worker.onmessage = (event) => {
      const reply = event.data as InferenceReply;
      const p = pending.get(reply.id);
      if (!p) return;
      pending.delete(reply.id);
      if (reply.type === 'error') p.reject(new Error(reply.message));
      else p.resolve(reply);
    };
    worker.onerror = () => {
      dead = new Error('inference worker failed');
      for (const p of pending.values()) p.reject(dead);
      pending.clear();
    };
    const call = (msg: InferenceRequest, transfer: Transferable[] = []): Promise<InferenceReply> => {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        pending.set(msg.id, { resolve, reject });
        worker.postMessage(msg, transfer);
      });
    };
    const copy = bytes.slice().buffer;
    try {
      await call({ type: 'load', id: ++seq, bytes: copy, execution_providers: options.execution_providers, ort_wasm_base_url: options.ort_wasm_base_url, expect }, [copy]);
    } catch (error) {
      worker.terminate();
      throw new InferenceWorkerUnavailable(`inference worker could not load the model: ${(error as Error).message}`);
    }
    return {
      run: async (feeds) => {
        const sent: Record<string, Feed> = {};
        const transfer: Transferable[] = [];
        for (const [name, value] of Object.entries(feeds)) {
          const data = value.data.slice(); // the caller may reuse its buffers
          sent[name] = { data, dims: [...value.dims] };
          transfer.push(data.buffer);
        }
        const reply = await call({ type: 'run', id: ++seq, feeds: sent }, transfer);
        if (reply.type !== 'result') throw new Error('unexpected inference reply');
        return reply.outputs;
      },
      release: async () => {
        try {
          if (!dead) await call({ type: 'release', id: ++seq });
        } finally {
          worker.terminate();
        }
      },
    };
  };
}
