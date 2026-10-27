import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainTick } from '@apexformz/runtime';
import type { EventEnvelope, PoseFrame, SessionStartRequest } from '@apexformz/contracts';
import type { MovementDetection } from '@apexformz/analysis';
import type { MainToWorker, WorkerToMain } from '../protocol';
import { useApexBrain, type UseApexBrainOptions } from './useApexBrain';

// Exercise the hook's event wiring with the actual BrainClient, without a DOM
// renderer. State updates are rendered explicitly; its one mount effect runs once.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as Array<() => void | (() => void)> }));
vi.mock('react', () => ({
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    return (hooks.cells[index] ??= { current: initial });
  },
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = initial;
    return [hooks.cells[index], (next: unknown) => {
      hooks.cells[index] = typeof next === 'function' ? next(hooks.cells[index]) : next;
    }];
  },
  useEffect: (effect: () => void | (() => void)) => {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) { hooks.cells[index] = true; hooks.effects.push(effect); }
  },
  useCallback: (callback: unknown) => callback,
}));

class ControlledWorker {
  onmessage: ((event: MessageEvent<WorkerToMain>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: MainToWorker[] = [];
  postMessage = vi.fn((message: MainToWorker) => { this.messages.push(message); });
  terminate = vi.fn();
  send(message: WorkerToMain) { this.onmessage?.({ data: message } as MessageEvent<WorkerToMain>); }
  reply(type: MainToWorker['type'], result?: unknown) {
    const request = [...this.messages].reverse().find((message) => message.type === type);
    if (!request || !('id' in request)) throw new Error(`Missing ${type} request`);
    this.send({ type: 'ok', id: request.id, result });
  }
}

let cleanup: (() => void) | undefined;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function mount(overrides: Partial<UseApexBrainOptions> = {}) {
  const worker = new ControlledWorker();
  const onError = vi.fn();
  const options: UseApexBrainOptions = { createWorker: () => worker as unknown as Worker, config: {}, packs: [], onError, ...overrides };
  const render = () => { hooks.cursor = 0; return useApexBrain(options); };
  render();
  cleanup = hooks.effects.shift()!() as (() => void);
  return { worker, render, onError };
}
async function initialize(worker: ControlledWorker, detector = true) {
  worker.send({ type: 'ready', detector, core_version: '1.0.0' });
  worker.reply('init');
  await flush();
  worker.reply('install_packs', []);
  await flush();
}

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; });
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); });

