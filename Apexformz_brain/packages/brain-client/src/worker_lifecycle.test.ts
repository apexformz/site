import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syntheticPoseFrame } from '@apexformz/signal';
import type { MainToWorker, WorkerToMain } from './protocol';

const mocks = vi.hoisted(() => ({ init: vi.fn(), detect: vi.fn(), close: vi.fn(), offer: vi.fn(), equipment: vi.fn(),
  pin: vi.fn(), resetTracking: vi.fn(), appearanceRequest: vi.fn(), provideAppearance: vi.fn(), loadReid: vi.fn(), crop: vi.fn(), embed: vi.fn(), reidClose: vi.fn(),
  runtimeInit: vi.fn(), calibrate: vi.fn(), start: vi.fn(), pause: vi.fn(), resume: vi.fn(), complete: vi.fn(), heartbeat: vi.fn(), tick: vi.fn() }));
vi.mock('./pose_landmarker', () => ({ PoseDetectorBridge: class {
  ready = true;
  init = mocks.init;
  detect = mocks.detect;
  close = mocks.close;
  resetTracking = mocks.resetTracking;
  pin = mocks.pin;
  appearanceRequest = mocks.appearanceRequest;
  provideAppearance = mocks.provideAppearance;
} }));
vi.mock('./reid', () => ({ loadReidEmbedder: mocks.loadReid }));
vi.mock('./onnx_pose_backend', () => ({ OnnxPoseBackend: class {} }));
vi.mock('@apexformz/runtime', () => ({ BrainRuntime: class {
  constructor(config: unknown, clock: () => number) { mocks.runtimeInit(config, clock); }
  sessionState = 'IDLE';
  offer = mocks.offer;
  noteEquipment = mocks.equipment;
  tick = mocks.tick;
  calibrate = mocks.calibrate;
  start(request: unknown, now: number) {
    mocks.start(request, now); this.sessionState = 'ACTIVE';
    return { pack: { movement_catalog: {}, manifest: { id: 'squash', version: '1.0.0' } }, movement: { id: 'm' }, phase_graph: {}, criteria: [] };
  }
  pause(now: number) { mocks.pause(now); this.sessionState = 'PAUSED'; }
  resume(now: number) { mocks.resume(now); this.sessionState = 'ACTIVE'; }
  complete(now: number) { mocks.complete(now); this.sessionState = 'LOCAL_COMMITTED'; return {}; }
  heartbeat = mocks.heartbeat;
} }));

