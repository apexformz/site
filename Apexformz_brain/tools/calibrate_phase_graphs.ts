/**
 * Explore phase-graph thresholds on training recordings with NO reviewed phase boundaries.
 *
 * Every recorded clip is replayed through the real BrainRuntime with the phase graph of its own labeled movement
 * and with graphs of other templates. These are activation proxies, not phase accuracy or established negatives.
 * For each template a small grid of threshold scale factors is
 * searched for the best separation:
 *
 *     score = completion on own clips - 0.5 x completion on other templates' clips
 *
 * Outputs
 *   --out           calibration report (baseline vs best per template, chosen scale factors)
 *   --prelabels     source-clock phase proposals, including partial/no-detection records, for coaches to correct.
 *                   All rows are unreviewed and cannot be consumed as fitting labels without review.
 *
 *   npx tsx tools/calibrate_phase_graphs.ts --pack squash --dataset data/squash/dataset_dynamic_movement.json \
 *       --out ml/sports/squash/phase_calibration.json --prelabels ml/sports/squash/phase_prelabels.jsonl
 *
 * Only squash Data Capture, encoded landscape, explicitly assigned training captures are accepted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Calibration, PhaseGraph, PoseFrame, SportPackManifest, SportPackBundle, ViewLabel } from '@apexformz/contracts';
import { BrainRuntime } from '@apexformz/runtime';
import { computeAssetHashes, loadSportPack, signManifestHmac, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET } from '@apexformz/sport-runtime';
import { readPackDir } from '@apexformz/sport-runtime/node';

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}

/** Template = recognisable phase structure. */
export function templateOf(g: PhaseGraph): string {
  const ids = new Set(g.phases.map((p) => p.id));
  if (g.kind === 'static_hold') return 'static';
  if (ids.has('swing')) return 'stroke';
  if (ids.has('bottom')) return 'lunge';
  if (ids.has('move')) return 'travel';
  if (ids.has('hop')) return 'split';
  if (ids.has('displaced')) return 'recovery';
  return 'other';
}

/** Scale a graph's condition values: 'scale' multiplies, 'offset' adds (for signed normalized heights). */
export type Adjust = Record<string, { scale?: number; offset?: number }>;
export function adjustGraph(g: PhaseGraph, adj: Adjust): PhaseGraph {
  return {
    ...g,
    phases: g.phases.map((p) => ({
      ...p,
      enter: p.enter.map((c) => {
        const a = adj[c.feature];
        if (!a || typeof c.value !== 'number') return c;
        return { ...c, value: Math.round(((c.value * (a.scale ?? 1)) + (a.offset ?? 0)) * 1e4) / 1e4 };
      }),
    })),
  };
}

const GRIDS: Record<string, Adjust[]> = (() => {
  const g: Record<string, Adjust[]> = {};
  const scales = [0.5, 0.7, 0.85, 1, 1.2, 1.5];
  g.stroke = [];
  for (const v of scales) for (const off of [-0.1, 0, 0.1, 0.2]) g.stroke.push({ dominant_elbow_velocity: { scale: v }, dominant_wrist_rel_y: { offset: off } });
  g.lunge = [];
  for (const off of [-10, -5, 0, 5, 10, 15]) g.lunge.push({ lead_knee_angle: { offset: off } });
  g.travel = [];
  for (const v of scales) g.travel.push({ body_travel: { scale: v } });
  g.recovery = [];
  for (const v of scales) g.recovery.push({ body_travel: { scale: v } });
  g.split = [];
  for (const v of scales) g.split.push({ hip_vertical_velocity: { scale: v }, body_motion: { scale: v } });
  return g;
})();

export interface Clip {
  execution_id: string; stream_id: string; movement_id: string; athlete_id: string; view: ViewLabel; frames: PoseFrame[];
  start_ms: number; end_ms: number; handedness: Calibration['handedness']; athlete_context: NonNullable<Calibration['athlete_context']>;
}

