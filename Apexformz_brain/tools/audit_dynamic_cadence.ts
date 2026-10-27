/** Recorded-capture regression across observation rates; not a technique accuracy evaluation. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PoseFrame } from '@apexformz/contracts';
import { activeSession, calibration } from '../tests/helpers/packs';
import { FeatureEngine } from '@apexformz/features';
import { SignalPipeline } from '@apexformz/signal';

const datasetPath = 'data/squash/dataset_dynamic_movement.json';
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const ids = ['squash.dynamic.0014', 'squash.dynamic.0020', 'squash.dynamic.0030', 'squash.dynamic.0040'];
const output = process.env.CADENCE_AUDIT_OUTPUT || 'data/audit/dynamic-investigation/cadence-current.json';
const preferredView = process.env.CADENCE_AUDIT_VIEW || 'back';
const wantedFeatures = ['dominant_elbow_velocity', 'lead_knee_velocity', 'hip_vertical_velocity', 'body_motion', 'body_travel', 'head_stability', 'dominant_wrist_jerk'];
const featureSpecs = JSON.parse(fs.readFileSync('sport-packs/squash/technique_criteria.json', 'utf8')).features;
const rows: unknown[] = [];
async function main() {
for (const id of ids) {
  const execution = dataset.executions.find((x: any) => x.movement_id === id && x.view_stream_ids.some((sid: string) => {
    const stream = dataset.view_streams.find((s: any) => s.view_stream_id === sid);
    return dataset.cameras.find((c: any) => c.camera_id === stream.camera_id)?.view === preferredView;
  })) ?? dataset.executions.find((x: any) => x.movement_id === id);
  if (!execution) continue;
  for (const streamId of execution.view_stream_ids) {
    const stream = dataset.view_streams.find((s: any) => s.view_stream_id === streamId);
    const camera = dataset.cameras.find((c: any) => c.camera_id === stream.camera_id);
    const athlete = dataset.athletes.find((a: any) => a.athlete_id === execution.athlete_id);
    const bytes = fs.readFileSync(path.join(path.dirname(datasetPath), stream.pose_path));
    if (createHash('sha256').update(bytes).digest('hex') !== stream.pose_sha256) throw new Error('Changed source pose stream');
    const frames: PoseFrame[] = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).filter(f => f.timestamp_ms >= execution.start_ms && f.timestamp_ms <= execution.end_ms);
    for (const fps of [30, 10, 5, 3]) {
      const selected: PoseFrame[] = [];
      let last = -Infinity;
      for (const f of frames) if (f.timestamp_ms - last >= 1000 / fps - 1) { selected.push(f); last = f.timestamp_ms; }
      const { rt, sessionId } = await activeSession(['squash'], 'squash', id, { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true }, calibration({ nominal_view: camera.view, camera_tilt_deg: null, athlete_context: 'unknown', handedness: stream.handedness ?? athlete.handedness }));
      const probe = new FeatureEngine(featureSpecs, { cadence_max_gap_ms: 400 });
      const signal = new SignalPipeline({ view: camera.view });
      const stats: any = { movement: id, view: camera.view, source_execution: execution.execution_id, fps, frames: selected.length, quality_good: 0, assessments: 0, criteria: {}, phases: {}, guided_phases: {}, gaps: 0, features: {}, adapted_feature_probe: {} };
      for (let i = 0; i < selected.length; i++) {
        const f = { ...selected[i], timestamp_ms: selected[i].timestamp_ms - selected[0].timestamp_ms + 1, frame_id: i, session_id: sessionId };
        const tick = rt.process(f, f.timestamp_ms)!;
        const processed = signal.process(f);
        if (processed.time_gap || processed.track_changed) probe.reset();
        const probeFeatures = probe.compute(signal.window, { view: camera.view, handedness: stream.handedness ?? athlete.handedness });
        for (const key of wantedFeatures) {
          const fv = probeFeatures.get(key); if (!fv) continue;
          const counts = stats.adapted_feature_probe[key] ??= { valid: 0, invalid: {} };
          if (fv.valid) counts.valid++; else counts.invalid[fv.reason ?? 'unknown'] = (counts.invalid[fv.reason ?? 'unknown'] || 0) + 1;
        }
        if (!tick) continue;
        if (tick.quality.ok) stats.quality_good++;
        if (tick.signal.time_gap) stats.gaps++;
        if (tick.assessment) { stats.assessments++; for (const c of tick.assessment.criteria) stats.criteria[c.state] = (stats.criteria[c.state] || 0) + 1; }
        const phase = tick.temporal?.phase_id ?? 'idle'; stats.phases[phase] = (stats.phases[phase] || 0) + 1;
        if (tick.guided_attempt) stats.guided_phases[tick.guided_attempt.phase_id] = (stats.guided_phases[tick.guided_attempt.phase_id] || 0) + 1;
        for (const id of wantedFeatures) {
          const fv = tick.features.find(f => f.spec_id === id); if (!fv) continue;
          const s = stats.features[id] ??= { valid: 0, invalid: {}, min: null, max: null };
          if (fv.valid && fv.value !== null) { s.valid++; s.min = Math.min(s.min ?? Infinity, fv.value); s.max = Math.max(s.max ?? -Infinity, fv.value); }
          else s.invalid[fv.reason ?? 'unknown'] = (s.invalid[fv.reason ?? 'unknown'] || 0) + 1;
        }
      }
      rows.push(stats);
      console.log(`${id} ${camera.view} ${fps}fps: ${stats.assessments} assessments, velocity=${stats.features.dominant_elbow_velocity?.valid}/${stats.frames}, motion=${stats.features.body_motion?.valid}/${stats.frames}`);
    }
  }
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ dataset: datasetPath, source: 'Original captured poses at source timestamps, downsampled without interpolation. This measures readiness and pipeline behavior, not technique accuracy.', rows }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
