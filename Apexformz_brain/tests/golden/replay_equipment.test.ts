import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syntheticPoseFrame } from '@apexformz/signal';
import type { TrackSet } from '@apexformz/contracts';
import { alignEquipmentTracks, replayEquipment, type EquipmentReplayConfig, type TrackAlignment } from '../../tools/replay_equipment';
import { calibration, PACKS_DIR } from '../helpers/packs';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) {
  if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('apex-equipment-')) throw new Error('Unexpected temporary test path');
  fs.rmSync(directory, { recursive: true, force: true });
} });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-equipment-')); temporary.push(directory);
  const poses = Array.from({ length: 60 }, (_, i) => syntheticPoseFrame(100 + i, 1000 + i * 40, { right_arm_raise: 88, right_elbow_flexion: 5, stance_width: 0.45 }, { session_id: 'source-session', camera_id: 'source-camera', tracked_subject_id: 'athlete' }));
  const tracks: TrackSet = { schema_version: '1.0.0', session_id: 'track-session', source: { model_id: 'offline-point-tracker', version: 'test-1' }, kind: 'point', coordinate_system: 'image_normalized', image_size: [1280, 720], frame_count: 60, retrospective: true, tracks: [{ track_id: 'head', assigned_subject_id: 'athlete', points: poses.map((_, i) => ({ frame_id: i, timestamp_ms: i * 40, x: 0.5, y: 0.25, visible: true, confidence: 0.9 })) }] };
  const alignment: TrackAlignment = { mapping_id: 'reviewed-clock-map', reason: 'Known extraction start offset', source_session_id: 'track-session', target_session_id: 'source-session', frame_id_offset: 100, timestamp_offset_ms: 1000 };
  const config: EquipmentReplayConfig = { movement_id: 'shooting.setup_stance', calibration: calibration(), capabilities_available: ['body_pose', 'optional_implement'], tracking: { path: 'tracks.json', alignment, bindings: [{ track_id: 'head', subject_id: 'athlete', equipment_id: 'implement', measurement_id: 'implement_y', quantity: 'y_image' }] } };
  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data));
  fs.writeFileSync(path.join(directory, 'poses.jsonl'), poses.map((p) => JSON.stringify(p)).join('\n') + '\n');
  write('tracks.json', tracks); write('config.json', config);
  const options = { pose: path.join(directory, 'poses.jsonl'), pack: path.join(PACKS_DIR, 'shooting'), config: path.join(directory, 'config.json'), out: path.join(directory, 'result.jsonl') };
  return { directory, poses, tracks, alignment, config, options, write };
}

describe('equipment replay CLI implementation', () => {
  it('runs the documented command entrypoint and creates its completed pinned report', () => {
    const { options } = fixture();
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'tools/replay_equipment.ts', '--pose', options.pose, '--pack', options.pack, '--config', options.config, '--out', options.out], { cwd: path.resolve(PACKS_DIR, '..'), encoding: 'utf8' });
    expect(JSON.parse(stdout)).toMatchObject({ source_frames: 60, measurements: 60, contact_measurements: 0 });
    expect(JSON.parse(fs.readFileSync(`${options.out}.manifest.json`, 'utf8')).output.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('runs the real runtime, retains the pose session/clock and records explicit track alignment without manufacturing contact', async () => {
    const { options } = fixture();
    const report = await replayEquipment(options);
    expect(report.strict_rubrics).toBe(true);
    expect(report.pose_rebinding).toBeNull();
    expect(report.source_context).toMatchObject({ session_id: 'source-session', first_frame_id: 100, first_timestamp_ms: 1000 });
    expect(report.track_alignment?.mapping_id).toBe('reviewed-clock-map');
    expect(report.input_files.every((input) => /^[a-f0-9]{64}$/.test(input.sha256))).toBe(true);
    expect(report.counts).toMatchObject({ source_frames: 60, processed_frames: 60, measurements: 60, contact_measurements: 0 });
    expect(report.counts.assessments).toBeGreaterThan(0);
    const rows = fs.readFileSync(options.out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({ frame_id: 100, timestamp_ms: 1000, equipment: { retrospective: true, measurements: [{ value: 0.25, validation_status: 'provisional' }] } });
    expect(rows.every((row) => row.equipment.measurements.every((m: any) => !m.contact))).toBe(true);
    await expect(replayEquipment(options)).rejects.toThrow(/already exists/);
  });
  it('requires exact, explicitly mapped sessions; rejects a contact annotation in the wrong clock', async () => {
    const f = fixture(); delete f.config.tracking!.alignment; f.write('config.json', f.config);
    await expect(replayEquipment(f.options)).rejects.toThrow(/session mismatch/);
    f.config.tracking!.alignment = f.alignment; f.config.contacts_path = 'contacts.jsonl'; f.write('config.json', f.config);
    f.write('contacts.jsonl', { kind: 'reviewed_annotation', event: 'implement_projectile', source_id: 'manual-contact-review', version: '1', frame_id: 100, timestamp_ms: 0, confidence: 0.9 });
    await expect(replayEquipment(f.options)).rejects.toThrow(/source pose frame and timestamp/);
    expect(fs.existsSync(f.options.out)).toBe(false);
  });
  it('refuses inconsistent source cameras and unsupported capability declarations', async () => {
    const f = fixture(); f.poses[1].camera_id = 'different';
    fs.writeFileSync(f.options.pose, f.poses.map((p) => JSON.stringify(p)).join('\n'));
    await expect(replayEquipment(f.options)).rejects.toThrow(/stable source session\/camera/);
    f.config.capabilities_available.push('invented' as any); f.write('config.json', f.config);
    await expect(replayEquipment(f.options)).rejects.toThrow(/valid capabilities/);
  });
  it('offsets only timestamps already present, rejects false/negative mappings and leaves source tracks unchanged', () => {
    const f = fixture(); delete f.tracks.tracks[0].points[0].timestamp_ms;
    const mapped = alignEquipmentTracks(f.tracks, f.alignment, 'source-session');
    expect(mapped.tracks[0].points[0].timestamp_ms).toBeUndefined();
    expect(mapped.tracks[0].points[1]).toMatchObject({ frame_id: 101, timestamp_ms: 1040 });
    expect(f.tracks.tracks[0].points[1]).toMatchObject({ frame_id: 1, timestamp_ms: 40 });
    expect(() => alignEquipmentTracks(f.tracks, { ...f.alignment, source_session_id: 'invented' }, 'source-session')).toThrow(/explicitly identify/);
    expect(() => alignEquipmentTracks(f.tracks, { ...f.alignment, frame_id_offset: -1 }, 'source-session')).toThrow(/negative/);
  });
});
