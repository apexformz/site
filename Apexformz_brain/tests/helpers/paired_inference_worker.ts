import type { OnnxSessionLike } from '@apexformz/analysis';
import { hostInference, type PortLike } from '../../packages/brain-client/src/inference_host';
import type { WorkerLike } from '../../packages/brain-client/src/remote_session';

/** Messages cross asynchronously; the host and client use their real protocol handlers. */
export function pairedInferenceWorker(open: (bytes: Uint8Array) => Promise<OnnxSessionLike>): WorkerLike & { terminated: boolean } {
  const host: PortLike = { postMessage: (m) => setTimeout(() => worker.onmessage?.({ data: m }), 0), onmessage: null };
  const worker = {
    terminated: false,
    onmessage: null as WorkerLike['onmessage'],
    onerror: null as WorkerLike['onerror'],
    postMessage: (m: unknown) => setTimeout(() => host.onmessage?.({ data: m }), 0),
    terminate() { this.terminated = true; },
  };
  hostInference(host, (bytes) => open(bytes));
  return worker;
}
