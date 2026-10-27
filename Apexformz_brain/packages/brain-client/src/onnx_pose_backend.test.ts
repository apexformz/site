import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeLetterbox, decodeRtmo, decodeSimcc, OnnxPoseBackend, pixelsToTensor, unletterbox } from './onnx_pose_backend';

const ortMock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('onnxruntime-web', () => ({
  InferenceSession: { create: ortMock.create },
  Tensor: class {}, env: { wasm: {} },
}));

afterEach(() => { vi.unstubAllGlobals(); ortMock.create.mockReset(); });

function fakeCanvas() {
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() {
      return { fillStyle: '', fillRect() {}, drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(4 * 4 * 4) }) };
    }
  });
}

function rtmoResult(cx = 0.5) {
  const keypoints = new Float32Array(17 * 3);
  for (let k = 0; k < 17; k++) {
    keypoints[k * 3] = 4 * (cx + (k % 2 ? 0.04 : -0.04));
    keypoints[k * 3 + 1] = 4 * (0.25 + k / 32);
    keypoints[k * 3 + 2] = 0.95;
  }
  return { dets: { data: Float32Array.of(0, 0, 4, 4, 0.95), dims: [1, 1, 5] },
    keypoints: { data: keypoints, dims: [1, 1, 17, 3] } };
}

const options = { model_url: '/rtmo.onnx', model_kind: 'rtmo' as const, keypoint_set: 'coco_17' as const,
  input_size: [4, 4] as [number, number], execution_providers: ['wasm'] as ('wasm')[] };
const frameMeta = (frame_id: number) => ({ session_id: 's', camera_id: 'c', frame_id, timestamp_ms: frame_id * 100,
  image_size: [4, 4] as [number, number], mirror: false, orientation: 'landscape' as const });

describe('ONNX pose asynchronous lifecycle', () => {
  it.each(['pin', 'unpin', 'reset', 'close'] as const)('rejects a delayed inference before tracker mutation after %s', async (boundary) => {
    fakeCanvas();
    const run = vi.fn().mockResolvedValue(rtmoResult());
    const release = vi.fn().mockResolvedValue(undefined);
    ortMock.create.mockResolvedValue({ inputNames: ['input'], outputNames: ['dets', 'keypoints'], run, release });
    const backend = new OnnxPoseBackend(options);
    await backend.init();
    backend.pin({ x: .5, y: .5 });
    await backend.detect({} as ImageBitmap, frameMeta(1));
    expect(backend.pinStatus.state).toBe('tracking');
    let finish!: (result: ReturnType<typeof rtmoResult>) => void;
    run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = backend.detect({} as ImageBitmap, frameMeta(2));
    if (boundary === 'pin') backend.pin({ x: .5, y: .5 });
    else if (boundary === 'unpin') backend.pin(null);
    else if (boundary === 'reset') backend.resetTracking();
    else await backend.close();
    const statusAtBoundary = backend.pinStatus;
    finish(rtmoResult());
    expect(await pending).toBeNull();
    expect(backend.pinStatus).toEqual(statusAtBoundary);
    if (boundary === 'pin') {
      // The old capture must not consume the pending pin. Only a fresh capture does.
      const frame = await backend.detect({} as ImageBitmap, frameMeta(3));
      expect(frame?.quality.track_changed).toBe(true);
      expect(backend.pinStatus.subject_id).toBe('pinned-2');
    } else if (boundary === 'reset') {
      expect((await backend.detect({} as ImageBitmap, frameMeta(3)))?.tracked_subject_id).toBe('pinned-1');
      expect(backend.pinStatus.state).toBe('tracking');
    }
    if (boundary !== 'close') await backend.close();
  });

  it('releases a session whose initialization finishes after close without reviving the backend', async () => {
    fakeCanvas();
    let finish!: (session: unknown) => void;
    ortMock.create.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const backend = new OnnxPoseBackend(options);
    const pending = backend.init();
    await vi.waitFor(() => expect(ortMock.create).toHaveBeenCalledOnce());
    await backend.close();
    const release = vi.fn().mockResolvedValue(undefined);
    finish({ inputNames: ['input'], outputNames: ['dets', 'keypoints'], run: vi.fn(), release });
    await pending;
    expect(release).toHaveBeenCalledOnce();
    expect(backend.ready).toBe(false);
    expect(ortMock.create).toHaveBeenCalledOnce();
  });
});

describe('ONNX pose decoders', () => {
  it('letterbox preserves aspect and round-trips coordinates', () => {
    const lb = computeLetterbox(1280, 720, 640, 640);
    expect(lb.scale).toBeCloseTo(0.5, 9);
    expect(lb.pad_x).toBe(0);
    expect(lb.pad_y).toBe((640 - 360) / 2);
    const [nx, ny] = unletterbox(320, 140 + 180, lb);
    expect(nx).toBeCloseTo(0.5, 9);
    expect(ny).toBeCloseTo(0.5, 9);
  });

  it('decodes RTMO detections and keypoints sorted by score above threshold', () => {
    const lb = computeLetterbox(640, 640, 640, 640);
    const dets = new Float32Array([100, 100, 300, 500, 0.9, 10, 10, 20, 20, 0.1]);
    const kpts = new Float32Array(2 * 17 * 3);
    for (let k = 0; k < 17; k++) {
      kpts[k * 3] = 200;
      kpts[k * 3 + 1] = 64 * (k / 16) + 100;
      kpts[k * 3 + 2] = 0.8;
    }
    const persons = decodeRtmo({ dets, keypoints: kpts, num: 2, num_keypoints: 17 }, lb, 0.3);
    expect(persons).toHaveLength(1);
    expect(persons[0].keypoints[0].x).toBeCloseTo(200 / 640, 9);
    expect(persons[0].box[2]).toBeCloseTo(300 / 640, 9);
  });

  it('decodes SimCC argmax with split ratio and returns min(x,y) confidence', () => {
    const lb = computeLetterbox(192, 256, 192, 256);
    const K = 2;
    const sx = new Float32Array(K * 384);
    const sy = new Float32Array(K * 512);
    sx[0 * 384 + 100] = 0.9; // kp0 x = 100/2 = 50 px
    sy[0 * 512 + 300] = 0.7; // kp0 y = 150 px
    sx[1 * 384 + 10] = 0.2;
    sy[1 * 512 + 20] = 0.1;
    const kps = decodeSimcc(sx, sy, K, 2.0, lb);
    expect(kps[0].x).toBeCloseTo(50 / 192, 9);
    expect(kps[0].y).toBeCloseTo(150 / 256, 9);
    expect(kps[0].score).toBeCloseTo(0.7, 5);
    expect(kps[1].score).toBeCloseTo(0.1, 5);
  });

  it('normalises pixels into NCHW with the requested channel order', () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    const t = pixelsToTensor(rgba, 2, 1, { color_order: 'bgr', mean: [0, 0, 0], std: [1, 1, 1] });
    expect(Array.from(t)).toEqual([30, 60, 20, 50, 10, 40]);
    const r = pixelsToTensor(rgba, 2, 1, { color_order: 'rgb', mean: [10, 10, 10], std: [2, 2, 2] });
    expect(Array.from(r)).toEqual([0, 15, 5, 20, 10, 25]);
  });
});
