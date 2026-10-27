import fs from 'node:fs';
import { SignalPipeline } from '@apexformz/signal';
import { canonicalizeMirror, toFilteredImageLandmarks, normalizeBodyRelative } from '../packages/signal/src/coordinates';
import type { PoseFrame } from '@apexformz/contracts';

const dataset = JSON.parse(fs.readFileSync('data/squash/dataset_dynamic_movement.json', 'utf8'));
const inputs: { name: string; path: string; fps?: number }[] = [];
for (const view of ['front', 'back']) {
  const e = dataset.executions.find((e: any) => e.movement_id === 'squash.dynamic.0040' && e.view_stream_ids.some((id: string) => {
    const s = dataset.view_streams.find((s: any) => s.view_stream_id === id);
    return dataset.cameras.find((c: any) => c.camera_id === s.camera_id).view === view;
  }));
  const s = dataset.view_streams.find((s: any) => s.view_stream_id === e.view_stream_ids[0]);
  for (const fps of [5, 3]) inputs.push({ name: `original-${view}-${fps}fps`, path: 'data/squash/' + s.pose_path, fps });
}
for (const name of ['baseline-backhand-5fps', 'user-backhand-in-progress']) inputs.push({ name, path: `data/audit/dynamic-investigation/${name}/poses.jsonl` });
const rows = inputs.map(input => {
  const pipeline = new SignalPipeline();
  let last = -Infinity;
  const samples = fs.readFileSync(input.path, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l)).filter(f => f.frame_id !== undefined).filter((f: PoseFrame) => {
    if (input.fps && f.timestamp_ms - last < 1000 / input.fps - 1) return false;
    last = f.timestamp_ms; return true;
  }).map((f: PoseFrame, i) => {
    f = { ...f, frame_id: i };
    const raw = normalizeBodyRelative(toFilteredImageLandmarks(canonicalizeMirror(f).landmarks, 0.5), f.image_size);
    const filtered = pipeline.process(f).frame!;
    const values = (landmarks: any[]) => [14, 16].map(id => {
      const l = landmarks.find(l => l.id === id);
      return { id, x: l?.x, y: l?.y, confidence: l?.confidence, valid: l?.valid, predicted: l?.predicted, reason: l?.reason };
    });
    return { ts: f.timestamp_ms, scale_px: raw.scale_px, raw: values(raw.body), filtered: values(filtered.body), person_count: f.quality.person_count, track: f.tracked_subject_id };
  });
  const validRaw = samples.map(s => s.raw[1]).filter(s => s.valid);
  const predicted = samples.filter(s => s.filtered[1].predicted);
  const filteredY = samples.map(s => s.filtered[1].y).filter(Number.isFinite);
  const summary = { name: input.name, frames: samples.length, scale_min: Math.min(...samples.map(s => s.scale_px ?? Infinity)), scale_max: Math.max(...samples.map(s => s.scale_px ?? -Infinity)), raw_wrist_y_range: [Math.min(...validRaw.map(s => s.y)), Math.max(...validRaw.map(s => s.y))], filtered_wrist_y_range: [Math.min(...filteredY), Math.max(...filteredY)], wrist_predicted_frames: predicted.length, wrist_observed_valid_frames: samples.filter(s => s.filtered[1].valid && !s.filtered[1].predicted).length };
  console.log(JSON.stringify(summary));
  return { ...summary, path: input.path, samples };
});
fs.writeFileSync('data/audit/dynamic-investigation/pose-quality.json', JSON.stringify(rows, null, 2));