export function loadClips(datasetPath: string, limitPerMovement = Infinity): Clip[] {
  const ds = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  if (ds.sport_pack_id !== 'squash') throw new Error('Only squash Data Capture manifests are supported');
  if (!(limitPerMovement > 0) || (Number.isFinite(limitPerMovement) && !Number.isInteger(limitPerMovement))) throw new Error('limit-per-movement must be a positive integer');
  const assignments = ds.splits?.assignments;
  if (!assignments || typeof assignments !== 'object') throw new Error('Explicit split assignments are required');
  const root = path.dirname(datasetPath);
  const streams = new Map(ds.view_streams.map((v: { view_stream_id: string }) => [v.view_stream_id, v]));
  const cams = new Map(ds.cameras.map((c: { camera_id: string; view: ViewLabel }) => [c.camera_id, c.view]));
  const per = new Map<string, number>();
  const clips: Clip[] = [];
  for (const e of ds.executions) {
    if (!['train', 'val', 'test'].includes(assignments[e.execution_id])) throw new Error(`Missing/invalid split: ${e.execution_id}`);
    if (assignments[e.execution_id] !== 'train') continue;
    if (!Number.isFinite(e.start_ms) || !Number.isFinite(e.end_ms) || e.start_ms < 0 || e.end_ms < e.start_ms) throw new Error(`Invalid execution bounds: ${e.execution_id}`);
    const n = per.get(e.movement_id) ?? 0;
    if (n >= limitPerMovement) continue;
    const athlete = ds.athletes?.find((a: { athlete_id: string }) => a.athlete_id === e.athlete_id);
    for (const streamId of e.view_stream_ids) {
    const st = streams.get(streamId) as { camera_id: string; pose_path: string; pose_sha256?: string; object_uri?: string; extraction?: { orientation_policy?: string }; handedness?: string } | undefined;
    if (!st?.pose_path) throw new Error(`Missing pose stream: ${streamId}`);
    if (!/^s3:\/\/apexformz-datacapture-[^/]+\/raw\/squash\//.test(st.object_uri ?? '')) throw new Error(`Not squash Data Capture: ${streamId}`);
    if (st.extraction?.orientation_policy !== 'encoded') throw new Error(`Expected encoded landscape extraction: ${streamId}`);
    const p = path.join(root, st.pose_path);
    const bytes = fs.readFileSync(p);
    if (st.pose_sha256 && createHash('sha256').update(bytes).digest('hex') !== st.pose_sha256) throw new Error(`Pose checksum mismatch: ${streamId}`);
    const frames = bytes.toString('utf-8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((o) => !('_header' in o) && o.timestamp_ms >= e.start_ms && o.timestamp_ms <= e.end_ms) as PoseFrame[];
    const hand = st.handedness ?? athlete?.handedness;
    clips.push({ execution_id: e.execution_id, stream_id: streamId, movement_id: e.movement_id, athlete_id: e.athlete_id,
      view: (cams.get(st.camera_id) ?? 'unknown') as ViewLabel, frames, start_ms: e.start_ms, end_ms: e.end_ms,
      handedness: hand === 'left' || hand === 'right' ? hand : 'unknown',
      athlete_context: ['novice', 'intermediate', 'advanced'].includes(athlete?.context) ? athlete.context : 'unknown' });
    }
    per.set(e.movement_id, n + 1);
  }
  return clips;
}

/** Phase that shows the template's movement actually happened (recordings often end before the recovery phase). */
export const KEY_PHASE: Record<string, string> = { stroke: 'estimated_contact', lunge: 'bottom', travel: 'move', split: 'hop', recovery: 'recovering' };

export type PhaseBoundary = { phase_id: string; start_ms: number; end_ms: number | null };
export interface ReplayResult {
  completed: boolean; reached: Set<string>; phases: PhaseBoundary[]; states: string[];
  executions: Array<{ completed: boolean; phases: PhaseBoundary[] }>;
}

export function replayCalibration(clip: Clip): Calibration {
  return { full_body_framing: clip.frames[0]?.quality.framing_ok === true, camera_tilt_deg: null,
    nominal_view: clip.view, handedness: clip.handedness, handedness_assumed: clip.handedness === 'unknown',
    floor_orientation_available: false, scale_known: false, scale_marker_m: null, athlete_context: clip.athlete_context };
}

/** Only adapt the replay clock/session. Source quality and tracked identity remain evidence. */
export function replayFrame(frame: PoseFrame, sessionId: string, frameId: number, sourceOffset: number): PoseFrame {
  return { ...frame, session_id: sessionId, frame_id: frameId, timestamp_ms: frame.timestamp_ms - sourceOffset,
    quality: { ...frame.quality, missing_joints: [...frame.quality.missing_joints] } };
}

export function sourcePhases(phases: PhaseBoundary[], sourceOffset: number): PhaseBoundary[] {
  return phases.map((p) => ({ ...p, start_ms: p.start_ms + sourceOffset,
    end_ms: p.end_ms === null ? null : p.end_ms + sourceOffset }));
}

/** Open boundaries and no-detection rows require review; they are not fitting labels. */
export function prelabelRows(clip: Clip, result: ReplayResult) {
  const executions = result.executions.length ? result.executions : [{ completed: false, phases: [] }];
  return executions.map((execution, index) => ({
    execution_id: `${clip.execution_id}/${clip.stream_id}/prelabel-${index + 1}`,
    source_execution_id: clip.execution_id, stream_id: clip.stream_id, movement_id: clip.movement_id,
    athlete_id: clip.athlete_id, view: clip.view, handedness: clip.handedness, athlete_context: clip.athlete_context,
    source: 'phase_graph_training_proxy', source_clock: 'capture_monotonic_ms', split: 'train',
    source_start_ms: clip.start_ms, source_end_ms: clip.end_ms,
    start_ms: execution.phases[0]?.start_ms ?? null, end_ms: execution.phases.at(-1)?.end_ms ?? null,
    review_status: 'unreviewed', annotator_id: null, annotation_version: null, production_eligible: false,
    completed: execution.completed,
    boundary_status: !execution.phases.length ? 'no_phases_detected' : execution.phases.some((p) => p.end_ms === null) ? 'partial_open_boundary' : 'detected_requires_review',
    phases: execution.phases,
  }));
}

function replay(bundle: SportPackBundle, movementId: string, clip: Clip, seq: number): ReplayResult {
  // One runtime per session (the session state machine ends in LOCAL_COMMITTED); the verified bundle is reused.
  const rt = new BrainRuntime({ strict_rubrics: false, allow_draft_feedback: false, hmac_keys: { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET } });
  rt.installBundle(bundle);
  rt.activatePack(bundle.manifest.id, bundle.manifest.version);
  const cal = replayCalibration(clip);
  const sid = `cal-${seq}`;
  rt.calibrate(cal, 0);
  rt.start({ session_id: sid, athlete_id: clip.athlete_id, sport_pack_id: bundle.manifest.id, sport_pack_version: bundle.manifest.version, movement_id: movementId, calibration: cal, pinned_models: [] }, 0);
  let completed = false;
  const reached = new Set<string>();
  let phases: ReplayResult['phases'] = [];
  const executions = new Map<string, ReplayResult['executions'][number]>();
  const states = new Set<string>();
  const sourceOffset = (clip.frames[0]?.timestamp_ms ?? clip.start_ms) - 1;
  clip.frames.forEach((f, i) => {
    const frame = replayFrame(f, sid, i, sourceOffset);
    const tick = rt.process(frame, frame.timestamp_ms);
    const u = tick?.temporal;
    if (u) {
      states.add(u.state);
      if (u.phase_id && (u.state === 'EXECUTING' || u.state === 'CONFIRMED')) reached.add(u.phase_id);
      if (u.execution_phases?.length) {
        phases = sourcePhases(u.execution_phases.map((p) => ({ phase_id: p.phase_id, start_ms: p.start_ms, end_ms: p.end_ms })), sourceOffset);
        const key = u.execution_id ?? `start-${phases[0].start_ms}`;
        executions.set(key, { completed: u.completed || executions.get(key)?.completed === true, phases });
      }
      if (u.completed) completed = true;
    }
  });
  // Closing the runtime must not fabricate a final source phase boundary.
  rt.complete((clip.frames.at(-1)?.timestamp_ms ?? clip.start_ms) - sourceOffset + 1);
  return { completed, reached, phases, states: [...states], executions: [...executions.values()] };
}

async function bundleWith(packDir: string, graphs: PhaseGraph[]) {
  const input = await readPackDir(packDir);
  const manifest = { ...(input.manifest as SportPackManifest) };
  const assets = { ...input.assets };
  const pg = JSON.parse(assets[manifest.phase_graphs]);
  pg.graphs = graphs;
  assets[manifest.phase_graphs] = JSON.stringify(pg);
  manifest.asset_hashes = await computeAssetHashes(assets);
  return { manifest: await signManifestHmac(manifest, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET), assets };
}

async function main() {
  if (arg('pack', 'squash') !== 'squash') throw new Error('Only the squash pack is supported');
  const packDir = path.resolve('sport-packs', 'squash');
  const datasetPath = arg('dataset');
  const clips = loadClips(datasetPath, Number(arg('limit-per-movement', 'Infinity')));
  const base = await readPackDir(packDir);
  const baseGraphs = (JSON.parse(base.assets[(base.manifest as SportPackManifest).phase_graphs]).graphs as PhaseGraph[]);
  const graphOf = new Map(baseGraphs.map((g) => [g.movement_id, g]));
  const templateOfMovement = new Map(baseGraphs.map((g) => [g.movement_id, templateOf(g)]));
  const templates = [...new Set([...templateOfMovement.values()].filter((t) => GRIDS[t]))];
  // One representative movement per template to replay foreign clips against (specificity probe).
  const representative = new Map<string, string>();
  for (const [mid, t] of templateOfMovement) if (!representative.has(t)) representative.set(t, mid);
  const usable = clips.filter((c) => graphOf.has(c.movement_id));
  console.log(JSON.stringify({ clips: usable.length, templates }));

  let seq = 0;
  const evaluate = async (template: string, adj: Adjust) => {
    const graphs = baseGraphs.map((g) => (templateOf(g) === template ? adjustGraph(g, adj) : g));
    const rt = await loadSportPack(await bundleWith(packDir, graphs), { platform: 'web', hmac_keys: { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET } });
    let own = 0, ownN = 0, foreign = 0, foreignN = 0, ownComplete = 0;
    const key = KEY_PHASE[template];
    const results: Array<{ clip: Clip; r: ReplayResult }> = [];
    for (const clip of usable) {
      const t = templateOfMovement.get(clip.movement_id)!;
      if (t === template) {
        const r = replay(rt, clip.movement_id, clip, seq++);
        ownN++; if (r.reached.has(key) || r.completed) own++; if (r.completed) ownComplete++;
        results.push({ clip, r });
      } else if (GRIDS[t]) {
        // a foreign clip replayed against this template's representative graph
        const r = replay(rt, representative.get(template)!, clip, seq++);
        foreignN++; if (r.reached.has(key) || r.completed) foreign++;
      }
    }
    const sens = ownN ? own / ownN : 0;
    const fpr = foreignN ? foreign / foreignN : 0;
    return { adj, sensitivity: sens, foreign_completion: fpr, full_completion: ownN ? ownComplete / ownN : 0, score: sens - 0.5 * fpr, n_own: ownN, n_foreign: foreignN, results };
  };

  const report: Record<string, unknown> = {
    status: 'provisional_training_proxy', production_eligible: false, evaluation_split: 'train',
    phase_accuracy: null, phase_boundary_error_ms: null,
    method: "key phase reached on own training clips - 0.5 x key phase reached on other templates' training clips",
    key_phases: KEY_PHASE, source_quality: 'preserved_including_identity_flags_and_tracked_subject_id',
    dataset: { path: datasetPath, sha256: createHash('sha256').update(fs.readFileSync(datasetPath)).digest('hex') },
    limitations: ['No reviewed phase boundaries are used; activation is not phase accuracy.',
      'Threshold selection and reported activation use the same training captures; no independent validation.',
      'Other-template captures are proxy negatives, not reviewed negative phase examples.',
      'Streams from the same execution are correlated; clip counts are not independent executions.'],
    clips: usable.length, executions: new Set(usable.map((c) => c.execution_id)).size,
    omitted_no_graph: clips.filter((c) => !graphOf.has(c.movement_id)).map((c) => ({ execution_id: c.execution_id, stream_id: c.stream_id })),
    omitted_unsupported_template: usable.filter((c) => !GRIDS[templateOfMovement.get(c.movement_id)!]).map((c) => ({ execution_id: c.execution_id, stream_id: c.stream_id })),
    templates: {},
  };
  const chosen: Record<string, Adjust> = {};
  const prelabelSource: Array<{ clip: Clip; r: ReplayResult }> = [];
  for (const t of templates) {
    const baseline = await evaluate(t, {});
    let best = baseline;
    for (const adj of GRIDS[t]) {
      const res = await evaluate(t, adj);
      if (res.score > best.score + 1e-9) best = res;
    }
    chosen[t] = best.adj;
    prelabelSource.push(...best.results);
    (report.templates as Record<string, unknown>)[t] = {
      baseline: { sensitivity: baseline.sensitivity, foreign_activation: baseline.foreign_completion, full_completion: baseline.full_completion, score: baseline.score },
      best: { adjust: best.adj, sensitivity: best.sensitivity, foreign_activation: best.foreign_completion, full_completion: best.full_completion, score: best.score },
      n_own_clips: best.n_own, n_foreign_clips: best.n_foreign,
    };
    console.log(JSON.stringify({ template: t, baseline: { s: baseline.sensitivity.toFixed(3), f: baseline.foreign_completion.toFixed(3) }, best: { adj: best.adj, s: best.sensitivity.toFixed(3), f: best.foreign_completion.toFixed(3) } }));
  }
  report.chosen_adjustments = chosen;
  fs.writeFileSync(arg('out'), JSON.stringify(report, null, 1) + '\n', 'utf-8');
  const lines = prelabelSource.flatMap(({ clip, r }) => prelabelRows(clip, r).map((row) => JSON.stringify(row)));
  fs.writeFileSync(arg('prelabels'), lines.join('\n') + '\n', 'utf-8');
  console.log(JSON.stringify({ report: arg('out'), prelabels: arg('prelabels'), prelabeled_clips: lines.length }));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('tools', 'calibrate_phase_graphs.ts'));
if (invoked) main().catch((e) => { console.error(e); process.exit(1); });
