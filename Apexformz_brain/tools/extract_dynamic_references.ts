/** Build provisional, source-bound dynamic geometry from the existing capture collection. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FeatureSpec, Handedness, PoseFrame, ViewLabel } from '@apexformz/contracts';
import { validateDynamicReferenceModel, type DynamicReferenceFeature, type DynamicReferenceModel, type DynamicReferenceSample, type DynamicReferenceSequence } from '../packages/contracts/src/dynamic_reference';
import { SignalPipeline } from '@apexformz/signal';
import { FeatureEngine } from '@apexformz/features';
import { recordedBodyOrientationIssue, rotateRecordedPose180, sourceOrientationReview, type SourceOrientationReview } from './dynamic_reference_orientation';

const prefix = 'dynamic_ref_';
const definitions: Array<{ spec: FeatureSpec; feature: DynamicReferenceFeature }> = [];
function add(name: string, kind: FeatureSpec['kind'], params: FeatureSpec['params'], body: string[], tolerance: number, unit: DynamicReferenceFeature['unit'], weight = 1, extra: Partial<DynamicReferenceFeature> = {}, coordinate_system: FeatureSpec['coordinate_system'] = 'body_relative') {
  const id = prefix + name;
  definitions.push({ spec: { id, kind, params, coordinate_system, version: '1.0.0', view_applicability: 'any', unit: coordinate_system === 'image_pixel' ? 'px' : unit }, feature: { id, unit, tolerance, weight, body_joints: body, ...extra } });
}
for (const side of ['left', 'right']) {
  const knee = [`${side}_hip`, `${side}_knee`, `${side}_ankle`];
  add(`${side}_knee_angle`, 'angle_at', { a: knee[0], b: knee[1], c: knee[2], dims: '2d' }, knee, 18, 'deg');
  const hip = [`${side}_shoulder`, `${side}_hip`, `${side}_knee`];
  add(`${side}_hip_angle`, 'angle_at', { a: hip[0], b: hip[1], c: hip[2], dims: '2d' }, hip, 18, 'deg');
}
for (const side of ['dominant', 'nondominant']) {
  const elbow = [`${side}_shoulder`, `${side}_elbow`, `${side}_wrist`];
  add(`${side}_elbow_angle`, 'angle_at', { a: elbow[0], b: elbow[1], c: elbow[2], dims: '2d' }, elbow, 20, 'deg');
  const arm = [`${side}_hip`, `${side}_shoulder`, `${side}_elbow`];
  add(`${side}_arm_elevation`, 'angle_at', { a: arm[0], b: arm[1], c: arm[2], dims: '2d' }, arm, 20, 'deg');
  for (const axis of ['x', 'y']) add(`${side}_wrist_${axis}`, 'landmark_offset', { a: `${side}_wrist`, b: `${side}_shoulder`, axis }, elbow, 0.3, 'normalized');
}
add('trunk_lean', 'line_inclination', { from: ['left_hip', 'right_hip'], to: ['left_shoulder', 'right_shoulder'], reference: 'vertical' }, ['left_hip', 'right_hip', 'left_shoulder', 'right_shoulder'], 12, 'deg');
for (const side of ['left', 'right']) for (const axis of ['x', 'y']) add(`${side}_ankle_${axis}`, 'landmark_offset', { a: `${side}_ankle`, b: `${side}_hip`, axis }, [`${side}_hip`, `${side}_knee`, `${side}_ankle`], 0.3, 'normalized', 0.8);
for (const axis of ['x', 'y']) add(`head_${axis}`, 'landmark_coordinate', { landmark: 'nose', axis }, ['nose', 'left_shoulder', 'right_shoulder'], 0.2, 'normalized', 0.5);
for (const axis of ['x', 'y']) add(`root_${axis}`, 'center_of_keypoints', { landmarks: ['left_hip', 'right_hip'], axis }, ['left_hip', 'right_hip', 'left_knee', 'right_knee'], 0.45, 'normalized', 0.6,
  { relative_to_start: true, scale_feature_id: prefix + 'torso_scale' }, 'image_pixel');
add('torso_scale', 'landmark_offset', { a: 'left_shoulder', b: 'left_hip', axis: 'y' }, [], 10, 'px', 0, {}, 'image_pixel');

export const DYNAMIC_REFERENCE_FEATURE_SPECS = definitions.map(d => d.spec);
export const DYNAMIC_REFERENCE_FEATURES = definitions.map(d => d.feature);
export const DYNAMIC_REFERENCE_EXTRACTION_VERSION = 'dynamic-reference-geometry-2-orientation';

interface TimedValues extends DynamicReferenceSample { source_ms: number; frame_id: number }
export interface ExtractedDynamicSegment { start_ms: number; end_ms: number; duration_ms: number; samples: DynamicReferenceSample[]; complete_capture: boolean }
export interface ExtractionResult { segments: ExtractedDynamicSegment[]; rejected_frames: Record<string, number>; input_frames: number; valid_frames: number; reason: string | null }

function normalizedValue(rows: TimedValues[], row: TimedValues, i: number): number | null {
  const feature = DYNAMIC_REFERENCE_FEATURES[i];
  const value = row.values[i];
  if (value === null) return null;
  if (!feature.relative_to_start) return value;
  const origin = rows[0].values[i];
  const scaleIndex = DYNAMIC_REFERENCE_FEATURES.findIndex(f => f.id === feature.scale_feature_id);
  const scale = scaleIndex < 0 ? 1 : rows[0].values[scaleIndex];
  return origin !== null && scale !== null && Math.abs(scale) >= 1 ? (value - origin) / Math.abs(scale) : null;
}

/** Trim observed still margins; this proposes geometry boundaries, never named/reviewed stroke phases. */
export function trimDynamicMotion(rows: TimedValues[]): TimedValues[] {
  if (rows.length < 5) return [];
  const activity: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    let previous = i - 1;
    while (previous > 0 && rows[i].source_ms - rows[previous].source_ms < 180) previous--;
    if (rows[i].source_ms - rows[previous].source_ms < 100) continue;
    const changes = DYNAMIC_REFERENCE_FEATURES.flatMap((f, j) => {
      if (f.weight <= 0) return [];
      const a = normalizedValue(rows, rows[i], j), b = normalizedValue(rows, rows[previous], j);
      return a === null || b === null ? [] : [Math.abs(a - b) / f.tolerance];
    }).sort((a, b) => b - a);
    // Several independently measured components must move; one noisy joint is insufficient.
    if (changes.length >= 6 && changes.slice(0, 4).reduce((a, b) => a + b, 0) / 4 >= 0.24) activity.push(i);
  }
  if (activity.length < 3) return [];
  const from = rows[activity[0]].source_ms - 300;
  const to = rows[activity.at(-1)!].source_ms + 300;
  const trimmed = rows.filter(r => r.source_ms >= from && r.source_ms <= to);
  if (trimmed.length < 8 || trimmed.at(-1)!.source_ms - trimmed[0].source_ms < 400) return [];
  const excursions = DYNAMIC_REFERENCE_FEATURES.flatMap((f, i) => {
    if (f.weight <= 0) return [];
    const v = trimmed.map(r => normalizedValue(trimmed, r, i)).filter((v): v is number => v !== null).sort((a, b) => a - b);
    return v.length >= 5 ? [(v[Math.floor((v.length - 1) * 0.95)] - v[Math.floor((v.length - 1) * 0.05)]) / f.tolerance] : [];
  });
  return excursions.filter(v => v >= 0.6).length >= 2 && Math.max(...excursions) >= 1 ? trimmed : [];
}

