/** Recorded regression, not accuracy evaluation. Uses source poses and actual browser ONNX inference. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AssessmentSet, FeedbackAction, PoseFrame, SportPackBundle } from '@apexformz/contracts';
import type { MovementDetection } from '@apexformz/analysis';
import { BrainRuntime, type BrainTick } from '@apexformz/runtime';
import { loadSportPack, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET } from '@apexformz/sport-runtime';
import { readPackDir } from '@apexformz/sport-runtime/node';
import { loadBrowserMovementModel, type LoadedMovementModel } from '../packages/brain-client/src/movement_model_loader';
import { recognitionHierarchy } from '../packages/brain-client/src/movement_detector';
import { currentAssessment, currentDetections, currentFeedback } from '../apps/frontend/src/lib/brain/presentation';
import { replayCalibration, replayFrame, type Clip } from './calibrate_phase_graphs';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const bump = (counts: Record<string, number>, key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
const check = (ok: unknown, why: string): void => { if (!ok) throw new Error(`Replay invariant failed: ${why}`); };

/** Stop on a corrupted source or accidental DataSorter/portrait preparation, rather than weakening quality. */
export function validateReplaySource(root: string, stream: { pose_path: string; pose_sha256: string; object_uri: string; extraction: { orientation_policy: string } }): string {
  if (!/^s3:\/\/apexformz-datacapture-[^/]+\/raw\/squash\//.test(stream.object_uri)) throw new Error('Only squash Data Capture sources are accepted');
  if (stream.extraction?.orientation_policy !== 'encoded') throw new Error('Replay requires encoded landscape orientation');
  const resolved = path.resolve(root, stream.pose_path), relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Pose path escapes dataset directory');
  if (!/^[a-f0-9]{64}$/i.test(stream.pose_sha256)) throw new Error('Pinned pose_sha256 is required');
  return resolved;
}

/** Assertions target routing, fail-closed gates and presentation, never unreviewed technique accuracy. */
export function assertReplayTick(tick: BrainTick, movement: string, strict: boolean): void {
  check(tick.executed_pack.id === 'squash', 'sport routing');
  for (const output of [tick.temporal, tick.assessment, tick.feedback]) if (output) check(output.movement_id === movement, 'selected movement changed');
  for (const f of tick.features) if (f.value !== null) check(Number.isFinite(f.value), 'nonfinite feature');
  if (tick.assessment) {
    check(tick.assessment.score === null || Number.isFinite(tick.assessment.score), 'nonfinite score');
    for (const c of tick.assessment.criteria) {
      check(c.measurement.value === null || Number.isFinite(c.measurement.value), 'nonfinite measurement');
      if (strict && c.provenance.validation_status !== 'approved') check(c.state !== 'PASS' && c.state !== 'IMPROVE', 'unapproved strict verdict');
    }
  }
  if (tick.feedback) {
    check(currentFeedback(tick.feedback, tick, false, tick.timestamp_ms) === null, 'feedback survived camera stop');
    check(currentFeedback(tick.feedback, tick, true, tick.feedback.expires_ms) === null, 'expired feedback remained visible');
    if (strict) check(tick.feedback.kind !== 'technique_cue', 'draft squash technique cue in strict mode');
  }
}

function *clips(datasetPath: string, limit: number): Generator<{ clip: Clip; source: Record<string, unknown> }> {
  const ds = read(datasetPath), root = path.dirname(datasetPath);
  if (ds.sport_pack_id !== 'squash') throw new Error('Expected squash manifest');
  const streams = new Map<string, any>(ds.view_streams.map((s: any) => [s.view_stream_id, s]));
  const cameras = new Map<string, any>(ds.cameras.map((c: any) => [c.camera_id, c]));
  let n = 0;
  for (const e of ds.executions) {
    const split = ds.splits?.assignments?.[e.execution_id];
    if (!['train', 'val', 'test'].includes(split)) throw new Error(`Missing explicit split: ${e.execution_id}`);
    if (!Number.isFinite(e.start_ms) || !Number.isFinite(e.end_ms) || e.end_ms < e.start_ms) throw new Error('Invalid capture bounds');
    const athlete = ds.athletes.find((a: any) => a.athlete_id === e.athlete_id);
    for (const streamId of e.view_stream_ids) {
      if (n++ >= limit) return;
      const st = streams.get(streamId);
      if (!st) throw new Error(`Missing stream: ${streamId}`);
      const bytes = fs.readFileSync(validateReplaySource(root, st));
      if (hash(bytes) !== st.pose_sha256) throw new Error(`Pose checksum mismatch: ${streamId}`);
      const frames: PoseFrame[] = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s))
        .filter((f) => !('_header' in f) && f.timestamp_ms >= e.start_ms && f.timestamp_ms <= e.end_ms);
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (f.image_size[0] < f.image_size[1]) throw new Error(`Portrait pixels in landscape replay: ${streamId}`);
        if (!Number.isFinite(f.timestamp_ms) || (i > 0 && f.timestamp_ms <= frames[i - 1].timestamp_ms)) throw new Error(`Invalid source clock: ${streamId}`);
      }
      const hand = st.handedness ?? athlete?.handedness;
      yield { clip: { execution_id: e.execution_id, stream_id: streamId, movement_id: e.movement_id, athlete_id: e.athlete_id,
        frames, start_ms: e.start_ms, end_ms: e.end_ms, view: cameras.get(st.camera_id)?.view ?? 'unknown',
        handedness: hand === 'left' || hand === 'right' ? hand : 'unknown',
        athlete_context: ['novice', 'intermediate', 'advanced'].includes(athlete?.context) ? athlete.context : 'unknown' },
        source: { source_sha256: st.sha256, pose_sha256: st.pose_sha256, object_uri: st.object_uri, capture_session_id: e.capture_session_id,
          source_start_ms: e.start_ms, source_end_ms: e.end_ms,
          dataset_path: datasetPath, dataset_sha256: hash(fs.readFileSync(datasetPath)), split, model_task: ds.model_task } };
    }
  }
}

