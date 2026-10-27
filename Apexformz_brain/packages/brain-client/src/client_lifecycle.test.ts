import { describe, expect, it, vi } from 'vitest';
import type { SessionStartRequest } from '@apexformz/contracts';
import { BrainClient } from './client';
import type { MainToWorker, WorkerToMain } from './protocol';

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerToMain>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: MainToWorker[] = [];
  postMessage = vi.fn((message: MainToWorker) => { this.messages.push(message); });
  terminate = vi.fn();
  send(message: WorkerToMain) { this.onmessage?.({ data: message } as MessageEvent<WorkerToMain>); }
  acknowledge(type: MainToWorker['type'], result?: unknown) {
    const request = [...this.messages].reverse().find((message) => message.type === type);
    if (!request || !('id' in request)) throw new Error(`Missing ${type} request`);
    this.send({ type: 'ok', id: request.id, result });
  }
}

async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
const imageMeta = { session_id: 's', timestamp_ms: 0, camera_id: 'c', mirror: false, orientation: 'landscape' as const };
const bitmap = () => ({ close: vi.fn() } as unknown as ImageBitmap);
const images = (worker: FakeWorker) => worker.messages.filter((message): message is Extract<MainToWorker, { type: 'image' }> => message.type === 'image');
const imageDone = (message: Extract<MainToWorker, { type: 'image' }>): WorkerToMain => ({ type: 'image_done', image_id: message.image_id, frame_id: message.frame_id, session_id: message.session_id });

