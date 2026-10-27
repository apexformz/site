import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { BrainTick } from '@apexformz/runtime';
import { assertReplayTick, validateReplaySource } from '../../tools/replay_squash_brain';

const source = { pose_path: 'poses/p.jsonl', pose_sha256: 'a'.repeat(64),
  object_uri: 's3://apexformz-datacapture-prod-media/raw/squash/session/clip.mp4', extraction: { orientation_policy: 'encoded' } };
describe('recorded squash regression admission', () => {
  it('accepts pinned Data Capture inputs and refuses other sources, orientation and path escape', () => {
    const root = path.resolve('data/squash');
    expect(validateReplaySource(root, source)).toBe(path.join(root, 'poses/p.jsonl'));
    expect(() => validateReplaySource(root, { ...source, object_uri: 's3://data-sorter/raw/squash/clip.mp4' })).toThrow('Data Capture');
    expect(() => validateReplaySource(root, { ...source, extraction: { orientation_policy: 'metadata' } })).toThrow('landscape');
    expect(() => validateReplaySource(root, { ...source, pose_path: '../../other.jsonl' })).toThrow('escapes');
    expect(() => validateReplaySource(root, { ...source, pose_sha256: '' })).toThrow('Pinned');
  });

  it('fails a regression if recognition changes the selected coaching graph', () => {
    const t = { executed_pack: { id: 'squash' }, features: [], temporal: { movement_id: 'other' } } as unknown as BrainTick;
    expect(() => assertReplayTick(t, 'squash.dynamic.0021', false)).toThrow('selected movement');
  });

  it('distinguishes strict provisional abstention from an unapproved verdict', () => {
    const c = { measurement: { value: 42 }, provenance: { validation_status: 'provisional' }, state: 'UNCERTAIN' };
    const t = { executed_pack: { id: 'squash' }, features: [], assessment: { movement_id: 'm', score: null, criteria: [c] } } as unknown as BrainTick;
    expect(() => assertReplayTick(t, 'm', true)).not.toThrow();
    c.state = 'PASS';
    expect(() => assertReplayTick(t, 'm', true)).toThrow('unapproved strict verdict');
    expect(() => assertReplayTick(t, 'm', false)).not.toThrow();
    c.measurement.value = NaN;
    expect(() => assertReplayTick(t, 'm', false)).toThrow('nonfinite measurement');
  });
});