function recognitionContext(d: MovementDetection) {
  return { timestamp_ms: d.timestamp_ms, level: d.level ?? (d.unknown ? null : 'movement' as const),
    family_id: d.family_id ?? null, group_id: d.group_id ?? null, movement_id: d.movement_id,
    probability: d.level === 'family' ? d.family_probability ?? null : d.level === 'group' ? d.group_probability ?? null : d.probability,
    validated: d.calibration_status === 'validated' };
}

async function replay(bundle: SportPackBundle, models: LoadedMovementModel[], clip: Clip, strict: boolean, seq: number) {
  const rt = new BrainRuntime({ strict_rubrics: strict, allow_draft_feedback: !strict,
    recognition_gating: { enabled: true, require_validated: true }, hmac_keys: { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET } });
  rt.installBundle(bundle); rt.activatePack('squash', bundle.manifest.version);
  const sessionId = `recorded-${strict ? 'strict' : 'development'}-${seq}`, cal = replayCalibration(clip);
  rt.calibrate(cal, 0);
  rt.start({ session_id: sessionId, athlete_id: clip.athlete_id, sport_pack_id: 'squash', sport_pack_version: bundle.manifest.version,
    movement_id: clip.movement_id, calibration: cal, pinned_models: [] }, 0);
  for (const m of models) m.detector.startSession(sessionId, 'squash', clip.movement_id, recognitionHierarchy(bundle.movement_catalog.taxonomy), clip.handedness);
  const result = { execution_id: clip.execution_id, stream_id: clip.stream_id, movement_id: clip.movement_id, view: clip.view,
    source_frames: clip.frames.length, frames_processed: 0, quality_ok: 0, ambiguous_frames: 0, identity_resets: 0, time_gaps: 0,
    phase_states: {} as Record<string, number>, phases_reached: [] as string[], assessments: 0, criterion_states: {} as Record<string, number>,
    feedback: {} as Record<string, number>, suppressed: {} as Record<string, number>, recognition_reasons: {} as Record<string, number>,
    inferred_results: 0, accepted_movements: 0, accepted_groups_or_families: 0, completed: 0, no_temporal_evidence: false };
  const phases = new Set<string>(), measurements = new Map<string, Record<string, unknown>>();
  const runtimeMs: number[] = [], recognitionMs: number[] = [];
  let assessment: AssessmentSet | null = null, feedback: FeedbackAction | null = null, continuity = 0, repetitionBaseline = 0;
  const executionOrder = new Map<string, number>();
  const sourceOffset = (clip.frames[0]?.timestamp_ms ?? clip.start_ms) - 1;
  for (let i = 0; i < clip.frames.length; i++) {
    const frame = replayFrame(clip.frames[i], sessionId, i, sourceOffset);
    let t = performance.now(); const tick = rt.process(frame, frame.timestamp_ms); runtimeMs.push(performance.now() - t);
    if (!tick) continue;
    assertReplayTick(tick, clip.movement_id, strict);
    result.frames_processed++; if (tick.quality.ok) result.quality_ok++;
    if (frame.quality.ambiguous_people) result.ambiguous_frames++;
    if (tick.signal.track_changed) result.identity_resets++;
    if (tick.signal.track_changed) repetitionBaseline++;
    if (tick.signal.time_gap) result.time_gaps++;
    if (tick.signal.time_gap || tick.signal.track_changed || frame.quality.ambiguous_people) continuity++;
    if (tick.temporal) { bump(result.phase_states, tick.temporal.state); if (tick.temporal.phase_id) phases.add(tick.temporal.phase_id); if (tick.temporal.completed) result.completed++; }
    if (tick.suppressed_reason) bump(result.suppressed, tick.suppressed_reason);
    if (tick.assessment) {
      assessment = tick.assessment; result.assessments++;
      const executionKey = assessment.execution_id ?? `frame-${i}`;
      if (!executionOrder.has(executionKey)) executionOrder.set(executionKey, executionOrder.size);
      for (const c of assessment.criteria) {
        bump(result.criterion_states, c.state);
        // UI evidence IDs are capped at 60 frames. Use the conservative full execution
        // interval, never that truncated tail, when joining a reviewed repetition.
        const executionStart = tick.temporal?.execution_phases[0]?.start_ms;
        measurements.set(`${assessment.execution_id}/${c.criterion_id}`, {
          execution_id: clip.execution_id, source_execution_id: clip.execution_id, stream_id: clip.stream_id, runtime_execution_id: assessment.execution_id,
          continuity_id: `${sessionId}/${continuity}`, sequence_index: executionOrder.get(executionKey),
          repetition_baseline_id: `${sessionId}/${repetitionBaseline}`, repetition_history_complete: false,
          movement_id: clip.movement_id, criterion_id: c.criterion_id, phase_id: c.phase_id,
          timestamp_ms: c.timestamp_ms + sourceOffset, measurement: c.measurement, evidence: c.evidence,
          measurement_start_ms: executionStart === undefined ? null : executionStart + sourceOffset,
          measurement_end_ms: executionStart === undefined ? null : c.timestamp_ms + sourceOffset,
          measurement_span_kind: executionStart === undefined ? 'unavailable' : 'conservative_runtime_execution_interval',
          athlete_id: clip.athlete_id, athlete_context: clip.athlete_context, handedness: clip.handedness,
          runtime_state: c.state, runtime_provenance: c.provenance, review_status: 'unreviewed', mode: strict ? 'strict' : 'development',
        });
      }
    }
    if (tick.feedback) { feedback = tick.feedback; bump(result.feedback, feedback.kind); }
    // Run the same UI admission functions as the browser between phase updates.
    const visibleAssessment = currentAssessment(assessment, tick, 0);
    if (!tick.quality.ok || tick.signal.time_gap || tick.signal.track_changed) check(visibleAssessment === null, 'assessment crossed quality/identity boundary');
    currentFeedback(feedback, tick, true, frame.timestamp_ms);
    for (const m of models) {
      t = performance.now(); const d = await m.detector.observe(frame, tick); recognitionMs.push(performance.now() - t);
      if (!d) continue;
      check(d.selected_coaching_movement_id === clip.movement_id && d.session_id === sessionId, 'recognition routing');
      bump(result.recognition_reasons, `${m.detector.config.model_task}:${d.reason ?? 'accepted'}`);
      if (Object.keys(d.probabilities).length) result.inferred_results++;
      if (!d.unknown) result.accepted_movements++;
      if (d.level === 'group' || d.level === 'family') result.accepted_groups_or_families++;
      if (strict && d.calibration_status !== 'validated') check(d.unknown && !d.level, 'unvalidated strict recognition');
      check(Object.keys(currentDetections({ [d.model_task]: d }, false, sessionId, d.timestamp_ms, 0)).length === 0, 'recognition survived stop');
      check(Object.keys(currentDetections({ [d.model_task]: d }, true, sessionId, d.timestamp_ms + 1001, 0)).length === 0, 'stale recognition visible');
      rt.noteRecognition(recognitionContext(d));
    }
  }
  rt.complete((clip.frames.at(-1)?.timestamp_ms ?? clip.start_ms) - sourceOffset + 1);
  for (const m of models) m.detector.endSession();
  result.phases_reached = [...phases]; result.no_temporal_evidence = !phases.size;
  return { result, measurements: [...measurements.values()], runtimeMs, recognitionMs };
}

