/** Local adapter replay through BrainRuntime. Measurements are evidence, never technique labels. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertValid, CAPABILITIES, type Calibration, type Capability, type ContactMeasurementEvidence, type PoseFrame, type TrackSet } from '@apexformz/contracts';
import { BrainRuntime, calibrateCourt, courtFootprintMeasurements, mergeEquipmentFrames, TrackSetEquipmentAdapter, type CourtCalibrationInput, type EquipmentCameraContext, type GroundFootprintObservation, type TrackMeasurementBinding } from '@apexformz/runtime';
import { DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET } from '@apexformz/sport-runtime';
import { readPackDir } from '@apexformz/sport-runtime/node';

export interface TrackAlignment {
  mapping_id: string;
  reason: string;
  source_session_id: string | null;
  target_session_id: string;
  frame_id_offset: number;
  timestamp_offset_ms: number;
}
export interface EquipmentReplayConfig {
  movement_id: string;
  calibration: Calibration;
  capabilities_available: Capability[];
  /** Defaults to false. Does not approve source measurements or rubric thresholds. */
  allow_provisional?: boolean;
  tracking?: { path: string; bindings: TrackMeasurementBinding[]; alignment?: TrackAlignment };
  contacts_path?: string;
  court?: { calibration_path: string; observations_path: string };
}
export interface EquipmentReplayOptions { pose: string; pack: string; config: string; out: string }
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const readJSON = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readLines = (file: string): any[] => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line, i) => {
  try { return JSON.parse(line); } catch { throw new Error(`Invalid JSON at ${file}:${i + 1}`); }
});

/** Explicit offsets only: never infer timestamps from FPS or create a contact event. */
export function alignEquipmentTracks(source: TrackSet, mapping: TrackAlignment, target: string): TrackSet {
  if (!mapping.mapping_id || !mapping.reason || mapping.source_session_id !== (source.session_id ?? null) || mapping.target_session_id !== target || !Number.isInteger(mapping.frame_id_offset) || !Number.isFinite(mapping.timestamp_offset_ms)) throw new Error('Track alignment must explicitly identify the source session, target session and finite offsets');
  const aligned = structuredClone(source);
  aligned.session_id = mapping.target_session_id;
  for (const track of aligned.tracks) for (const point of track.points) {
    point.frame_id += mapping.frame_id_offset;
    if (point.timestamp_ms != null) {
      if (!Number.isFinite(point.timestamp_ms)) throw new Error('Track timestamps must be finite');
      point.timestamp_ms += mapping.timestamp_offset_ms;
    }
    if (point.frame_id < 0 || (point.timestamp_ms != null && point.timestamp_ms < 0)) throw new Error('Track alignment produces a negative frame or timestamp');
  }
  assertValid('trackSet', aligned);
  return aligned;
}

