import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { PoseFrame } from '@apexformz/contracts';
import { loadClips, prelabelRows, replayCalibration, replayFrame, sourcePhases,
  type Clip, type ReplayResult } from '../../../tools/calibrate_phase_graphs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function frame(timestamp_ms: number): PoseFrame {
  return { schema_version: '1.0.0', session_id: 'source-session', frame_id: 19, timestamp_ms,
    camera_id: 'camera', image_size: [1280, 720], mirror: false, orientation: 'landscape',
    landmark_set: 'mediapipe_pose_33', normalized_landmarks: [], tracked_subject_id: 'source-person-7',
    quality: { framing_ok: false, ambiguous_people: true, track_changed: true, missing_joints: [15, 27],
      person_count: 2, motion_blur: .8, detection_confidence: .2 },
    provenance: { model_id: 'mediapipe-full', version: '1' } };
}

function clip(): Clip {
  return { execution_id: 'capture-A', stream_id: 'view-A', movement_id: 'squash.dynamic.0001', athlete_id: 'ATH_0005',
    view: 'right', start_ms: 5000, end_ms: 8000, frames: [frame(5050)], handedness: 'unknown', athlete_context: 'unknown' };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-phase-proxy-'));
  directories.push(directory);
  const data = [{ _header: { schema_version: '1.0.0' } }, frame(4999), frame(5050), frame(6000), frame(8001)]
    .map((row) => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(path.join(directory, 'pose.jsonl'), data);
  const stream = (view_stream_id: string) => ({ view_stream_id, camera_id: 'camera', pose_path: 'pose.jsonl',
    pose_sha256: createHash('sha256').update(data).digest('hex'),
    object_uri: 's3://apexformz-datacapture-test/raw/squash/video.mp4', extraction: { orientation_policy: 'encoded' } });
  const execution = (execution_id: string, view_stream_ids = ['view-A']) => ({ execution_id, view_stream_ids,
    movement_id: 'squash.dynamic.0001', athlete_id: 'ATH_0005', start_ms: 5000, end_ms: 8000 });
  const manifest = { sport_pack_id: 'squash', athletes: [{ athlete_id: 'ATH_0005', handedness: 'unknown', context: 'unknown' }],
    cameras: [{ camera_id: 'camera', view: 'right' }], view_streams: [stream('view-A'), stream('view-B')],
    executions: [execution('train-A', ['view-A', 'view-B']), execution('train-B'), execution('val-A'), execution('test-A')],
    splits: { assignments: { 'train-A': 'train', 'train-B': 'train', 'val-A': 'val', 'test-A': 'test' } as Record<string, string> } };
  const dataset = path.join(directory, 'dataset.json');
  const save = () => fs.writeFileSync(dataset, JSON.stringify(manifest));
  save();
  return { manifest, dataset, save };
}

describe('phase proxy training data boundary', () => {
  it('uses all train execution streams, excludes held-outs, and retains source bounds/quality', () => {
    const { dataset } = fixture();
    const clips = loadClips(dataset);
    expect(clips.map((c) => [c.execution_id, c.stream_id])).toEqual([
      ['train-A', 'view-A'], ['train-A', 'view-B'], ['train-B', 'view-A'],
    ]);
    expect(clips[0].frames.map((f) => f.timestamp_ms)).toEqual([5050, 6000]);
    expect(clips[0].frames[0].quality).toEqual(frame(5050).quality);
    expect(clips[0].frames[0].tracked_subject_id).toBe('source-person-7');
    expect(clips[0]).toMatchObject({ start_ms: 5000, end_ms: 8000, handedness: 'unknown', athlete_context: 'unknown' });
    expect(loadClips(dataset, 1)).toHaveLength(2); // limit executions, not camera views
  });

  it('accepts recorded hand/context but invents neither when absent', () => {
    const f = fixture();
    f.manifest.athletes[0].handedness = 'left';
    f.manifest.athletes[0].context = 'intermediate';
    f.save();
    expect(loadClips(f.dataset)[0]).toMatchObject({ handedness: 'left', athlete_context: 'intermediate' });
  });

  it('requires explicit valid split membership even if a capture would be skipped', () => {
    const f = fixture();
    delete f.manifest.splits.assignments['test-A'];
    f.save();
    expect(() => loadClips(f.dataset)).toThrow('Missing/invalid split: test-A');
  });

  it('rejects mismatched pose bytes rather than quietly using another extraction', () => {
    const f = fixture();
    f.manifest.view_streams[0].pose_sha256 = '0'.repeat(64);
    f.save();
    expect(() => loadClips(f.dataset)).toThrow('Pose checksum mismatch');
  });

  it.each(['scope', 'orientation', 'bounds'])('rejects invalid %s', (failure) => {
    const f = fixture();
    if (failure === 'scope') f.manifest.view_streams[0].object_uri = 's3://another-bucket/raw/squash/video.mp4';
    if (failure === 'orientation') f.manifest.view_streams[0].extraction.orientation_policy = 'metadata';
    if (failure === 'bounds') f.manifest.executions[0].end_ms = 1000;
    f.save();
    expect(() => loadClips(f.dataset)).toThrow();
  });
});

describe('phase proxy evidence and source-clock export', () => {
  it('never clears quality flags or replaces tracked identity during replay', () => {
    const input = frame(5050);
    const output = replayFrame(input, 'replay-session', 0, 5049);
    expect(output.timestamp_ms).toBe(1);
    expect(output.session_id).toBe('replay-session');
    expect(output.quality).toEqual(input.quality);
    expect(output.tracked_subject_id).toBe(input.tracked_subject_id);
    output.quality.missing_joints.push(1);
    expect(input.quality.missing_joints).toEqual([15, 27]);
    expect(input.timestamp_ms).toBe(5050);
  });

  it('calibrates from known metadata and source framing only', () => {
    expect(replayCalibration(clip())).toMatchObject({ handedness: 'unknown', handedness_assumed: true,
      athlete_context: 'unknown', full_body_framing: false });
    const known = clip();
    known.handedness = 'right'; known.athlete_context = 'advanced'; known.frames[0].quality.framing_ok = true;
    expect(replayCalibration(known)).toMatchObject({ handedness: 'right', handedness_assumed: false,
      athlete_context: 'advanced', full_body_framing: true });
  });

  it('preserves repeated executions, source times, open boundaries and unreviewed status', () => {
    const first = sourcePhases([{ phase_id: 'ready', start_ms: 1, end_ms: 100 },
      { phase_id: 'swing', start_ms: 100, end_ms: 200 }], 5049);
    const second = sourcePhases([{ phase_id: 'ready', start_ms: 300, end_ms: 400 },
      { phase_id: 'swing', start_ms: 400, end_ms: null }], 5049);
    const result: ReplayResult = { completed: true, reached: new Set(['swing']), states: ['EXECUTING'], phases: second,
      executions: [{ completed: true, phases: first }, { completed: false, phases: second }] };
    const rows = prelabelRows(clip(), result);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.execution_id)).size).toBe(2);
    expect(rows[0]).toMatchObject({ source_execution_id: 'capture-A', stream_id: 'view-A',
      source_start_ms: 5000, source_end_ms: 8000, source_clock: 'capture_monotonic_ms',
      start_ms: 5050, end_ms: 5249, review_status: 'unreviewed', production_eligible: false });
    expect(rows[1]).toMatchObject({ start_ms: 5349, end_ms: null, boundary_status: 'partial_open_boundary' });
    expect(rows[1].phases.at(-1)?.end_ms).toBeNull();
  });

  it('retains an explicit no-detection record without fabricated timing labels', () => {
    const rows = prelabelRows(clip(), { completed: false, reached: new Set(), phases: [], executions: [], states: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ boundary_status: 'no_phases_detected', start_ms: null, end_ms: null,
      phases: [], review_status: 'unreviewed', completed: false });
  });
});
