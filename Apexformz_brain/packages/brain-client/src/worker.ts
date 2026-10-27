/// <reference lib="webworker" />
/**
 * Brain worker entry point. Owns the pose detector (optional) and the
 * BrainRuntime. The main thread never runs inference or feature math.
 *
 * Usage (bundlers that support module workers):
 *   new Worker(new URL('@apexformz/brain-client/worker', import.meta.url), { type: 'module' })
 */
import { BrainError, CORE_VERSION, isBrainError, type PoseFrame } from '@apexformz/contracts';
import { BrainRuntime } from '@apexformz/runtime';
import { PoseDetectorBridge } from './pose_landmarker';
import { OnnxPoseBackend } from './onnx_pose_backend';
import { createOutboxStore, type OutboxStore } from './outbox_store';
import type { MainToWorker, WorkerToMain } from './protocol';
import { loadBrowserMovementModel, type LoadedMovementModel, type MovementModelLoadOptions } from './movement_model_loader';
import { InferenceWorkerUnavailable, remoteSessionFactory, type WorkerLike } from './remote_session';
import { loadReidEmbedder, type ReidEmbedder } from './reid';
import { openAnyOrtSession } from './movement_model_loader';
import { validateMovementModelConfig } from '@apexformz/analysis';
import { recognitionHierarchy } from './movement_detector';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let runtime: BrainRuntime | null = null;
let detector: PoseDetectorBridge | OnnxPoseBackend | null = null;
let inferenceWorkerFactory: (() => WorkerLike) | null = null;
let reid: ReidEmbedder | null = null;

async function loadReid(configUrl: string, wasmBase?: string): Promise<ReidEmbedder> {
  const opts = { ort_wasm_base_url: wasmBase };
  if (inferenceWorkerFactory) {
    try {
      return await loadReidEmbedder(configUrl, (bytes) => remoteSessionFactory(inferenceWorkerFactory!, 'any')(bytes, opts));
    } catch (error) {
      if (!(error instanceof InferenceWorkerUnavailable)) throw error;
    }
  }
  return loadReidEmbedder(configUrl, (bytes) => openAnyOrtSession(bytes, opts));
}
let movementInference: 'worker' | 'inline' = 'inline';
/** Where movement inference runs ('worker' when the dedicated inference worker is active). */
export function movementInferenceMode(): 'worker' | 'inline' {
  return movementInference;
}

/**
 * Run movement-model inference in a dedicated worker so pose tracking never waits for it. Call this from
 * the app's brain-worker entry (it owns the bundler-visible worker URL). Without a factory, or if the
 * worker cannot start, inference runs inline as before.
 */
export function setInferenceWorkerFactory(factory: (() => WorkerLike) | null): void {
  inferenceWorkerFactory = factory;
}

async function loadMovementModel(options: MovementModelLoadOptions): Promise<LoadedMovementModel> {
  if (inferenceWorkerFactory) {
    try {
      const model = await loadBrowserMovementModel(options, { createSession: remoteSessionFactory(inferenceWorkerFactory) });
      movementInference = 'worker';
      return model;
    } catch (error) {
      if (!(error instanceof InferenceWorkerUnavailable)) throw error; // integrity and config errors stay errors
    }
  }
  movementInference = 'inline';
  return loadBrowserMovementModel(options);
}
let lastState: string | null = null;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let outboxStore: OutboxStore | null = null;
let movementModels: LoadedMovementModel[] = [];
let latestMovementFrame: PoseFrame | null = null;
let loadingMovementModels = false;
let disposed = false;
let captureGeneration = 0;
let captureContext: string | null = null;
let initialized = false;
let initializing = false;
let detectingImage = false;
let hostClockOffsetMs = 0;

/** Lifecycle/arrival times use the capture host's origin; local durations stay local. */
const hostNow = () => performance.now() + hostClockOffsetMs;

function resetMovementHistory(endSession = false): void {
  captureGeneration++;
  latestMovementFrame = null;
  for (const model of movementModels) {
    if (endSession) model.detector.endSession();
    else model.detector.reset();
  }
}

