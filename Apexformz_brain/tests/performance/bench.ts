/**
 * Sustained-session benchmark (TRD 00/14): drives the Brain runtime with a
 * synthetic athlete for a configurable duration at a fixed frame rate and
 * reports per-stage latency percentiles, throughput and memory.
 *
 *   npx tsx tests/performance/bench.ts [minutes=20] [fps=30] [sport=badminton] [movement=badminton.lunge]
 *
 * Numbers are for the reference machine that ran them and never substitute for
 * on-device profiling; the TRD latency targets are aspirational until measured
 * on target hardware.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { activeSession } from '../helpers/packs';

const here = path.dirname(fileURLToPath(import.meta.url));
const minutes = Number(process.argv[2] ?? 20);
const fps = Number(process.argv[3] ?? 30);
const sport = process.argv[4] ?? 'badminton';
const movement = process.argv[5] ?? 'badminton.lunge';

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Repeating lunge cycle: ready, drive, bottom, recovery (4 s) with small jitter. */
function athlete(t: number): SyntheticPoseOptions {
  const cycle = (t / 1000) % 4;
  let knee = 0;
  if (cycle > 1 && cycle <= 1.4) knee = 50;
  else if (cycle > 1.4 && cycle <= 2.4) knee = 70;
  else if (cycle > 2.4 && cycle <= 2.8) knee = 30;
  const jitter = Math.sin(t / 97) * 1.5;
  return { right_knee_flexion: knee + jitter, right_arm_raise: 40 + Math.sin(t / 211) * 3, right_elbow_flexion: 20 };
}

async function main() {
  const { rt, sessionId } = await activeSession([sport], sport, movement, { strict_rubrics: false, allow_draft_feedback: true, telemetry_interval_ms: 5000 });
  const totalFrames = Math.round(minutes * 60 * fps);
  const dt = 1000 / fps;
  const latencies: number[] = [];
  let feedback = 0;
  let assessments = 0;
  let completed = 0;
  const memStart = process.memoryUsage().heapUsed;
  const wallStart = performance.now();
  let maxHeap = memStart;
  for (let i = 0; i < totalFrames; i++) {
    const t = i * dt;
    const frame = syntheticPoseFrame(i, t, athlete(t), { session_id: sessionId });
    const t0 = performance.now();
    const tick = rt.process(frame, t);
    latencies.push(performance.now() - t0);
    if (tick?.feedback) feedback++;
    if (tick?.assessment) assessments++;
    if (tick?.temporal?.completed) completed++;
    if ((i & 1023) === 0) maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
  }
  const wall = performance.now() - wallStart;
  const summary = rt.complete(totalFrames * dt);
  const tel = rt.telemetry() ?? null;
  latencies.sort((a, b) => a - b);
  const report = {
    generated_at: new Date().toISOString(),
    machine: { platform: process.platform, arch: process.arch, node: process.version },
    config: { minutes, fps, sport, movement, frames: totalFrames },
    per_frame_ms: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: latencies[latencies.length - 1] },
    throughput_fps_equivalent: Math.round((totalFrames / wall) * 1000),
    wall_ms: Math.round(wall),
    memory_mb: { start: +(memStart / 1048576).toFixed(1), max: +(maxHeap / 1048576).toFixed(1), end: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) },
    outcomes: { executions_completed: completed, assessments, feedback_issued: feedback, summary },
    stage_durations_ms: tel?.stage_durations_ms ?? null,
    note: 'Synthetic athlete on a development machine; not a device benchmark. TRD P95 targets remain aspirational until measured on reference hardware.',
  };
  const outDir = path.join(here, 'results');
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `bench-${sport}-${minutes}min-${fps}fps.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, outcomes: { ...report.outcomes, summary: undefined } }, null, 2));
  console.log(`report written to ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