describe('Brain React host failures', () => {
  it('keeps offline initialization local and recovers older evidence when a later backend-backed session starts', async () => {
    let online = false;
    const postEvents = vi.fn().mockResolvedValue({ accepted: ['event-old'], duplicates: [], rejected: [] });
    const { worker, render } = mount({ sync: { transport: { postEvents }, online: () => online } });
    await initialize(worker);
    expect(render().ready).toBe(true);
    expect(worker.messages.some((message) => message.type === 'recover_outbox')).toBe(false);
    expect(postEvents).not.toHaveBeenCalled();

    online = true;
    const start = render().start({ session_id: 'new-session' } as SessionStartRequest);
    await flush(); worker.reply('start', {}); await start;
    const recovery = worker.messages.find((message) => message.type === 'recover_outbox')!;
    expect(recovery).toBeDefined();
    const event = { session_id: 'older-session', event_id: 'event-old', sequence: 1, monotonic_ms: 4 } as EventEnvelope;
    worker.send({ type: 'outbox', id: (recovery as { id: number }).id, events: [event] });
    await flush();
    expect(postEvents).toHaveBeenCalledExactlyOnceWith('older-session', [event]);
    expect(worker.messages).toContainEqual({ type: 'ack_outbox', event_ids: ['event-old'] });
  });

  it('rechecks online state before transport if the host goes offline while persisted events are read', async () => {
    let online = true;
    const postEvents = vi.fn();
    const { worker } = mount({ sync: { transport: { postEvents }, online: () => online } });
    await initialize(worker);
    const recovery = worker.messages.find((message) => message.type === 'recover_outbox')!;
    expect(recovery).toBeDefined();
    online = false;
    const event = { session_id: 'older-session', event_id: 'event-old', sequence: 1, monotonic_ms: 4 } as EventEnvelope;
    worker.send({ type: 'outbox', id: (recovery as { id: number }).id, events: [event] });
    await flush();
    expect(postEvents).not.toHaveBeenCalled();
    expect(worker.messages.some((message) => message.type === 'ack_outbox')).toBe(false);
  });

  it('uses the browser online state when a generic host has no online predicate', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const postEvents = vi.fn();
    const { worker, render } = mount({ sync: { transport: { postEvents } } });
    await initialize(worker);
    expect(worker.messages.some((message) => message.type === 'recover_outbox')).toBe(false);
    expect(postEvents).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true });
    const start = render().start({ session_id: 'online-session' } as SessionStartRequest);
    await flush(); worker.reply('start', {}); await start;
    expect(worker.messages.filter((message) => message.type === 'recover_outbox')).toHaveLength(1);
  });

  it('invalidates readiness and live evidence after a fatal worker error, and ignores late outputs', async () => {
    const { worker, render, onError } = mount();
    await initialize(worker);
    worker.send({ type: 'state', state: 'ACTIVE' });
    worker.send({ type: 'tick', tick: { frame_id: 1 } as BrainTick });
    worker.send({ type: 'pose', frame: { frame_id: 1 } as PoseFrame, latency_ms: 4 });
    worker.send({ type: 'movement_detection', detection: { model_task: 'static_pose', frame_id: 1 } as MovementDetection });
    expect(render()).toMatchObject({ ready: true, detectorReady: true, sessionState: 'ACTIVE', tick: { frame_id: 1 }, lastPose: { frame_id: 1 } });

    worker.onerror!({ message: 'worker process crashed' } as ErrorEvent);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(render()).toMatchObject({ ready: false, detectorReady: false, sessionState: 'FAILED', tick: null,
      lastPose: null, movementDetection: null, movementDetections: {}, startInfo: null,
      error: { code: 'INTERNAL', message: 'worker process crashed' } });
    worker.send({ type: 'ready', detector: true, core_version: '1.0.0' });
    worker.send({ type: 'state', state: 'ACTIVE' });
    worker.send({ type: 'tick', tick: { frame_id: 2 } as BrainTick });
    worker.send({ type: 'pose', frame: { frame_id: 2 } as PoseFrame, latency_ms: 4 });
    worker.send({ type: 'movement_detection', detection: { model_task: 'static_pose', frame_id: 2 } as MovementDetection });
    expect(render()).toMatchObject({ ready: false, detectorReady: false, sessionState: 'FAILED', tick: null,
      lastPose: null, movementDetection: null, movementDetections: {} });
    expect(onError).toHaveBeenCalledExactlyOnceWith({ code: 'INTERNAL', message: 'worker process crashed', recoverable: false });
    cleanup?.(); cleanup = undefined;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('keeps the core ready for the main-thread fallback after a recoverable worker detector failure', async () => {
    const { worker, render, onError } = mount();
    worker.send({ type: 'error', code: 'MODEL_UNAVAILABLE', message: 'worker GPU unavailable', recoverable: true });
    await initialize(worker, false);
    expect(render()).toMatchObject({ ready: true, detectorReady: false, sessionState: 'IDLE',
      error: { code: 'MODEL_UNAVAILABLE', message: 'worker GPU unavailable' } });
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ recoverable: true }));
  });

  it('keeps optional movement model rejection recoverable', async () => {
    const { worker, render } = mount({ movement_models: [{ config: {} } as never] });
    await initialize(worker);
    const request = worker.messages.find((message) => message.type === 'load_movement_models')!;
    expect(request).toBeDefined();
    worker.send({ type: 'error', id: (request as { id: number }).id, code: 'MODEL_UNAVAILABLE', message: 'optional model missing', recoverable: true });
    await flush();
    expect(render()).toMatchObject({ ready: true, detectorReady: true, sessionState: 'IDLE',
      error: { code: 'MODEL_UNAVAILABLE', message: 'optional model missing' } });
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('cannot publish ready when pending pack fetching finishes after a fatal error', async () => {
    let resolvePacks!: (packs: []) => void;
    const packs = new Promise<[]>((resolve) => { resolvePacks = resolve; });
    const { worker, render } = mount({ packs: () => packs });
    worker.send({ type: 'ready', detector: true, core_version: '1.0.0' });
    worker.reply('init');
    await flush();
    worker.onerror!({ message: 'worker terminated during setup' } as ErrorEvent);
    resolvePacks([]);
    await flush();
    expect(worker.messages.some((message) => message.type === 'install_packs')).toBe(false);
    expect(render()).toMatchObject({ ready: false, detectorReady: false, sessionState: 'FAILED' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