function post(msg: WorkerToMain, transfer?: Transferable[]): void {
  if (disposed) return;
  ctx.postMessage(msg, transfer ?? []);
}

function fail(id: number | undefined, e: unknown): void {
  if (isBrainError(e)) post({ type: 'error', id, code: e.code, message: e.message, recoverable: e.recoverable });
  else post({ type: 'error', id, code: 'INTERNAL', message: (e as Error)?.message ?? String(e), recoverable: true });
}

function emitState(): void {
  if (!runtime) return;
  const s = runtime.sessionState;
  if (s !== lastState) {
    lastState = s;
    post({ type: 'state', state: s });
  }
}

/** Process whatever is in the latest-frame slot on the next macrotask; coalesces bursts. */
function scheduleTick(): void {
  if (tickTimer !== null) return;
  tickTimer = setTimeout(() => {
    tickTimer = null;
    if (!runtime) return;
    try {
      const tick = runtime.tick(hostNow());
      if (tick) {
        post({ type: 'tick', tick });
        const frame = latestMovementFrame;
        if (frame?.frame_id === tick.frame_id) for (const model of movementModels) {
          void model.detector.observe(frame, tick).then((detection) => {
            if (detection && !disposed) {
              post({ type: 'movement_detection', detection });
              runtime?.noteRecognition({
                timestamp_ms: detection.timestamp_ms, level: detection.level ?? (detection.unknown ? null : 'movement'),
                family_id: detection.family_id ?? null, group_id: detection.group_id ?? null, movement_id: detection.movement_id,
                probability: detection.level === 'family' ? detection.family_probability ?? null : detection.level === 'group' ? detection.group_probability ?? null : detection.probability,
                validated: detection.calibration_status === 'validated',
              });
            }
          }).catch((error) => fail(undefined, error));
        }
      }
      emitState();
    } catch (e) {
      fail(undefined, e);
    }
  }, 0);
}

