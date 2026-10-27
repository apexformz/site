/** Extract provisional static references using the deployed feature engine. No source handedness is inferred. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeatureSpec, Handedness, PoseFrame, ViewLabel } from '@apexformz/contracts';
import { SignalPipeline } from '@apexformz/signal';
import { FeatureEngine } from '@apexformz/features';

export interface ReferenceHandedness {
  handedness: Handedness;
  handedness_assumed: boolean;
  handedness_source: 'dataset' | 'unknown' | 'cli_assumption' | 'conflicting_dataset';
}

/** An explicit CLI assumption is useful for diagnostics, but cannot become verified source evidence. */
export function resolveReferenceHandedness(recorded: unknown[], override?: string): ReferenceHandedness {
  if (override !== undefined) {
    if (!['right', 'left', 'unknown'].includes(override)) throw new Error('handedness must be right, left or unknown');
    return { handedness: override as Handedness, handedness_assumed: true, handedness_source: 'cli_assumption' };
  }
  const known = [...new Set(recorded.filter((v): v is 'left' | 'right' => v === 'left' || v === 'right'))];
  return {
    handedness: known.length === 1 ? known[0] : 'unknown',
    handedness_assumed: false,
    handedness_source: known.length === 1 ? 'dataset' : known.length > 1 ? 'conflicting_dataset' : 'unknown',
  };
}

export function extractReferenceCapture(frames: PoseFrame[], specs: FeatureSpec[], referenceFeatures: string[], view: ViewLabel, hand: ReferenceHandedness) {
  const signal = new SignalPipeline({ view });
  const engine = new FeatureEngine(specs);
  let values: Array<number | null> | null = null;
  const rejectedFrames: Record<string, number> = {};
  for (const frame of frames) {
    // The signal layer does not enforce global capture quality: apply the live quality contract before features.
    const q = frame.quality;
    const reason = !q || q.framing_ok !== true ? 'FRAMING_INVALID'
      : q.ambiguous_people || (q.person_count !== undefined && q.person_count !== 1) ? 'AMBIGUOUS_PEOPLE'
      : q.track_changed ? 'TRACK_CHANGED'
      : !Array.isArray(q.missing_joints) || q.missing_joints.length ? 'MISSING_JOINT' : null;
    if (reason) {
      rejectedFrames[reason] = (rejectedFrames[reason] ?? 0) + 1;
      values = null;
      signal.reset();
      engine.reset();
      continue;
    }
    const result = signal.process(frame);
    if (result.dropped || !result.frame || !result.frame.normalization_valid) {
      const invalid = result.drop_reason ?? result.frame?.normalization_reason ?? 'NORMALIZATION_INVALID';
      rejectedFrames[invalid] = (rejectedFrames[invalid] ?? 0) + 1;
      values = null;
      continue;
    }
    const computed = engine.compute(signal.window, { view, ...hand });
    values = referenceFeatures.map((id) => {
      const f = computed.get(id);
      return f?.valid && f.value !== null && Number.isFinite(f.value) ? Math.round(f.value * 10) / 10 : null;
    });
  }
  if (values && values.filter((v) => v !== null).length < Math.ceil(values.length / 2)) values = null;
  return { values, rejected_frames: rejectedFrames };
}

interface Dataset {
  executions: Array<{ execution_id: string; athlete_id?: string; movement_id: string; view_stream_ids: string[] }>;
  view_streams: Array<{ view_stream_id: string; camera_id: string; pose_path?: string; handedness?: Handedness }>;
  cameras: Array<{ camera_id: string; view: ViewLabel }>;
  athletes?: Array<{ athlete_id: string; handedness?: Handedness }>;
}

function main() {
  const arg = (name: string, optional = false) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    if (optional) return undefined;
    throw new Error(`missing --${name}`);
  };
  const specs = JSON.parse(fs.readFileSync(arg('specs')!, 'utf-8')) as { features: FeatureSpec[]; reference_features: string[] };
  const datasetPath = arg('dataset')!;
  const ds = JSON.parse(fs.readFileSync(datasetPath, 'utf-8')) as Dataset;
  const root = path.dirname(datasetPath);
  const streams = new Map(ds.view_streams.map((v) => [v.view_stream_id, v]));
  const cams = new Map(ds.cameras.map((c) => [c.camera_id, c]));
  const athletes = new Map((ds.athletes ?? []).map((a) => [a.athlete_id, a]));
  const vectors: Record<string, Array<ReferenceHandedness & { view: ViewLabel; execution_id: string; values: Array<number | null> }>> = {};
  const rejectedFrames: Record<string, number> = {};
  let used = 0;
  let skipped = 0;
  for (const execution of ds.executions) {
    for (const streamId of execution.view_stream_ids) {
      const stream = streams.get(streamId);
      const view = stream ? cams.get(stream.camera_id)?.view ?? 'unknown' : 'unknown';
      const posePath = stream?.pose_path ? path.join(root, stream.pose_path) : null;
      if (view === 'unknown' || !posePath || !fs.existsSync(posePath)) { skipped++; continue; }
      const frames = fs.readFileSync(posePath, 'utf-8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((o) => !('_header' in o)) as PoseFrame[];
      const hand = resolveReferenceHandedness([stream?.handedness, athletes.get(execution.athlete_id ?? '')?.handedness], arg('handedness', true));
      const result = extractReferenceCapture(frames, specs.features, specs.reference_features, view, hand);
      for (const [reason, count] of Object.entries(result.rejected_frames)) rejectedFrames[reason] = (rejectedFrames[reason] ?? 0) + count;
      if (!result.values) { skipped++; continue; }
      (vectors[execution.movement_id] ??= []).push({ view, execution_id: execution.execution_id, ...hand, values: result.values });
      used++;
    }
  }
  const hands = [...new Set(Object.values(vectors).flat().map((v) => v.handedness))];
  const out = { schema_version: '1.1.0', features: specs.reference_features, handedness: hands.length === 1 ? hands[0] : 'unknown', dataset: path.basename(datasetPath), captures_used: used, captures_skipped: skipped, rejected_frames: rejectedFrames, vectors };
  fs.writeFileSync(arg('out')!, JSON.stringify(out, null, 1) + '\n', 'utf-8');
  console.log(JSON.stringify({ movements: Object.keys(vectors).length, captures_used: used, captures_skipped: skipped, rejected_frames: rejectedFrames, out: arg('out') }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
