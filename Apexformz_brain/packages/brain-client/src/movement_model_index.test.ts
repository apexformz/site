import { describe, expect, it, vi } from 'vitest';
import { fetchMovementModelIndex } from './movement_model_index';
import type { MovementModelConfig } from '@apexformz/analysis';

function config(task: 'static_pose' | 'dynamic_movement'): MovementModelConfig {
  return {
    schema_version: '1.0.0', sport_id: 'squash', model_task: task,
    model: { model_id: task, version: '1', digest: `sha256:${'0'.repeat(64)}` },
    classes: ['squash.capture.exact-id', 'UNKNOWN'], class_names: { 'squash.capture.exact-id': 'Coach source name' },
    input: { landmark_set: 'mediapipe_pose_33', window_frames: task === 'static_pose' ? 1 : 45, hz: 15, max_hold_ms: 100, min_visibility: 0.5, normalization: 'body_relative_v1', smoothing: 'none' },
    calibration: { temperature: 1, margin: 0.1, thresholds: { 'squash.capture.exact-id': 0.7 }, status: 'provisional' },
  };
}
const indexUrl = 'https://example.test/models/squash/index.json';
function fetcher(index: unknown, staticConfig = config('static_pose')) {
  return vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('index.json') ? index : url.endsWith('static.json') ? staticConfig : config('dynamic_movement')), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}
const index = [{ deployment_url: 'static.json', model_url: 'static.onnx' }, { deployment_url: '/models/squash/dynamic.json', model_url: 'dynamic.onnx' }];

describe('frontend movement model discovery', () => {
  it('loads both tasks with resolved artifact URLs and source names preserved', async () => {
    const models = await fetchMovementModelIndex(indexUrl, 'squash', { allow_provisional: true, fetch: fetcher(index) });
    expect(models.map((m) => m.config.model_task)).toEqual(['static_pose', 'dynamic_movement']);
    expect(models[0]).toMatchObject({ model_url: 'https://example.test/models/squash/static.onnx', allow_provisional: true });
    expect(models[0].config.class_names).toEqual({ 'squash.capture.exact-id': 'Coach source name' });
  });

  it('never accepts a deployment setting that enables provisional recognition in strict mode', async () => {
    const unsafe = { ...config('static_pose'), allow_provisional: true };
    const models = await fetchMovementModelIndex(indexUrl, 'squash', { allow_provisional: false, fetch: fetcher([index[0]], unsafe) });
    expect(models[0].allow_provisional).toBe(false);
  });

  it('treats a missing optional index as no recognition models', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(await fetchMovementModelIndex(indexUrl, 'squash', { allow_provisional: false, fetch })).toEqual([]);
  });

  it('rejects cross-sport metadata, duplicated tasks, unsupported URLs and broken deployments', async () => {
    await expect(fetchMovementModelIndex(indexUrl, 'squash', { allow_provisional: false, fetch: fetcher(index, { ...config('static_pose'), sport_id: 'badminton' }) })).rejects.toThrow(/sport/);
    await expect(fetchMovementModelIndex(indexUrl, 'squash', { allow_provisional: false, fetch: fetcher([index[0], index[0]]) })).rejects.toThrow(/duplicate/);
    await expect(fetchMovementModelIndex(indexUrl, 'squash', { allow_provisional: false, fetch: fetcher([{ ...index[0], model_url: 'javascript:invalid' }]) })).rejects.toThrow(/HTTP/);
    const missing = vi.fn(async (url: string) => url.endsWith('index.json') ? new Response(JSON.stringify(index)) : new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(fetchMovementModelIndex(indexUrl, 'squash', { allow_provisional: false, fetch: missing })).rejects.toThrow(/metadata unavailable/);
  });
});
