import { parentPort } from 'node:worker_threads';
import { hostInference, type PortLike } from '../packages/brain-client/src/inference_host';
import { openOrtSession } from '../packages/brain-client/src/movement_model_loader';

const port: PortLike = { postMessage: (m, t) => parentPort!.postMessage(m, t as never), onmessage: null };
parentPort!.on('message', (data) => port.onmessage?.({ data }));
const SLOWDOWN = Number(process.env.BENCH_SLOWDOWN ?? 1);
function busy(ms: number) { const end = performance.now() + ms; while (performance.now() < end) { /* emulate a slower device */ } }
hostInference(port, async (bytes, options) => {
  const s = await openOrtSession(bytes, options);
  return { run: async (f) => { const t = performance.now(); const out = await s.run(f); if (SLOWDOWN > 1) busy((SLOWDOWN - 1) * (performance.now() - t)); return out; }, release: () => s.release?.() ?? Promise.resolve() };
});