/** Independent contiguous segments; poor quality, identity changes and timing gaps always break history. */
export function extractDynamicCapture(frames: PoseFrame[], view: ViewLabel, handedness: Handedness): ExtractionResult {
  const rejected: Record<string, number> = {};
  const fail = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  if (view === 'unknown' || handedness === 'unknown') return { segments: [], rejected_frames: {}, input_frames: frames.length, valid_frames: 0, reason: view === 'unknown' ? 'VIEW_UNKNOWN' : 'HANDEDNESS_UNKNOWN' };
  const signal = new SignalPipeline({ view, allow_short_gap_prediction: false });
  const engine = new FeatureEngine(DYNAMIC_REFERENCE_FEATURE_SPECS);
  const runs: TimedValues[][] = [];
  let current: TimedValues[] = [];
  let valid = 0;
  let broken = false;
  const flush = () => { if (current.length) runs.push(current); current = []; signal.reset(); engine.reset(); };
  for (const frame of frames) {
    const q = frame.quality;
    // The imported stream already identifies the selected athlete. Other visible
    // people are not ambiguous when that identity has been resolved, matching live gating.
    const reason = !q || q.ambiguous_people ? 'AMBIGUOUS_PEOPLE' : q.track_changed ? 'TRACK_CHANGED'
      : !Array.isArray(q.missing_joints) ? 'MISSING_QUALITY_METADATA' : null;
    if (reason) { fail(reason); broken = true; flush(); continue; }
    const orientationIssue = recordedBodyOrientationIssue(frame);
    if (orientationIssue) { fail(orientationIssue); broken = true; flush(); continue; }
    // Keep the camera clock and reliable body parts when a local joint is absent.
    // Explicitly mask missing/out-of-image evidence; never interpolate or trust
    // a model extrapolation beyond the image. An unexplained framing failure is
    // still rejected, since we cannot identify the affected observations.
    const masked = new Set(q.missing_joints);
    for (const lm of frame.normalized_landmarks) if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y) || lm.x < .02 || lm.x > .98 || lm.y < .02 || lm.y > .98 || (lm.visibility ?? lm.presence ?? 1) < .5) masked.add(lm.id);
    if (!q.framing_ok && !masked.size) { fail('FRAMING_INVALID'); broken = true; flush(); continue; }
    if (!q.framing_ok || q.missing_joints.length) { fail(!q.framing_ok ? 'FRAMING_PARTIAL_MASKED' : 'MISSING_JOINT_MASKED'); broken = true; }
    const measured = masked.size ? { ...frame, normalized_landmarks: frame.normalized_landmarks.map(lm => masked.has(lm.id) ? { ...lm, visibility: 0, presence: 0 } : lm) } : frame;
    const output = signal.process(measured);
    if (output.dropped) { fail(output.drop_reason!); broken = true; flush(); continue; }
    if (output.time_gap || output.track_changed) { fail(output.time_gap ? 'TIME_GAP' : 'TRACK_CHANGED'); broken = true; flush(); signal.process(measured); }
    if (!output.frame?.normalization_valid) { fail('NORMALIZATION_INVALID'); broken = true; flush(); continue; }
    const computed = engine.compute(signal.window, { view, handedness, handedness_assumed: false });
    const values = DYNAMIC_REFERENCE_FEATURES.map(f => {
      const v = computed.get(f.id);
      return v?.valid && v.value !== null && Number.isFinite(v.value) && (v.confidence ?? 0) >= 0.5 ? Math.round(v.value * 10000) / 10000 : null;
    });
    // Use the same weighted coverage floor as the live comparator. Otherwise a
    // stored reference could include observations that live scoring must drop.
    const reliable = DYNAMIC_REFERENCE_FEATURES.reduce((n, f, i) => n + (values[i] !== null ? f.weight : 0), 0);
    const possible = DYNAMIC_REFERENCE_FEATURES.reduce((n, f) => n + f.weight, 0);
    if (reliable / possible < .65) { fail('INSUFFICIENT_FEATURE_COVERAGE'); broken = true; flush(); continue; }
    current.push({ source_ms: frame.timestamp_ms, t_ms: frame.timestamp_ms, frame_id: frame.frame_id, values });
    valid++;
  }
  flush();
  const segments = runs.flatMap(run => {
    const motion = trimDynamicMotion(run);
    if (!motion.length) return [];
    // A long capture can contain several repetitions. Preserve a bounded segment and disclose truncation.
    const bounded = motion.filter(r => r.source_ms <= motion[0].source_ms + 25000);
    const start = bounded[0].source_ms, end = bounded.at(-1)!.source_ms;
    const selected: TimedValues[] = [];
    const interval = Math.max(80, (end - start) / 119);
    for (const row of bounded) if (!selected.length || row.source_ms - selected.at(-1)!.source_ms >= interval) selected.push(row);
    if (selected.at(-1) !== bounded.at(-1)) selected.push(bounded.at(-1)!);
    if (selected.length < 5) return [];
    return [{ start_ms: start, end_ms: end, duration_ms: end - start, samples: selected.map(row => ({ t_ms: row.source_ms - start, values: row.values })), complete_capture: !broken && runs.length === 1 && bounded.length === motion.length }];
  });
  return { segments, rejected_frames: rejected, input_frames: frames.length, valid_frames: valid, reason: segments.length ? null : valid ? 'NO_RELIABLE_DYNAMIC_INTERVAL' : 'NO_RELIABLE_POSE_INTERVAL' };
}

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
interface Dataset {
  executions: Array<{ execution_id: string; athlete_id: string; movement_id: string; view_stream_ids: string[] }>;
  view_streams: Array<{ view_stream_id: string; camera_id: string; pose_path?: string; pose_sha256?: string; sha256?: string; handedness?: Handedness }>;
  cameras: Array<{ camera_id: string; view: ViewLabel }>;
  athletes: Array<{ athlete_id: string; handedness?: Handedness }>;
}

