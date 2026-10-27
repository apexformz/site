/** Recorded pose replay and controlled local faults for browser integration; never independent accuracy data. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LANDMARK_INDEX, type DynamicReferenceModel, type PoseFrame } from '@apexformz/contracts';
import { rotateRecordedPose180 } from './dynamic_reference_orientation';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };

/** Change the measured knee angle alone, retaining original source identity, quality and other joints. */
export function perturbLeftKnee(frame: PoseFrame, amount: number): PoseFrame {
  const output = structuredClone(frame);
  if (amount <= 0) return output;
  const p = output.normalized_landmarks;
  const knee = p.find(l => l.id === LANDMARK_INDEX.left_knee)!;
  const hip = p.find(l => l.id === LANDMARK_INDEX.left_hip)!;
  const ankle = p.find(l => l.id === LANDMARK_INDEX.left_ankle)!;
  const [width, height] = frame.image_size;
  const hx = hip.x * width, hy = hip.y * height, ax = ankle.x * width, ay = ankle.y * height;
  // A midpoint displaced perpendicular by half the hip-to-ankle distance
  // makes a 90-degree bend in image geometry, with continuous entry/exit.
  const targetX = ((hx + ax) / 2 + (ay - hy) / 2) / width;
  const targetY = ((hy + ay) / 2 - (ax - hx) / 2) / height;
  knee.x += Math.max(0, Math.min(1, amount)) * (targetX - knee.x);
  knee.y += Math.max(0, Math.min(1, amount)) * (targetY - knee.y);
  return output;
}

function main() {
  const movement = arg('movement', 'squash.dynamic.0040');
  const view = arg('view', 'back');
  const out = path.resolve(arg('out', 'data/audit/dynamic-reference-comparison/browser-fixtures'));
  const modelPath = path.resolve('sport-packs/squash/models/dynamic-reference', `${movement}.json`);
  const model: DynamicReferenceModel = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const reference = model.references.filter(r => r.view === view).sort((a, b) => b.duration_ms - a.duration_ms)[0];
  if (!reference) throw new Error(`No ${view} reference for ${movement}`);
  const datasetPath = path.resolve('data/squash/dataset_dynamic_movement.json');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const execution = dataset.executions.find((e: { execution_id: string }) => e.execution_id === reference.source_execution_id);
  const stream = dataset.view_streams.find((s: { view_stream_id: string }) => execution.view_stream_ids.includes(s.view_stream_id));
  const posePath = path.resolve(path.dirname(datasetPath), stream.pose_path);
  const bytes = fs.readFileSync(posePath);
  if (digest(bytes) !== reference.source_pose_sha256) throw new Error('Recorded pose source digest mismatch');
  const source: PoseFrame[] = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(row => !('_header' in row));
  const canonical = reference.recorded_source_transform?.rotation_degrees === 180 ? source.map(rotateRecordedPose180) : source;
  const segment = canonical.filter(frame => frame.timestamp_ms >= reference.start_ms && frame.timestamp_ms <= reference.end_ms);
  if (segment.length < 5) throw new Error('Reference segment has too few source observations');
  const step_ms = 100;
  const warmup_ms = 600;
  const settle_ms = 1800;
  const framesFor = (wrong: boolean): PoseFrame[] => {
    const frames: PoseFrame[] = [];
    for (let t = 0; t <= warmup_ms + reference.duration_ms + settle_ms; t += step_ms) {
      const progress = Math.max(0, Math.min(1, (t - warmup_ms) / reference.duration_ms));
      const sourceTime = reference.start_ms + progress * reference.duration_ms;
      const original = segment.reduce((best, frame) => Math.abs(frame.timestamp_ms - sourceTime) < Math.abs(best.timestamp_ms - sourceTime) ? frame : best, segment[0]);
      const amount = wrong ? Math.max(0, Math.min(1, (progress - .2) / .1, (.8 - progress) / .1)) : 0;
      const frame = perturbLeftKnee(original, amount);
      frames.push({ ...frame, frame_id: frames.length, timestamp_ms: t, session_id: 'recorded-reference-browser-fixture' });
    }
    return frames;
  };
  const correct = framesFor(false), wrong = framesFor(true);
  // Explicit tracking gap between replayed attempts prevents the artificial
  // jump back to the source's first pose from becoming a technique fault.
  const reset = structuredClone(correct[0]);
  reset.quality = { ...reset.quality, framing_ok: false };
  const combined = [...wrong, ...Array.from({ length: 5 }, () => structuredClone(reset)), ...correct]
    .map((frame, i) => ({ ...frame, frame_id: i, timestamp_ms: i * step_ms }));
  fs.mkdirSync(out, { recursive: true });
  const common = { movement_id: movement, view, handedness: reference.handedness, step_ms, reference_id: reference.id,
    reference_complete_capture: reference.complete_capture, source_pose_sha256: reference.source_pose_sha256,
    recorded_source_transform: reference.recorded_source_transform,
    source_media_sha256: reference.source_media_sha256, reference_model_sha256: digest(fs.readFileSync(modelPath)),
    limitations: ['Source replay is not held-out accuracy.', 'Pose detection is bypassed; the real worker, alignment, feedback and persistence remain active.', 'The left-knee fault is controlled synthetic geometry, not a coach-labelled real error.'] };
  for (const [name, frames] of [['correct-recorded', correct], ['wrong-knee', wrong], ['wrong-then-correct', combined]] as const) {
    const artifact = { ...common, input_kind: name === 'correct-recorded' ? 'recorded reference poses through real worker; perception bypassed' : 'recorded reference poses with controlled synthetic knee fault; perception bypassed', frames };
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(artifact));
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ ...common, source_pose_path: posePath, frame_counts: { correct: correct.length, wrong: wrong.length, combined: combined.length }, duration_ms: { correct: correct.length * step_ms, combined: combined.length * step_ms } }, null, 2));
  console.log(JSON.stringify({ out, movement, view, reference_id: reference.id, complete_capture: reference.complete_capture, frames: correct.length, combined_frames: combined.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