ctx.onmessage = async (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  try {
    if (disposed) return;
    if (msg.type !== 'init' && msg.type !== 'dispose' && !initialized) {
      throw new Error('Brain worker initialization has not completed');
    }
    switch (msg.type) {
      case 'init': {
        if (initializing || initialized) throw new Error('Brain worker is already initialized');
        initializing = true;
        try {
          hostClockOffsetMs = 0;
          if (msg.host_time_origin_ms !== undefined) {
            if (!Number.isFinite(msg.host_time_origin_ms) || msg.host_time_origin_ms < 0 || !Number.isFinite(performance.timeOrigin)) {
              throw new BrainError('SCHEMA_INVALID', 'host_time_origin_ms must be a finite non-negative epoch timestamp and the worker must expose its time origin', { recoverable: false });
            }
            hostClockOffsetMs = performance.timeOrigin - msg.host_time_origin_ms;
          }
          outboxStore = msg.persist_outbox === false ? null : createOutboxStore();
          runtime = new BrainRuntime({ ...msg.config, ...(outboxStore ? { outbox_sink: outboxStore } : {}) }, hostNow);
          if (msg.detector) {
            const candidate = msg.detector.backend === 'onnx' && msg.detector.onnx
              ? new OnnxPoseBackend({ ...msg.detector.onnx, subject_roi: msg.detector.subject_roi ?? msg.detector.onnx.subject_roi })
              : new PoseDetectorBridge(msg.detector);
            try {
              await candidate.init();
              if (disposed) { candidate.close(); return; }
              detector = candidate;
              if (msg.detector.reid_config_url) {
                // appearance re-identification is optional: tap-to-pin still works on motion if it cannot load
                try {
                  const loaded = await loadReid(msg.detector.reid_config_url, msg.detector.reid_ort_wasm_base_url);
                  if (disposed) { await loaded.close(); return; }
                  reid = loaded;
                }
                catch (e) { post({ type: 'error', code: 'MODEL_UNAVAILABLE', message: `appearance re-identification unavailable: ${(e as Error).message}`, recoverable: true }); }
              }
            } catch (e) {
              candidate.close();
              // Detector failure is recoverable: resolve init so the host can start its main-thread fallback.
              post({ type: 'error', code: 'MODEL_UNAVAILABLE', message: `pose detector unavailable in worker: ${(e as Error).message}`, recoverable: true });
            }
          }
        } finally { initializing = false; }
        if (disposed) { detector?.close(); detector = null; return; }
        initialized = true;
        post({ type: 'ready', detector: detector?.ready ?? false, core_version: CORE_VERSION, pose_backend: detector ? (detector instanceof OnnxPoseBackend ? `onnx:${detector.provider ?? 'unknown'}` : 'mediapipe') : null });
        post({ type: 'ok', id: msg.id });
        break;
      }
      case 'install_packs': {
        if (!runtime) throw new Error('not initialised');
        const installed: string[] = [];
        for (const p of msg.packs) {
          const bundle = await runtime.installPack(p);
          runtime.activatePack(bundle.manifest.id, bundle.manifest.version);
          installed.push(`${bundle.manifest.id}@${bundle.manifest.version}`);
        }
        post({ type: 'ok', id: msg.id, result: installed });
        break;
      }
      case 'load_movement_models': {
        if (!runtime) throw new Error('not initialised');
        if (!['IDLE', 'READY', 'LOCAL_COMMITTED', 'SYNCED'].includes(runtime.sessionState) || loadingMovementModels) throw new Error('movement models may only load between sessions');
        if (msg.models.length > 2) throw new Error('at most one static and one dynamic movement model may be loaded');
        const configs = msg.models.map((m) => validateMovementModelConfig(m.config));
        const tasks = configs.map((c) => c.model_task ?? (c.input.window_frames === 1 ? 'static_pose' : 'dynamic_movement'));
        if (new Set(tasks).size !== tasks.length) throw new Error('duplicate movement model task');
        loadingMovementModels = true;
        const next: LoadedMovementModel[] = [];
        try {
          for (const options of msg.models) next.push(await loadMovementModel(options));
          if (disposed) throw new Error('worker disposed while loading movement models');
          const previous = movementModels;
          resetMovementHistory(true);
          movementModels = next;
          await Promise.allSettled(previous.map((m) => m.close()));
          post({ type: 'ok', id: msg.id, result: configs });
        } catch (error) {
          await Promise.allSettled(next.map((m) => m.close()));
          throw error;
        } finally { loadingMovementModels = false; }
        break;
      }
      case 'calibrate':
        runtime!.calibrate(msg.calibration, hostNow());
        emitState();
        post({ type: 'ok', id: msg.id });
        break;
      case 'start': {
        if (loadingMovementModels) throw new Error('wait for movement models to finish loading before starting');
        const sc = runtime!.start(msg.request, hostNow());
        detector?.resetTracking();
        captureGeneration++;
        latestMovementFrame = null;
        const hierarchy = recognitionHierarchy(sc.pack.movement_catalog.taxonomy);
        for (const model of movementModels) model.detector.startSession(msg.request.session_id, sc.pack.manifest.id, sc.movement.id, hierarchy, msg.request.calibration?.handedness ?? 'unknown');
        emitState();
        post({ type: 'ok', id: msg.id, result: { movement: sc.movement, phase_graph: sc.phase_graph, criteria: sc.criteria, pack: { id: sc.pack.manifest.id, version: sc.pack.manifest.version, display: sc.pack.manifest.display } } });
        break;
      }
      case 'pin_subject': {
        if (!detector) throw new Error('tap-to-pin needs the in-worker pose detector');
        const status = detector.pin(msg.point);
        resetMovementHistory();
        post({ type: 'ok', id: msg.id, result: status });
        break;
      }
      case 'pause':
        runtime!.pause(hostNow());
        detector?.resetTracking();
        resetMovementHistory();
        emitState();
        post({ type: 'ok', id: msg.id });
        break;
      case 'resume':
        runtime!.resume(hostNow());
        detector?.resetTracking();
        resetMovementHistory();
        emitState();
        post({ type: 'ok', id: msg.id });
        break;
      case 'complete': {
        const summary = runtime!.complete(hostNow());
        resetMovementHistory(true);
        emitState();
        post({ type: 'summary', id: msg.id, summary });
        break;
      }
      case 'equipment_frame':
        runtime!.noteEquipment(msg.frame);
        post({ type: 'ok', id: msg.id });
        break;
      case 'pose_frame':
        if (msg.equipment) runtime!.noteEquipment(msg.equipment);
        latestMovementFrame = msg.frame;
        runtime?.offer(msg.frame, hostNow());
        scheduleTick();
        break;
      case 'image': {
        const t0 = performance.now();
        const nextContext = JSON.stringify([msg.session_id, msg.camera_id, msg.mirror, msg.orientation]);
        if (captureContext !== null && captureContext !== nextContext) {
          detector?.resetTracking();
          resetMovementHistory();
        }
        captureContext = nextContext;
        const generation = captureGeneration;
        let ownsDetection = false;
        try {
          if (!detector?.ready || !runtime || detectingImage) return;
          detectingImage = true;
          ownsDetection = true;
          const frame = await detector.detect(msg.bitmap, {
            session_id: msg.session_id,
            frame_id: msg.frame_id,
            timestamp_ms: msg.timestamp_ms,
            camera_id: msg.camera_id,
            image_size: [msg.bitmap.width, msg.bitmap.height],
            mirror: msg.mirror,
            orientation: msg.orientation,
          });
          if (frame && generation === captureGeneration && !disposed) {
            post({ type: 'pose', frame, latency_ms: performance.now() - t0 });
          // appearance re-identification for tap-to-pin: crop now (the frame is released after this message),
          // embed off-thread, feed back to the tracker; skipped while the embedder is busy
          const appearance = reid && !reid.busy ? detector.appearanceRequest() : null;
          if (appearance && reid) {
            const crops = reid.crop(msg.bitmap, appearance.boxes);
            const target = detector;
            if (crops) {
              void reid.embed(crops.batch, crops.kept.length).then((embeddings) => {
                const byBox: Float32Array[] = [];
                crops.kept.forEach((k, j) => { byBox[k] = embeddings[j]; });
                if (!disposed && detector === target && generation === captureGeneration) target.provideAppearance(appearance, byBox);
              }).catch(() => undefined);
            }
          }
            runtime.offer(frame, hostNow());
            latestMovementFrame = frame;
            scheduleTick();
          }
        } finally {
          if (ownsDetection) detectingImage = false;
        }
        break;
      }
      case 'drain_outbox':
        post({ type: 'outbox', id: msg.id, events: runtime?.drainOutbox(msg.max ?? 200) ?? [] });
        break;
      case 'recover_outbox': {
        // Events persisted by earlier sessions that were never acknowledged (tab closed, crash, offline).
        const current = runtime?.sessionId ?? null; // null when no session is active
        const persisted = outboxStore ? await outboxStore.all() : [];
        post({ type: 'outbox', id: msg.id, events: persisted.filter((e) => e.session_id !== current) });
        break;
      }
      case 'ack_outbox':
        runtime?.ackOutbox(msg.event_ids);
        outboxStore?.remove(msg.event_ids); // idempotent; covers recovered events of other sessions
        break;
      case 'heartbeat':
        runtime?.heartbeat(hostNow());
        if (runtime?.sessionState !== 'ACTIVE') resetMovementHistory();
        emitState();
        break;
      case 'ack_feedback':
        // Policy ack is session-internal; exposed for future use.
        break;
      case 'dispose':
        disposed = true;
        initialized = false;
        if (tickTimer !== null) clearTimeout(tickTimer);
        tickTimer = null;
        resetMovementHistory(true);
        await Promise.allSettled(movementModels.map((m) => m.close()));
        movementModels = [];
        detector?.close();
        void reid?.close();
        reid = null;
        detector = null;
        runtime = null;
        ctx.close();
        break;
    }
  } catch (e) {
    fail('id' in msg ? (msg as { id?: number }).id : undefined, e);
  } finally {
    if (msg.type === 'image') {
      try { msg.bitmap.close(); }
      finally { post({ type: 'image_done', image_id: msg.image_id, frame_id: msg.frame_id, session_id: msg.session_id }); }
    }
  }
};