function main() {
  const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
  const datasetPath = arg('dataset', 'data/squash/dataset_dynamic_movement.json');
  const outputDir = arg('out', 'sport-packs/squash/models/dynamic-reference');
  const reportPath = arg('report', 'data/audit/dynamic-reference/coverage.json');
  const catalog = JSON.parse(fs.readFileSync(arg('catalog', 'sport-packs/squash/movement_catalog.json'), 'utf8')) as { movements: Array<{ id: string; type: string; canonical_name: string; permitted_views: ViewLabel[] }> };
  const bytes = fs.readFileSync(datasetPath);
  const ds = JSON.parse(bytes.toString()) as Dataset;
  const datasetSha = sha(bytes), root = path.dirname(datasetPath);
  const orientationBytes = fs.readFileSync(arg('orientation-review', 'data/squash/dynamic_reference_orientation_review.json'));
  const orientationReview = JSON.parse(orientationBytes.toString()) as { sources: SourceOrientationReview[] };
  const orientationSha = sha(orientationBytes);
  const streams = new Map(ds.view_streams.map(s => [s.view_stream_id, s]));
  const cameras = new Map(ds.cameras.map(s => [s.camera_id, s]));
  const athletes = new Map(ds.athletes.map(s => [s.athlete_id, s]));
  const references = new Map<string, DynamicReferenceSequence[]>();
  const captures: Array<Record<string, unknown>> = [];
  for (const execution of ds.executions) for (const streamId of execution.view_stream_ids) {
    const stream = streams.get(streamId), view = stream ? cameras.get(stream.camera_id)?.view ?? 'unknown' : 'unknown';
    const hands = [...new Set([stream?.handedness, athletes.get(execution.athlete_id)?.handedness].filter(x => x === 'left' || x === 'right'))];
    const hand = hands.length === 1 ? hands[0]! : 'unknown';
    const posePath = stream?.pose_path ? path.join(root, stream.pose_path) : null;
    const record: Record<string, unknown> = { movement_id: execution.movement_id, execution_id: execution.execution_id, stream_id: streamId, view, handedness: hand, pose_path: stream?.pose_path };
    if (!stream || !posePath || !fs.existsSync(posePath)) { captures.push({ ...record, reason: 'POSE_FILE_MISSING', references: 0 }); continue; }
    const poseBytes = fs.readFileSync(posePath), poseSha = sha(poseBytes);
    if (poseSha !== stream.pose_sha256 || !stream.sha256?.match(/^[a-f0-9]{64}$/)) throw new Error(`Source hash mismatch or missing media provenance: ${streamId}`);
    const frames = poseBytes.toString().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).filter(o => !('_header' in o)) as PoseFrame[];
    const review = sourceOrientationReview({ stream_id: streamId, source_pose_sha256: poseSha, source_media_sha256: stream.sha256 }, orientationReview.sources);
    const transform: DynamicReferenceSequence['recorded_source_transform'] = { rotation_degrees: review?.rotation_degrees ?? 0, anatomical_labels_preserved: true, ...(review ? { review_evidence_sha256: review.review_evidence_sha256 } : {}) };
    const canonical = transform.rotation_degrees === 180 ? frames.map(rotateRecordedPose180) : frames;
    const result = extractDynamicCapture(canonical, view, hand);
    const items = result.segments.map((segment, i): DynamicReferenceSequence => ({
      id: `${streamId}:segment-${i}`, view, handedness: hand, source_execution_id: execution.execution_id,
      source_pose_sha256: poseSha, source_media_sha256: stream.sha256!, recorded_source_transform: transform, boundary_method: 'observed_motion', ...segment,
    }));
    references.set(execution.movement_id, [...(references.get(execution.movement_id) ?? []), ...items]);
    captures.push({ ...record, source_pose_sha256: poseSha, source_media_sha256: stream.sha256, recorded_source_transform: transform, ...result, segments: undefined, references: items.length, complete_capture_references: items.filter(r => r.complete_capture).length });
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const movements = catalog.movements.filter(m => m.type === 'dynamic').map(m => {
    const source = captures.filter(c => c.movement_id === m.id);
    // Bound per-view candidate count; prefer complete captures then longest observed segments. Never concatenate.
    const all = references.get(m.id) ?? [];
    const selected = m.permitted_views.flatMap(view => all.filter(r => r.view === view).sort((a, b) => Number(b.complete_capture) - Number(a.complete_capture) || b.duration_ms - a.duration_ms).slice(0, 8));
    const model: DynamicReferenceModel = {
      kind: 'dynamic_reference', schema_version: '1.0.0', movement_id: m.id, validation_status: 'provisional',
      feature_specs: DYNAMIC_REFERENCE_FEATURE_SPECS, features: DYNAMIC_REFERENCE_FEATURES, references: selected,
      unsupported_reasons: source.length === 0 ? ['NO_SOURCE_CAPTURE'] : selected.length === 0 ? ['NO_RELIABLE_DYNAMIC_REFERENCE'] : [],
      provenance: { dataset_sha256: datasetSha, extraction_version: DYNAMIC_REFERENCE_EXTRACTION_VERSION, orientation_review_sha256: orientationSha, phase_labels_reviewed: false, tolerances_reviewed: false,
        tolerance_method: 'Conservative engineering allowances (12–20 degrees, 0.2–0.3 torso lengths); not fitted or coach-approved technique boundaries.',
        notes: ['References are contiguous observed geometry from source-labelled demonstrations of one athlete.', 'Motion endpoints are automatic and unreviewed. Partial intervals never establish a completed repetition.', 'Views and handedness must match exactly; source views are not synchronized.', 'Root travel uses initial image-plane torso-height scaling; it is not calibrated court distance or ball contact.', 'Pose file digests are rechecked; media digests are inherited from the verified capture manifest.', 'Five visually confirmed inverted encoded sources are rotated180 degrees using a SHA-bound review; anatomical IDs and original files remain unchanged. Residual inverted pose observations break the trajectory; they are never flipped frame by frame.'] },
    };
    validateDynamicReferenceModel(model);
    const file = path.join(outputDir, `${m.id}.json`);
    fs.writeFileSync(file, JSON.stringify(model) + '\n');
    return { movement_id: m.id, name: m.canonical_name, source_captures: source.length, references: selected.length, complete_capture_references: selected.filter(r => r.complete_capture).length,
      supported_views: [...new Set(selected.map(r => r.view))], missing_views: m.permitted_views.filter(v => !selected.some(r => r.view === v)),
      unsupported_reasons: model.unsupported_reasons, artifact: file.replaceAll('\\', '/'), sha256: sha(fs.readFileSync(file)) };
  });
  const report = { schema_version: '1.0.0', created_at: new Date().toISOString(), dataset_sha256: datasetSha, extraction_version: DYNAMIC_REFERENCE_EXTRACTION_VERSION,
    status: 'provisional_reference_geometry', source_captures: captures.length, source_athletes: ds.athletes.length, catalogue_dynamic_movements: movements.length,
    movements_with_references: movements.filter(m => m.references).length, movements_with_complete_capture_references: movements.filter(m => m.complete_capture_references).length,
    reference_sequences: movements.reduce((n, m) => n + m.references, 0), features: DYNAMIC_REFERENCE_FEATURES, movements, captures };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ catalogue_dynamic_movements: movements.length, movements_with_references: report.movements_with_references, movements_with_complete_capture_references: report.movements_with_complete_capture_references, references: report.reference_sequences, report: reportPath }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