type TestContext = { onmessage: ((event: MessageEvent<MainToWorker>) => Promise<void>) | null; postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
let context: TestContext;
const send = (message: MainToWorker) => context.onmessage!({ data: message } as MessageEvent<MainToWorker>);
const messages = () => context.postMessage.mock.calls.map((args) => args[0] as WorkerToMain);
const initMessage: MainToWorker = { type: 'init', id: 1, config: {}, detector: { wasm_base_url: '/runtime/wasm', model_asset_path: '/models/full.task' } };
function image(frame_id: number): Extract<MainToWorker, { type: 'image' }> {
  return { type: 'image', image_id: frame_id + 10, bitmap: { close: vi.fn(), width: 640, height: 480 } as unknown as ImageBitmap, frame_id, timestamp_ms: frame_id * 100, camera_id: 'c', mirror: false, orientation: 'landscape', session_id: 's' };
}
const done = (frame_id: number) => ({ type: 'image_done', image_id: frame_id + 10, frame_id, session_id: 's' });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.init.mockReset().mockResolvedValue(undefined);
  mocks.detect.mockReset().mockResolvedValue(null);
  mocks.tick.mockReset().mockReturnValue(null);
  mocks.appearanceRequest.mockReset().mockReturnValue(null);
  mocks.loadReid.mockReset().mockResolvedValue({ busy: false, crop: mocks.crop, embed: mocks.embed, close: mocks.reidClose });
  context = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
  vi.stubGlobal('self', context);
  await import('./worker');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Brain worker lifecycle', () => {
  it.each(['pin', 'unpin', 'pause', 'resume', 'start', 'complete', 'dispose'] as const)('drops delayed appearance results after %s', async (boundary) => {
    await send({ ...initMessage, detector: { ...initMessage.detector!, reid_config_url: '/reid.json' } });
    const request = { request_id: 1, generation: 1, subject_id: 'pinned-1', purpose: 'gallery', frame: 1, boxes: [] };
    mocks.appearanceRequest.mockReturnValue(request);
    mocks.crop.mockReturnValue({ batch: new Float32Array(1), kept: [0] });
    let resolve!: (embeddings: Float32Array[]) => void;
    mocks.embed.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    mocks.detect.mockResolvedValueOnce(syntheticPoseFrame(0, 0, {}, { session_id: 's' }));
    await send(image(0));
    expect(mocks.embed).toHaveBeenCalledOnce();
    if (boundary === 'pin' || boundary === 'unpin') await send({ type: 'pin_subject', id: 2, point: boundary === 'pin' ? { x: .5, y: .5 } : null });
    else if (boundary === 'start') await send({ type: 'start', id: 2, request: { session_id: 's' } as never });
    else if (boundary === 'dispose') await send({ type: 'dispose' });
    else await send({ type: boundary, id: 2 });
    resolve([Float32Array.of(1)]);
    await Promise.resolve();
    expect(mocks.provideAppearance).not.toHaveBeenCalled();
    if (boundary !== 'dispose') {
      mocks.embed.mockResolvedValueOnce([Float32Array.of(2)]);
      mocks.detect.mockResolvedValueOnce(syntheticPoseFrame(1, 100, {}, { session_id: 's' }));
      await send(image(1)); await Promise.resolve();
      expect(mocks.provideAppearance).toHaveBeenCalledWith(request, [Float32Array.of(2)]);
      await send({ type: 'dispose' });
    }
  });

  it.each([{ camera_id: 'new-camera' }, { session_id: 'new-session' }, { mirror: true }, { orientation: 'portrait' as const }])('drops appearance evidence across a changed capture context %j', async (changed) => {
    await send({ ...initMessage, detector: { ...initMessage.detector!, reid_config_url: '/reid.json' } });
    mocks.appearanceRequest.mockReturnValue({ request_id: 1, generation: 1, subject_id: 'pinned-1', purpose: 'gallery', frame: 1, boxes: [] });
    mocks.crop.mockReturnValue({ batch: new Float32Array(1), kept: [0] });
    let resolve!: (embeddings: Float32Array[]) => void;
    mocks.embed.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    mocks.detect.mockResolvedValueOnce(syntheticPoseFrame(0, 0));
    await send(image(0));
    await send({ ...image(1), ...changed });
    resolve([Float32Array.of(1)]); await Promise.resolve();
    expect(mocks.provideAppearance).not.toHaveBeenCalled();
    expect(mocks.resetTracking).toHaveBeenCalledOnce();
    await send({ type: 'dispose' });
  });

  it('releases re-ID resources if initialization finishes after disposal', async () => {
    let resolve!: (embedder: unknown) => void;
    mocks.loadReid.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = send({ ...initMessage, detector: { ...initMessage.detector!, reid_config_url: '/reid.json' } });
    await Promise.resolve();
    await send({ type: 'dispose' });
    resolve({ close: mocks.reidClose }); await pending;
    expect(mocks.reidClose).toHaveBeenCalledOnce();
    expect(messages()).toEqual([]);
  });
  it('maps lifecycle, frame arrival and tick times to the host origin without changing capture timestamps or inference durations', async () => {
    let localNow = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => localNow);
    const hostOrigin = performance.timeOrigin - 477.4;
    const offset = performance.timeOrigin - hostOrigin;
    await send({ ...initMessage, host_time_origin_ms: hostOrigin });
    const clock = mocks.runtimeInit.mock.calls[0][1] as () => number;
    expect(clock()).toBeCloseTo(localNow + offset);
    localNow = 150;
    await send({ type: 'calibrate', id: 2, calibration: {} as never });
    expect(mocks.calibrate).toHaveBeenCalledWith({}, localNow + offset);
    localNow = 200;
    await send({ type: 'start', id: 3, request: { session_id: 's' } as never });
    expect(mocks.start).toHaveBeenCalledWith({ session_id: 's' }, localNow + offset);
    localNow = 250;
    await send({ type: 'pause', id: 4 });
    expect(mocks.pause).toHaveBeenCalledWith(localNow + offset);
    localNow = 300;
    await send({ type: 'resume', id: 5 });
    expect(mocks.resume).toHaveBeenCalledWith(localNow + offset);
    const frame = syntheticPoseFrame(0, localNow + offset, {}, { session_id: 's' });
    await send({ type: 'pose_frame', frame });
    expect(mocks.offer).toHaveBeenLastCalledWith(frame, localNow + offset);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.tick).toHaveBeenLastCalledWith(localNow + offset);
    localNow = 350;
    const cameraFrame = syntheticPoseFrame(1, localNow + offset, {}, { session_id: 's' });
    mocks.detect.mockImplementationOnce(() => { localNow += 17; return cameraFrame; });
    await send({ ...image(1), timestamp_ms: cameraFrame.timestamp_ms });
    expect(mocks.detect).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ timestamp_ms: cameraFrame.timestamp_ms }));
    expect(mocks.offer).toHaveBeenLastCalledWith(cameraFrame, localNow + offset);
    expect(messages()).toContainEqual({ type: 'pose', frame: cameraFrame, latency_ms: 17 });
    localNow = 400;
    await send({ type: 'heartbeat', now_ms: 0 });
    expect(mocks.heartbeat).toHaveBeenCalledWith(localNow + offset);
    localNow = 450;
    await send({ type: 'complete', id: 6 });
    expect(mocks.complete).toHaveBeenCalledWith(localNow + offset);
    expect(clock()).toBeCloseTo(localNow + offset);
    await send({ type: 'dispose' });
  });

  it('keeps the legacy zero-offset clock when a host origin is omitted', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(123);
    await send(initMessage);
    const clock = mocks.runtimeInit.mock.calls[0][1] as () => number;
    expect(clock()).toBe(123);
    await send({ type: 'pause', id: 2 });
    expect(mocks.pause).toHaveBeenCalledWith(123);
    await send({ type: 'dispose' });
  });

  it.each([NaN, Infinity, -1])('rejects an invalid host origin (%s) before initializing the core', async (origin) => {
    await send({ ...initMessage, host_time_origin_ms: origin });
    expect(mocks.runtimeInit).not.toHaveBeenCalled();
    expect(messages()).toEqual([expect.objectContaining({ type: 'error', id: 1, code: 'SCHEMA_INVALID', recoverable: false })]);
    await send(initMessage);
    expect(mocks.runtimeInit).toHaveBeenCalledOnce();
    await send({ type: 'dispose' });
  });

  it('acknowledges and closes images rejected before initialization', async () => {
    const frame = image(0);
    await send(frame);
    expect(frame.bitmap.close).toHaveBeenCalledOnce();
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(messages()).toEqual([expect.objectContaining({ type: 'error', message: 'Brain worker initialization has not completed' }), done(0)]);
    await send({ type: 'dispose' });
  });

  it('acknowledges no-pose results, missing detectors and inference exceptions so capture can continue', async () => {
    await send(initMessage);
    const empty = image(0); await send(empty);
    expect(empty.bitmap.close).toHaveBeenCalledOnce();
    expect(messages()).toContainEqual(done(0));
    expect(messages().some((message) => message.type === 'pose')).toBe(false);
    mocks.detect.mockImplementationOnce(() => { throw new Error('inference failed'); });
    const failed = image(1); await send(failed);
    expect(failed.bitmap.close).toHaveBeenCalledOnce();
    expect(messages()).toContainEqual(expect.objectContaining({ type: 'error', message: 'inference failed' }));
    expect(messages()).toContainEqual(done(1));
    const recovered = image(2); await send(recovered);
    expect(messages()).toContainEqual(done(2));
    expect(mocks.detect).toHaveBeenCalledTimes(3);
    await send({ type: 'dispose' });
  });

  it('acknowledges images when initialized without an in-worker detector', async () => {
    await send({ ...initMessage, detector: undefined });
    const frame = image(0); await send(frame);
    expect(frame.bitmap.close).toHaveBeenCalledOnce();
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(messages()).toContainEqual(done(0));
    await send({ type: 'dispose' });
  });
  it('forwards equipment before its atomically supplied pose and acknowledges the standalone measurement API', async () => {
    await send(initMessage);
    const pose = syntheticPoseFrame(0, 0, {}, { session_id: 's' });
    const frame = { schema_version: '1.0.0', session_id: 's', camera_id: pose.camera_id, tracked_subject_id: 'athlete', view: 'front' as const, frame_id: 0, timestamp_ms: 0, image_size: pose.image_size, mirror: pose.mirror, orientation: pose.orientation, retrospective: false, measurements: [] };
    await send({ type: 'pose_frame', frame: pose, equipment: frame });
    expect(mocks.equipment).toHaveBeenCalledWith(frame);
    expect(mocks.equipment.mock.invocationCallOrder[0]).toBeLessThan(mocks.offer.mock.invocationCallOrder[0]);
    await send({ type: 'equipment_frame', id: 2, frame });
    expect(messages()).toContainEqual({ type: 'ok', id: 2 });
    await send({ type: 'dispose' });
  });
  it('discards a camera inference crossing pause/resume and accepts only the new stream result', async () => {
    await send(initMessage);
    let resolve!: (frame: ReturnType<typeof syntheticPoseFrame>) => void;
    mocks.detect.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const beforePause = image(0);
    const pending = send(beforePause);
    await send({ type: 'pause', id: 2 });
    await send({ type: 'resume', id: 3 });
    resolve(syntheticPoseFrame(0, 0, {}, { session_id: 's' }));
    await pending;
    expect(beforePause.bitmap.close).toHaveBeenCalledOnce();
    expect(messages()).toContainEqual(done(0));
    expect(mocks.offer).not.toHaveBeenCalled();
    expect(messages().filter((m) => m.type === 'pose')).toEqual([]);
    const fresh = syntheticPoseFrame(1, 100, {}, { session_id: 's' });
    mocks.detect.mockResolvedValueOnce(fresh);
    await send(image(1));
    expect(mocks.offer).toHaveBeenCalledWith(fresh, expect.any(Number));
    expect(messages().filter((m) => m.type === 'pose')).toEqual([expect.objectContaining({ frame: fresh })]);
    await send({ type: 'dispose' });
  });
  it('resolves core initialization after pose failure so the main-thread fallback can run', async () => {
    mocks.init.mockRejectedValueOnce(new Error('worker GPU unavailable'));
    await send(initMessage);
    expect(messages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', code: 'MODEL_UNAVAILABLE', recoverable: true }),
      expect.objectContaining({ type: 'ready', detector: false }),
      { type: 'ok', id: 1 },
    ]));
    expect(messages().find((message) => message.type === 'error')).not.toHaveProperty('id');
    expect(mocks.close).toHaveBeenCalledOnce();
    await send({ type: 'dispose' });
  });

  it('closes a detector initialized after unmount and never publishes stale ready', async () => {
    let resolve!: () => void;
    mocks.init.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const pending = send(initMessage);
    await send({ type: 'dispose' });
    resolve(); await pending;
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(messages()).toEqual([]);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('drops incoming images while inference is busy, and discards results after disposal', async () => {
    await send(initMessage);
    let resolve!: (frame: ReturnType<typeof syntheticPoseFrame>) => void;
    mocks.detect.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const first = image(0); const second = image(1); const third = image(2);
    const pending = send(first);
    await send(second); await send(third);
    expect(mocks.detect).toHaveBeenCalledOnce();
    expect(second.bitmap.close).toHaveBeenCalledOnce();
    expect(third.bitmap.close).toHaveBeenCalledOnce();
    expect(messages()).toContainEqual(done(1));
    expect(messages()).toContainEqual(done(2));
    expect(messages()).not.toContainEqual(done(0));
    await send({ type: 'dispose' });
    resolve(syntheticPoseFrame(0, 0)); await pending;
    expect(first.bitmap.close).toHaveBeenCalledOnce();
    expect(mocks.offer).not.toHaveBeenCalled();
    expect(messages().some((message) => message.type === 'pose')).toBe(false);
  });
});