/** Writes an exclusive JSONL report plus pinned input manifest. Source poses are never rebound. */
export async function replayEquipment(options: EquipmentReplayOptions) {
  const posePath = path.resolve(options.pose), configPath = path.resolve(options.config), packPath = path.resolve(options.pack), outPath = path.resolve(options.out);
  const manifestPath = `${outPath}.manifest.json`;
  if (fs.existsSync(outPath) || fs.existsSync(manifestPath)) throw new Error('Output already exists; choose a new output filename');
  const inputs: Array<{ path: string; sha256: string }> = [];
  const pin = (file: string) => { const resolved = path.resolve(file); inputs.push({ path: resolved, sha256: sha256(fs.readFileSync(resolved)) }); return resolved; };
  const config = readJSON(pin(configPath)) as EquipmentReplayConfig;
  const resolveInput = (name: string) => pin(path.resolve(path.dirname(configPath), name));
  assertValid('calibration', config.calibration);
  if (!config.movement_id || !Array.isArray(config.capabilities_available) || config.capabilities_available.some((cap) => !CAPABILITIES.includes(cap)) || (config.allow_provisional !== undefined && typeof config.allow_provisional !== 'boolean')) throw new Error('Explicit movement, valid capabilities and boolean allow_provisional required');
  if (!config.tracking && !config.court) throw new Error('Supply tracking and/or court adapter configuration');
  if (config.contacts_path && !config.tracking) throw new Error('contacts_path requires a tracking adapter; court observations carry their own explicit contact evidence');
  const poses: PoseFrame[] = readLines(pin(posePath)).filter((row) => !('_header' in row));
  if (!poses.length) throw new Error('No source poses');
  for (let i = 0; i < poses.length; i++) {
    const frame = poses[i]; assertValid('poseFrame', frame);
    if (!Number.isFinite(frame.timestamp_ms) || (i > 0 && (frame.timestamp_ms <= poses[i - 1].timestamp_ms || frame.frame_id <= poses[i - 1].frame_id))) throw new Error('Source pose clock/frame sequence must be strictly increasing');
  }
  const first = poses[0];
  if (!first.tracked_subject_id || config.calibration.nominal_view === 'unknown') throw new Error('Replay requires an explicit source subject and calibrated camera view');
  const context: EquipmentCameraContext = { session_id: first.session_id, camera_id: first.camera_id, view: config.calibration.nominal_view, image_size: first.image_size, mirror: first.mirror, orientation: first.orientation };
  for (const frame of poses) {
    if (frame.session_id !== first.session_id || frame.camera_id !== first.camera_id || frame.orientation !== first.orientation || frame.mirror !== first.mirror || frame.image_size.some((v, i) => v !== first.image_size[i])) throw new Error('One replay input must have a stable source session/camera/image context; split camera changes explicitly');
  }
  let tracker: TrackSetEquipmentAdapter | undefined;
  if (config.tracking) {
    if (!Array.isArray(config.tracking.bindings) || !config.tracking.bindings.length) throw new Error('Tracking requires one or more explicit measurement bindings');
    const raw = readJSON(resolveInput(config.tracking.path)) as TrackSet;
    assertValid('trackSet', raw);
    const tracks = config.tracking.alignment ? alignEquipmentTracks(raw, config.tracking.alignment, first.session_id) : raw;
    tracker = new TrackSetEquipmentAdapter(tracks, context, config.tracking.bindings);
  }
  const contacts = new Map<number, ContactMeasurementEvidence>();
  if (config.contacts_path) for (const contact of readLines(resolveInput(config.contacts_path)) as ContactMeasurementEvidence[]) {
    if (contacts.has(contact.frame_id) || contact.event !== 'implement_projectile') throw new Error('Contact rows must be unique implement_projectile events, already in the source pose clock');
    if (!['sensor', 'reviewed_annotation'].includes(contact.kind) || typeof contact.source_id !== 'string' || !contact.source_id || typeof contact.version !== 'string' || !contact.version || !Number.isInteger(contact.frame_id) || contact.frame_id < 0 || !Number.isFinite(contact.timestamp_ms) || contact.timestamp_ms < 0 || !Number.isFinite(contact.confidence) || contact.confidence < 0 || contact.confidence > 1 || Object.keys(contact).some((key) => !['kind', 'event', 'source_id', 'version', 'frame_id', 'timestamp_ms', 'confidence'].includes(key))) throw new Error('Invalid independent contact evidence');
    contacts.set(contact.frame_id, contact);
  }
  let court: ReturnType<typeof calibrateCourt> | undefined;
  const observations = new Map<number, { timestamp_ms: number; observations: GroundFootprintObservation[] }>();
  if (config.court) {
    court = calibrateCourt(readJSON(resolveInput(config.court.calibration_path)) as CourtCalibrationInput);
    for (const row of readLines(resolveInput(config.court.observations_path))) {
      if (!Number.isInteger(row.frame_id) || !Number.isFinite(row.timestamp_ms) || observations.has(row.frame_id) || !Array.isArray(row.observations)) throw new Error('Court rows require unique frame_id, timestamp_ms and observations array');
      observations.set(row.frame_id, row);
    }
  }
  const frameTimes = new Map(poses.map((pose) => [pose.frame_id, pose.timestamp_ms]));
  for (const entry of [...contacts.entries(), ...observations.entries()]) if (frameTimes.get(entry[0]) !== entry[1].timestamp_ms) throw new Error('Contact/court evidence must bind exactly to a source pose frame and timestamp');
  const packInput = await readPackDir(packPath);
  const runtime = new BrainRuntime({ platform: 'web', strict_rubrics: config.allow_provisional !== true, allow_draft_feedback: false, capabilities_available: config.capabilities_available, hmac_keys: { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET } });
  const bundle = await runtime.installPack(packInput); runtime.activatePack(bundle.manifest.id, bundle.manifest.version);
  runtime.calibrate(config.calibration, first.timestamp_ms);
  runtime.start({ session_id: first.session_id, sport_pack_id: bundle.manifest.id, sport_pack_version: bundle.manifest.version, movement_id: config.movement_id, calibration: config.calibration, pinned_models: [] }, first.timestamp_ms);
  const counts = { source_frames: poses.length, processed_frames: 0, measurements: 0, contact_measurements: 0, assessments: 0, states: {} as Record<string, number> };
  const descriptor = fs.openSync(outPath, 'wx');
  try {
    for (const pose of poses) {
      const packets = [];
      if (tracker) packets.push(tracker.measure(pose, contacts.get(pose.frame_id)));
      const observation = observations.get(pose.frame_id);
      if (court && observation) packets.push(courtFootprintMeasurements(court, pose, observation.observations));
      const equipment = packets.length ? mergeEquipmentFrames(...packets) : undefined;
      const tick = runtime.process(pose, pose.timestamp_ms, equipment);
      if (tick) counts.processed_frames++;
      counts.measurements += equipment?.measurements.length ?? 0;
      counts.contact_measurements += equipment?.measurements.filter((m) => m.contact).length ?? 0;
      if (tick?.assessment) {
        counts.assessments++;
        for (const criterion of tick.assessment.criteria) counts.states[criterion.state] = (counts.states[criterion.state] ?? 0) + 1;
      }
      fs.writeSync(descriptor, JSON.stringify({ frame_id: pose.frame_id, timestamp_ms: pose.timestamp_ms, equipment: equipment ?? null, tick }) + '\n');
    }
  } finally { fs.closeSync(descriptor); }
  const manifest = { schema_version: '1.0.0', kind: 'equipment_replay', retrospective_report: true, input_files: inputs,
    pack: { id: bundle.manifest.id, version: bundle.manifest.version, manifest_payload_sha256: sha256(JSON.stringify(packInput.manifest)), asset_hashes: bundle.manifest.asset_hashes },
    source_context: { ...context, first_frame_id: first.frame_id, first_timestamp_ms: first.timestamp_ms, subject_ids: [...new Set(poses.map((p) => p.tracked_subject_id))] },
    pose_rebinding: null, track_alignment: config.tracking?.alignment ?? null, strict_rubrics: config.allow_provisional !== true,
    court_calibration: court ? { calibration_id: court.calibration_id, reprojection_error_m: court.reprojection_error_m, image_to_court: court.image_to_court } : null,
    output: { path: outPath, sha256: sha256(fs.readFileSync(outPath)) }, counts };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--pose', '--pack', '--config', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: tsx tools/replay_equipment.ts --pose poses.jsonl --pack sport-packs/squash --config equipment.json --out results.jsonl');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (['pose', 'pack', 'config', 'out'].some((key) => !options[key])) throw new Error('Required: --pose --pack --config --out');
  replayEquipment(options as unknown as EquipmentReplayOptions).then((report) => console.log(JSON.stringify(report.counts, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
