import type { Calibration, EquipmentMeasurementFrame, EventEnvelope, PoseFrame, SessionStartRequest, SessionState, SportPackManifest } from '@apexformz/contracts';
import type { BrainRuntimeConfig, BrainTick, SessionSummary } from '@apexformz/runtime';
import type { SportPackInput } from '@apexformz/sport-runtime';
import type { MainToWorker, PoseDetectorOptions, WorkerToMain } from './protocol';
import type { MovementDetection, MovementModelConfig } from '@apexformz/analysis';
import type { MovementModelLoadOptions } from './movement_model_loader';
import type { PinStatus } from '@apexformz/perception';

export interface BrainClientEvents {
  tick: (tick: BrainTick) => void;
  pose: (frame: PoseFrame, latencyMs: number) => void;
  state: (state: SessionState) => void;
  error: (e: { code: string; message: string; recoverable: boolean }) => void;
  ready: (info: { detector: boolean; core_version: string; pose_backend?: string | null }) => void;
  movement_detection: (detection: MovementDetection) => void;
}

type Listener<K extends keyof BrainClientEvents> = BrainClientEvents[K];

export interface StartResult {
  movement: unknown;
  phase_graph: unknown;
  criteria: unknown[];
  pack: { id: string; version: string; display: SportPackManifest['display'] };
}

/**
 * Host-side handle to the Brain worker. Framework agnostic; the React hook
 * wraps this. The host supplies the Worker instance so bundler-specific
 * worker URL handling stays in the app.
 */
export class BrainClient {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private listeners: { [K in keyof BrainClientEvents]: Set<Listener<K>> } = { tick: new Set(), pose: new Set(), state: new Set(), error: new Set(), ready: new Set(), movement_detection: new Set() };
  private frameSeq = 0;
  private imageSeq = 0;
  private inFlightImageId: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private workerFailure: Error | null = null;
  private initialization: Promise<void> | null = null;
  private movementLoad: Promise<MovementModelConfig[]> | null = null;
  readonly detectorInWorker: boolean;

  constructor(private readonly worker: Worker, options: { detector_in_worker?: boolean } = {}) {
    this.detectorInWorker = options.detector_in_worker ?? false;
    worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.onMessage(ev.data);
    worker.onerror = (ev) => {
      this.workerFailure = new Error(ev.message || 'Brain worker failed');
      this.inFlightImageId = null;
      for (const pending of this.pending.values()) pending.reject(this.workerFailure);
      this.pending.clear();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.emit('error', { code: 'INTERNAL', message: this.workerFailure.message, recoverable: false });
    };
  }

  on<K extends keyof BrainClientEvents>(event: K, fn: Listener<K>): () => void {
    (this.listeners[event] as Set<Listener<K>>).add(fn);
    return () => (this.listeners[event] as Set<Listener<K>>).delete(fn);
  }

  private emit<K extends keyof BrainClientEvents>(event: K, ...args: Parameters<Listener<K>>): void {
    if (this.disposed) return;
    for (const fn of this.listeners[event] as Set<(...a: unknown[]) => void>) fn(...args);
  }

  private request<T = unknown>(build: (id: number) => MainToWorker, transfer?: Transferable[]): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Brain client is disposed'));
    if (this.workerFailure) return Promise.reject(this.workerFailure);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try { this.worker.postMessage(build(id), transfer ?? []); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  private onMessage(msg: WorkerToMain): void {
    if (this.disposed) return;
    switch (msg.type) {
      case 'ready':
        this.emit('ready', { detector: msg.detector, core_version: msg.core_version, pose_backend: msg.pose_backend });
        break;
      case 'ok':
        this.pending.get(msg.id)?.resolve(msg.result);
        this.pending.delete(msg.id);
        break;
      case 'outbox':
        this.pending.get(msg.id)?.resolve(msg.events);
        this.pending.delete(msg.id);
        break;
      case 'summary':
        this.pending.get(msg.id)?.resolve(msg.summary);
        this.pending.delete(msg.id);
        break;
      case 'error':
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!.reject(Object.assign(new Error(msg.message), { code: msg.code, recoverable: msg.recoverable }));
          this.pending.delete(msg.id);
        } else {
          this.emit('error', { code: msg.code, message: msg.message, recoverable: msg.recoverable });
        }
        break;
      case 'tick':
        this.emit('tick', msg.tick);
        break;
      case 'movement_detection':
        this.emit('movement_detection', msg.detection);
        break;
      case 'pose':
        this.emit('pose', msg.frame, msg.latency_ms);
        break;
      case 'image_done':
        if (msg.image_id === this.inFlightImageId) this.inFlightImageId = null;
        break;
      case 'state':
        this.emit('state', msg.state);
        break;
    }
  }

  init(config: Partial<BrainRuntimeConfig>, detector?: PoseDetectorOptions): Promise<void> {
    if (!this.initialization) this.initialization = this.request((id) => ({ type: 'init', id, config, host_time_origin_ms: performance.timeOrigin, detector: this.detectorInWorker ? detector : undefined }));
    return this.initialization;
  }

  private async waitForInitialization(): Promise<void> {
    if (!this.initialization) throw new Error('Initialize the Brain client first');
    await this.initialization;
    if (this.disposed) throw new Error('Brain client is disposed');
  }

  async installPacks(packs: SportPackInput[]): Promise<string[]> {
    await this.waitForInitialization();
    return this.request<string[]>((id) => ({ type: 'install_packs', id, packs }));
  }