describe('Brain client lifecycle', () => {
  it('bounds transferred images while inference is slow and waits for completion even when a pose arrives', () => {
    const worker = new FakeWorker(); const client = new BrainClient(worker as unknown as Worker);
    const first = bitmap(); client.offerImage(first, imageMeta);
    const extras = Array.from({ length: 100 }, bitmap);
    for (const extra of extras) client.offerImage(extra, imageMeta);
    expect(images(worker)).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled(); // Worker owns transferred images.
    for (const extra of extras) expect(extra.close).toHaveBeenCalledOnce();
    worker.send({ type: 'pose', frame: { frame_id: 0 } as never, latency_ms: 100 });
    const afterPose = bitmap(); client.offerImage(afterPose, imageMeta);
    expect(afterPose.close).toHaveBeenCalledOnce();
    expect(images(worker)).toHaveLength(1);
    worker.send(imageDone(images(worker)[0]));
    const next = bitmap(); client.offerImage(next, imageMeta);
    expect(images(worker)).toHaveLength(2);
    expect(next.close).not.toHaveBeenCalled();
    client.dispose();
  });

  it('cannot release a new session image with a duplicate old acknowledgement after frame IDs reset', async () => {
    const worker = new FakeWorker(); const client = new BrainClient(worker as unknown as Worker);
    const init = client.init({}); worker.acknowledge('init'); await init;
    client.offerImage(bitmap(), { ...imageMeta, session_id: 'preview' });
    const previous = images(worker)[0];
    worker.send(imageDone(previous));
    const start = client.start({ session_id: 's' } as SessionStartRequest);
    await flush(); worker.acknowledge('start', {}); await start;
    client.offerImage(bitmap(), imageMeta);
    const current = images(worker)[1];
    expect(current.frame_id).toBe(previous.frame_id);
    expect(current.image_id).not.toBe(previous.image_id);
    worker.send(imageDone(previous));
    const blocked = bitmap(); client.offerImage(blocked, imageMeta);
    expect(blocked.close).toHaveBeenCalledOnce();
    expect(images(worker)).toHaveLength(2);
    worker.send(imageDone(current));
    client.offerImage(bitmap(), imageMeta);
    expect(images(worker)).toHaveLength(3);
    client.dispose();
  });

  it('releases its host slot after transfer failure and closes future images after fatal errors or disposal', () => {
    const worker = new FakeWorker(); const client = new BrainClient(worker as unknown as Worker);
    const failed = bitmap();
    worker.postMessage.mockImplementationOnce(() => { throw new Error('transfer failed'); });
    expect(() => client.offerImage(failed, imageMeta)).toThrow('transfer failed');
    expect(failed.close).toHaveBeenCalledOnce();
    const accepted = bitmap(); client.offerImage(accepted, imageMeta);
    expect(images(worker)).toHaveLength(1);
    worker.onerror!({ message: 'worker crashed' } as ErrorEvent);
    worker.send(imageDone(images(worker)[0]));
    const afterFailure = bitmap(); client.offerImage(afterFailure, imageMeta);
    expect(afterFailure.close).toHaveBeenCalledOnce();
    client.dispose();
    const afterDispose = bitmap(); client.offerImage(afterDispose, imageMeta);
    expect(afterDispose.close).toHaveBeenCalledOnce();
    expect(images(worker)).toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('serializes initialization, optional model loading and session start', async () => {
    const worker = new FakeWorker();
    const client = new BrainClient(worker as unknown as Worker);
    const init = client.init({});
    expect(client.init({})).toBe(init);
    expect(worker.messages[0]).toMatchObject({ type: 'init', host_time_origin_ms: performance.timeOrigin });
    const load = client.loadMovementModels([]);
    const start = client.start({} as SessionStartRequest);
    await flush();
    expect(worker.messages.map((message) => message.type)).toEqual(['init']);
    worker.acknowledge('init');
    await init; await flush();
    expect(worker.messages.map((message) => message.type)).toEqual(['init', 'load_movement_models']);
    await expect(client.loadMovementModels([])).rejects.toThrow(/already loading/);
    worker.acknowledge('load_movement_models', []);
    await load; await flush();
    expect(worker.messages.map((message) => message.type)).toEqual(['init', 'load_movement_models', 'start']);
    worker.acknowledge('start', { pack: { id: 'squash' } });
    await start;
    client.dispose();
  });

  it('propagates model failure and does not start a session that raced that load', async () => {
    const worker = new FakeWorker();
    const client = new BrainClient(worker as unknown as Worker);
    const init = client.init({}); worker.acknowledge('init'); await init;
    const load = client.loadMovementModels([]);
    const start = client.start({} as SessionStartRequest);
    const loadError = expect(load).rejects.toThrow('bad digest');
    const startError = expect(start).rejects.toThrow('bad digest');
    await flush();
    const request = worker.messages.find((message) => message.type === 'load_movement_models')!;
    worker.send({ type: 'error', id: 'id' in request ? request.id : 0, code: 'INTERNAL', message: 'bad digest', recoverable: true });
    await Promise.all([loadError, startError]);
    expect(worker.messages.some((message) => message.type === 'start')).toBe(false);
    client.dispose();
  });

  it('rejects pending work, closes late bitmaps and ignores stale worker events after disposal', async () => {
    const worker = new FakeWorker();
    const client = new BrainClient(worker as unknown as Worker);
    const ready = vi.fn(); client.on('ready', ready);
    const init = client.init({});
    const rejected = expect(init).rejects.toThrow(/disposed/);
    const staleHandler = worker.onmessage!;
    client.dispose(); client.dispose();
    await rejected;
    staleHandler({ data: { type: 'ready', detector: true, core_version: '1' } } as MessageEvent<WorkerToMain>);
    expect(ready).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    client.offerImage(bitmap, { session_id: 's', timestamp_ms: 0, camera_id: 'c', mirror: false, orientation: 'landscape' });
    expect(bitmap.close).toHaveBeenCalledOnce();
    await expect(client.start({} as SessionStartRequest)).rejects.toThrow(/disposed/);
  });

  it('preserves the actual pose backend on ready events', async () => {
    const worker = new FakeWorker(); const client = new BrainClient(worker as unknown as Worker);
    const ready = vi.fn(); client.on('ready', ready);
    worker.send({ type: 'ready', detector: true, core_version: '1', pose_backend: 'onnx:wasm' });
    expect(ready).toHaveBeenCalledWith({ detector: true, core_version: '1', pose_backend: 'onnx:wasm' });
    client.dispose();
  });

  it('rejects pending initialization when the worker script fails instead of hanging Start', async () => {
    const worker = new FakeWorker(); const client = new BrainClient(worker as unknown as Worker);
    const init = client.init({});
    const failed = expect(init).rejects.toThrow('failed to load worker');
    worker.onerror!({ message: 'failed to load worker' } as ErrorEvent);
    await failed;
    await expect(client.start({} as SessionStartRequest)).rejects.toThrow('failed to load worker');
    client.dispose();
  });
});