const percentile = (v: number[], p: number) => v.length ? [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * p))] : null;

/** Deliberate stream faults on recorded poses, kept out of metrics, labels and fitting exports. */
async function boundaryProbes(bundle: SportPackBundle, models: LoadedMovementModel[], clip: Clip) {
  const rt = new BrainRuntime({ strict_rubrics: false, allow_draft_feedback: false });
  rt.installBundle(bundle); rt.activatePack('squash', bundle.manifest.version);
  const id = 'recorded-boundary-probes', cal = replayCalibration(clip);
  rt.calibrate(cal, 0);
  rt.start({ session_id: id, athlete_id: clip.athlete_id, sport_pack_id: 'squash', sport_pack_version: bundle.manifest.version,
    movement_id: clip.movement_id, calibration: cal, pinned_models: [] }, 0);
  for (const m of models) m.detector.startSession(id, 'squash', clip.movement_id, recognitionHierarchy(bundle.movement_catalog.taxonomy), clip.handedness);
  let last: PoseFrame | null = null;
  const offset = clip.frames[0].timestamp_ms - 1;
  for (let i = 0; i < clip.frames.length; i++) {
    last = replayFrame(clip.frames[i], id, i, offset);
    const t = rt.process(last, last.timestamp_ms);
    if (t) for (const m of models) await m.detector.observe(last, t);
  }
  if (!last) throw new Error('Boundary probe requires source frames');
  const stale = rt.process(last, last.timestamp_ms);
  check(stale === null || stale.signal.dropped, 'duplicate source frame admitted');
  const ambiguous = { ...last, frame_id: last.frame_id + 1, timestamp_ms: last.timestamp_ms + 40,
    tracked_subject_id: 'probe-other-athlete', quality: { ...last.quality, ambiguous_people: true, track_changed: true } };
  const changed = rt.process(ambiguous, ambiguous.timestamp_ms)!;
  check(!changed.quality.ok && !changed.assessment, 'ambiguous subject assessed');
  for (const m of models) {
    const d = await m.detector.observe(ambiguous, changed);
    check(!d || (d.unknown && !d.level), 'identity seam retained recognition');
  }
  const resumed = { ...last, frame_id: last.frame_id + 2, timestamp_ms: last.timestamp_ms + 2000, camera_id: 'probe-new-camera' };
  const gap = rt.process(resumed, resumed.timestamp_ms)!;
  check(gap.signal.time_gap, 'camera interruption failed to reset signal');
  check(currentAssessment(changed.assessment, gap, resumed.timestamp_ms) === null, 'old assessment crossed interruption');
  for (const m of models) {
    const d = await m.detector.observe(resumed, gap);
    if (m.detector.config.input.window_frames > 1) check(!d || (d.unknown && !d.level), 'dynamic history crossed camera interruption');
    m.detector.endSession();
    check(await m.detector.observe(resumed, gap) === null, 'result after session end');
  }
  rt.complete(resumed.timestamp_ms + 1);
  return { source_execution_id: clip.execution_id, stream_id: clip.stream_id, passed: true,
    probes: ['duplicate_frame', 'ambiguous_subject_and_track_change', 'camera_change_and_time_gap', 'session_end'],
    synthetic_faults_only: true, included_in_fitting_or_accuracy: false };
}