  /** Replace movement models between sessions. Static and dynamic models remain separate. */
  loadMovementModels(models: MovementModelLoadOptions[]): Promise<MovementModelConfig[]> {
    if (this.movementLoad) return Promise.reject(new Error('Movement models are already loading'));
    const operation = (async () => {
      await this.waitForInitialization();
      return this.request<MovementModelConfig[]>((id) => ({ type: 'load_movement_models', id, models }));
    })().finally(() => { if (this.movementLoad === operation) this.movementLoad = null; });
    this.movementLoad = operation;
    return operation;
  }

  loadMovementModel(model: MovementModelLoadOptions): Promise<MovementModelConfig[]> {
    return this.loadMovementModels([model]);
  }

  async calibrate(calibration: Calibration): Promise<void> {
    await this.waitForInitialization();
    return this.request((id) => ({ type: 'calibrate', id, calibration }));
  }

  async start(request: SessionStartRequest): Promise<StartResult> {
    await this.waitForInitialization();
    if (this.movementLoad) await this.movementLoad;
    const res = await this.request<StartResult>((id) => ({ type: 'start', id, request }));
    if (this.disposed) throw new Error('Brain client is disposed');
    this.frameSeq = 0;
    if (!this.heartbeatTimer) this.heartbeatTimer = setInterval(() => this.worker.postMessage({ type: 'heartbeat', now_ms: performance.now() } as MainToWorker), 1000);
    return res;
  }

  pause(): Promise<void> {
    return this.request((id) => ({ type: 'pause', id }));
  }

  resume(): Promise<void> {
    return this.request((id) => ({ type: 'resume', id }));
  }

  async complete(): Promise<SessionSummary> {
    const s = await this.request<SessionSummary>((id) => ({ type: 'complete', id }));
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    return s;
  }

  /** Feed a PoseFrame produced on the main thread (e.g. by the legacy Holistic hook). */
  offerPoseFrame(frame: PoseFrame, equipment?: EquipmentMeasurementFrame): void {
    if (this.disposed || this.workerFailure) return;
    this.worker.postMessage({ type: 'pose_frame', frame, ...(equipment ? { equipment } : {}) } as MainToWorker);
  }

  /** Await this before offering its matching pose, or pass evidence atomically to offerPoseFrame. */
  async offerEquipmentFrame(frame: EquipmentMeasurementFrame): Promise<void> {
    await this.waitForInitialization();
    return this.request((id) => ({ type: 'equipment_frame', id, frame }));
  }

  /** Transfer at most one image at a time; close newer captures until its completion ack. */
  offerImage(bitmap: ImageBitmap, meta: { session_id: string; timestamp_ms: number; camera_id: string; mirror: boolean; orientation: PoseFrame['orientation'] }): void {
    if (this.disposed || this.workerFailure || this.inFlightImageId !== null) { bitmap.close(); return; }
    const imageId = this.imageSeq++;
    const msg: MainToWorker = { type: 'image', image_id: imageId, bitmap, frame_id: this.frameSeq++, ...meta };
    this.inFlightImageId = imageId;
    try { this.worker.postMessage(msg, [bitmap]); }
    catch (error) {
      if (this.inFlightImageId === imageId) this.inFlightImageId = null;
      bitmap.close();
      throw error;
    }
  }

  /** Tap-to-pin: follow the person under a normalized raw-camera point (un-mirror display taps first); null unpins. */
  pinSubject(point: { x: number; y: number } | null): Promise<PinStatus> {
    return this.request<PinStatus>((id) => ({ type: 'pin_subject', id, point }));
  }

  nextFrameId(): number {
    return this.frameSeq++;
  }

  drainOutbox(max = 200): Promise<EventEnvelope[]> {
    return this.request<EventEnvelope[]>((id) => ({ type: 'drain_outbox', id, max }));
  }

  /** Unacknowledged events persisted by earlier sessions (see `recoverPersistedOutbox`). */
  recoverOutbox(): Promise<EventEnvelope[]> {
    return this.request<EventEnvelope[]>((id) => ({ type: 'recover_outbox', id }));
  }

  ackOutbox(eventIds: string[]): void {
    if (this.disposed) return;
    this.worker.postMessage({ type: 'ack_outbox', event_ids: eventIds } as MainToWorker);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inFlightImageId = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const pending of this.pending.values()) pending.reject(new Error('Brain client is disposed'));
    this.pending.clear();
    for (const listeners of Object.values(this.listeners)) listeners.clear();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    try { this.worker.postMessage({ type: 'dispose' } as MainToWorker); }
    catch { /* An already terminated worker still needs local request cleanup. */ }
    finally { this.worker.terminate(); }
  }
}

/** Fetch a sport pack (manifest + assets) from the backend manifest endpoint. */
export async function fetchSportPack(baseUrl: string, sportId: string, fetchImpl: typeof fetch = fetch, headers: Record<string, string> = {}): Promise<SportPackInput> {
  const mRes = await fetchImpl(`${baseUrl}/sport-packs/${sportId}/manifest`, { headers });
  if (!mRes.ok) throw new Error(`manifest fetch failed: ${mRes.status}`);
  const manifest = (await mRes.json()) as SportPackManifest;
  const paths = new Set<string>([manifest.game_rules, manifest.court_geometry, manifest.equipment_catalog, manifest.movements, manifest.phase_graphs, manifest.technique_rubrics, manifest.feedback_templates, manifest.provenance]);
  for (const m of manifest.models) if (m.format === 'json') paths.add(m.path);
  const assets: Record<string, string> = {};
  await Promise.all([...paths].map(async (p) => {
    const r = await fetchImpl(`${baseUrl}/sport-packs/${sportId}/assets/${encodeURIComponent(p)}`, { headers });
    if (!r.ok) throw new Error(`asset ${p} fetch failed: ${r.status}`);
    assets[p] = await r.text();
  }));
  return { manifest, assets };
}
