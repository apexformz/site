/**
 * Before/after check for the dedicated movement-inference worker, with real threads and the installed model.
 *
 * A "tracking" loop handles one camera frame every 33 ms (simulated pose work), while movement recognition
 * runs every 200 ms, either inline on the same thread or in its own worker thread. Reports how late each
 * tracking frame is: a late frame is what the user sees as skeleton stutter.
 *
 *   npx tsx scripts/bench_inference_isolation.ts [seconds] [pose_ms] [cpu_slowdown]
 */
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { openOrtSession } from '../packages/brain-client/src/movement_model_loader';
import { remoteSessionFactory, type WorkerLike } from '../packages/brain-client/src/remote_session';
import type { OnnxSessionLike } from '@apexformz/analysis';

const SECONDS = Number(process.argv[2] ?? 10);
const POSE_MS = Number(process.argv[3] ?? 8);
const SLOWDOWN = Number(process.argv[4] ?? 1); // emulate a slower device: inference work is stretched on the thread that runs it
process.env.BENCH_SLOWDOWN = String(SLOWDOWN);
const MODEL = 'apps/frontend/public/models/squash/dynamic_movement.onnx';

function busy(ms: number) { const end = performance.now() + ms; while (performance.now() < end) { /* simulated pose work */ } }

function nodeWorker(): WorkerLike {
  const w = new Worker(resolve(__dirname, 'bench_inference_host.ts'), { execArgv: ['--import', 'tsx'], env: { ...process.env } });
  const like: WorkerLike = {
    onmessage: null, onerror: null,
    postMessage: (m, t) => w.postMessage(m, t as never),
    terminate: () => { void w.terminate(); },
  };
  w.on('message', (data) => like.onmessage?.({ data }));
  w.on('error', (e) => like.onerror?.(e));
  return like;
}

async function run(mode: 'inline' | 'worker') {
  const bytes = new Uint8Array(readFileSync(MODEL));
  const base: OnnxSessionLike = mode === 'inline' ? await openOrtSession(bytes, {}) : await remoteSessionFactory(nodeWorker)(bytes, {});
  const session: OnnxSessionLike = mode === 'inline' && SLOWDOWN > 1
    ? { run: async (f) => { const t = performance.now(); const out = await base.run(f); busy((SLOWDOWN - 1) * (performance.now() - t)); return out; }, release: () => base.release?.() ?? Promise.resolve() }
    : base;
  const T = 45;
  const feeds = () => ({ input: { data: Float32Array.from({ length: T * 99 }, () => Math.random() * 0.2), dims: [1, T, 99] }, mask: { data: new Float32Array(T * 33).fill(1), dims: [1, T, 33] } });
  for (let i = 0; i < 3; i++) await session.run(feeds()); // warm-up
  const late: number[] = [];
  let busyInference = false;
  const t0 = performance.now();
  let next = t0;
  let lastInference = t0;
  while (performance.now() - t0 < SECONDS * 1000) {
    const now = performance.now();
    if (now < next) { await new Promise((r) => setTimeout(r, Math.max(0, next - now - 1))); continue; }
    late.push(now - next);           // how late this frame started
    busy(POSE_MS);                   // pose detection for this frame
    if (now - lastInference >= 200 && !busyInference) {   // the detector's 200 ms inference cadence, one at a time
      lastInference = now;
      busyInference = true;
      const p = session.run(feeds()).then(() => { busyInference = false; });
      if (mode === 'inline') await p; // inline: the same thread does the work
    }
    next += 33.3;
  }
  await session.release?.();
  late.sort((a, b) => a - b);
  const pct = (q: number) => late[Math.min(late.length - 1, Math.floor(q * late.length))];
  const stutter = late.filter((d) => d > 16).length;
  return { mode, frames: late.length, median_late_ms: +pct(0.5).toFixed(1), p95_late_ms: +pct(0.95).toFixed(1), worst_late_ms: +late[late.length - 1].toFixed(1), frames_late_over_16ms: stutter };
}

async function main() {
  const results = [await run('inline'), await run('worker')];
  console.table(results);
}
void main();