export async function main(argv = process.argv.slice(2)) {
  const arg = (name: string, fallback: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
  const out = path.resolve(arg('out', 'data/audit/squash-recorded-replay.json'));
  const measurementsPath = path.resolve(arg('measurements', 'data/audit/squash-runtime-measurements.jsonl'));
  const modelDir = path.resolve(arg('models', 'apps/frontend/public/models/squash'));
  const limit = Number(arg('limit-per-dataset', 'Infinity'));
  if (!(limit > 0) || (Number.isFinite(limit) && !Number.isInteger(limit))) throw new Error('Limit must be a positive integer');
  const datasets = arg('datasets', 'data/squash/dataset_static_pose.json,data/squash/dataset_dynamic_movement.json').split(',').map((p) => path.resolve(p));
  const packDir = path.resolve('sport-packs/squash');
  const bundle = await loadSportPack(await readPackDir(packDir), { platform: 'web', hmac_keys: { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET } });
  const walkTs = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walkTs(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
  const codeFiles = fs.readdirSync('packages', { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(`packages/${e.name}/src`))
    .flatMap((e) => walkTs(`packages/${e.name}/src`)).concat(['tools/replay_squash_brain.ts', 'tools/calibrate_phase_graphs.ts', 'apps/frontend/src/lib/brain/presentation.ts']).sort();
  const packPins = Object.fromEntries(fs.readdirSync(packDir).filter((p) => p.endsWith('.json')).sort().map((p) => [p, hash(fs.readFileSync(path.join(packDir, p)))]));
  const referenceDir = path.join(packDir, 'models/reference');
  const referencePins = Object.fromEntries(fs.readdirSync(referenceDir).filter((p) => p.endsWith('.json')).sort().map((p) => [`models/reference/${p}`, hash(fs.readFileSync(path.join(referenceDir, p)))]));
  const codePins = Object.fromEntries(codeFiles.map((p) => [p, hash(fs.readFileSync(p))]));
  const provenance = { runtime_sha256: hash(JSON.stringify(codePins)),
    config_sha256: hash(JSON.stringify({ pack: bundle.manifest.asset_hashes, strict_rubrics: false, allow_draft_feedback: true })),
    sport_pack_sha256: hash(JSON.stringify(packPins)),
    reference_models_sha256: hash(JSON.stringify(referencePins)),
    pose_pipeline_sha256: hash(datasets.map((p) => JSON.stringify(read(p).view_streams.map((s: any) => ({ extraction: s.extraction, extraction_code_sha256: s.extraction_code_sha256 })))).join('\n')),
    rubric_sha256: hash(fs.readFileSync(path.join(packDir, 'technique_criteria.json'))),
    phase_graphs_sha256: hash(fs.readFileSync(path.join(packDir, 'phase_graphs.json'))),
    tool_sha256: hash(fs.readFileSync(new URL(import.meta.url))) };
  const index = read(path.join(modelDir, 'index.json'));
  const configs = index.map((e: any) => ({ config: read(path.join(modelDir, e.deployment_url)), modelPath: path.join(modelDir, e.model_url),
    deploymentPath: path.join(modelDir, e.deployment_url), deployment_sha256: hash(fs.readFileSync(path.join(modelDir, e.deployment_url))) }));
  const report: any = { schema_version: '1.0.0', status: 'running', purpose: 'recorded_regression_only', created_at: new Date().toISOString(),
    production_eligible: false, coaching_accuracy: null, phase_accuracy: null, independent_recognition_accuracy: null,
    limitations: ['Only existing Data Capture squash poses, encoded landscape, source identity and quality preserved.',
      'No new pose inference or physical camera/device validation; timings are local Node CPU/WASM replay costs.',
      'Training captures are regression inputs, not independent accuracy evidence.',
      'A static image is one instant: frames and hold durations are never fabricated.',
      'Runtime measurements are unreviewed observations, never PASS/IMPROVE fitting labels.'],
    pipeline_provenance: provenance, runtime_source_pins: codePins, datasets: datasets.map((p) => ({ path: p, sha256: hash(fs.readFileSync(p)) })),
    model_index_sha256: hash(fs.readFileSync(path.join(modelDir, 'index.json'))),
    models: configs.map((m: any) => ({ model: m.config.model, task: m.config.model_task, input: m.config.input, calibration_status: m.config.calibration.status, deployment_sha256: m.deployment_sha256 })), modes: {} };
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.mkdirSync(path.dirname(measurementsPath), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(measurementsPath, '', 'utf8');
  try {
  for (const strict of [true, false]) {
    const mode = strict ? 'strict' : 'development', loaded: LoadedMovementModel[] = [];
    const records: Array<Record<string, any>> = [], runtimeMs: number[] = [], recognitionMs: number[] = [];
    let measurementRows = 0;
    let faults: Awaited<ReturnType<typeof boundaryProbes>> | null = null;
    try {
      for (const m of configs) loaded.push(await loadBrowserMovementModel({ config: m.config, model_url: pathToFileURL(m.modelPath).href,
        allow_provisional: !strict, execution_providers: ['wasm'] }, { fetch: async () => new Response(fs.readFileSync(m.modelPath)) }));
      for (const dataset of datasets) for (const { clip, source } of clips(dataset, limit)) {
        const r = await replay(bundle, loaded, clip, strict, records.length);
        records.push({ ...source, ...r.result }); runtimeMs.push(...r.runtimeMs); recognitionMs.push(...r.recognitionMs);
        if (!strict && r.measurements.length) {
          fs.appendFileSync(measurementsPath, r.measurements.map((row) => JSON.stringify({ ...source, ...row,
            measurement: { ...(row.measurement as object), provenance }, pipeline_provenance: provenance })).join('\n') + '\n', 'utf8');
          measurementRows += r.measurements.length;
        }
        if (!strict && !faults && clip.frames.length >= 90) faults = await boundaryProbes(bundle, loaded, clip);
        if (records.length % 50 === 0) console.log(JSON.stringify({ mode, clips: records.length }));
      }
    } finally { for (const m of loaded) await m.close(); }
    const numeric = ['source_frames', 'frames_processed', 'quality_ok', 'ambiguous_frames', 'identity_resets', 'time_gaps', 'assessments', 'inferred_results', 'accepted_movements', 'accepted_groups_or_families', 'completed'];
    const totals = Object.fromEntries(numeric.map((k) => [k, records.reduce((n: number, r: any) => n + r[k], 0)]));
    report.modes[mode] = { clips: records.length, totals, measurement_rows: measurementRows, invariants_passed: true, boundary_probes: faults,
      timings_ms: { runtime_p50: percentile(runtimeMs, .5), runtime_p95: percentile(runtimeMs, .95), recognition_observe_p50: percentile(recognitionMs, .5), recognition_observe_p95: percentile(recognitionMs, .95) }, records };
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ mode, clips: records.length, ...totals, measurementRows }));
  }
  check(codeFiles.every((p) => hash(fs.readFileSync(p)) === codePins[p]), 'runtime source changed during replay');
  check(report.datasets.every((d: { path: string; sha256: string }) => hash(fs.readFileSync(d.path)) === d.sha256), 'source manifest changed during replay');
  check(configs.every((m: any) => hash(fs.readFileSync(m.deploymentPath)) === m.deployment_sha256
    && `sha256:${hash(fs.readFileSync(m.modelPath))}` === m.config.model.digest), 'model deployment changed during replay');
  check(hash(fs.readFileSync(path.join(modelDir, 'index.json'))) === report.model_index_sha256, 'model index changed during replay');
  report.status = 'passed';
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ report: out, measurements: measurementsPath }));
  } catch (error) {
    report.status = 'failed'; report.error = String(error);
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
