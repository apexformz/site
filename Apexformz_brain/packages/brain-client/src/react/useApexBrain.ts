import { useCallback, useEffect, useRef, useState } from 'react';
import type { Calibration, PoseFrame, SessionStartRequest, SessionState } from '@apexformz/contracts';
import type { BrainRuntimeConfig, BrainTick, SessionSummary } from '@apexformz/runtime';
import type { SportPackInput } from '@apexformz/sport-runtime';
import { BrainClient, type StartResult } from '../client';
import type { PoseDetectorOptions } from '../protocol';
import { OutboxSyncer, recoverPersistedOutbox, type SyncTransport } from '../sync';
import type { MovementDetection } from '@apexformz/analysis';
import type { MovementModelLoadOptions } from '../movement_model_loader';

export interface UseApexBrainOptions {
  /** Factory so the host controls bundler-specific worker URLs. */
  createWorker: () => Worker;
  config: Partial<BrainRuntimeConfig>;
  detector?: PoseDetectorOptions;
  detector_in_worker?: boolean;
  movement_model?: MovementModelLoadOptions;
  movement_models?: MovementModelLoadOptions[];
  /** Packs to install (already fetched). */
  packs: SportPackInput[] | (() => Promise<SportPackInput[]>);
  /** Optional cloud sync of the event outbox. */
  sync?: { transport: SyncTransport; interval_ms?: number; online?: () => boolean };
  onError?: (e: { code: string; message: string; recoverable: boolean }) => void;
}

export interface ApexBrainHandle {
  ready: boolean;
  detectorReady: boolean;
  sessionState: SessionState;
  tick: BrainTick | null;
  lastPose: PoseFrame | null;
  movementDetection: MovementDetection | null;
  movementDetections: Partial<Record<'static_pose' | 'dynamic_movement', MovementDetection>>;
  error: { code: string; message: string } | null;
  startInfo: StartResult | null;
  calibrate: (c: Calibration) => Promise<void>;
  start: (req: SessionStartRequest) => Promise<StartResult>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  complete: () => Promise<SessionSummary>;
  offerPoseFrame: (frame: PoseFrame) => void;
  offerImage: BrainClient['offerImage'];
  nextFrameId: () => number;
  /** Tap-to-pin: normalized raw-camera point (un-mirrored); null unpins. Resolves with the pin status. */
  pinSubject: BrainClient['pinSubject'];
  client: BrainClient | null;
}

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const syncOnline = (sync: NonNullable<UseApexBrainOptions['sync']>) => sync.online ? sync.online() : browserOnline();

/**
 * React hook over BrainClient: initialises the worker, installs packs, wires
 * ticks/state/errors into React state and (optionally) runs outbox sync.
 */
export function useApexBrain(opts: UseApexBrainOptions): ApexBrainHandle {
  const clientRef = useRef<BrainClient | null>(null);
  const syncerRef = useRef<OutboxSyncer | null>(null);
  const [ready, setReady] = useState(false);
  const [detectorReady, setDetectorReady] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState>('IDLE');
  const [tick, setTick] = useState<BrainTick | null>(null);
  const [lastPose, setLastPose] = useState<PoseFrame | null>(null);
  const [movementDetection, setMovementDetection] = useState<MovementDetection | null>(null);
  const [movementDetections, setMovementDetections] = useState<Partial<Record<'static_pose' | 'dynamic_movement', MovementDetection>>>({});
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [startInfo, setStartInfo] = useState<StartResult | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const recoveryRef = useRef<Promise<unknown> | null>(null);
  const recoverWhenOnline = useCallback((client: BrainClient) => {
    const sync = optsRef.current.sync;
    if (!sync || !syncOnline(sync) || recoveryRef.current) return;
    const operation = recoverPersistedOutbox(client, {
      postEvents: (sessionId, events) => {
        // The host can go offline while the worker is reading persisted events.
        if (clientRef.current !== client || !syncOnline(sync)) return Promise.reject(new Error('Persisted recovery is offline'));
        return sync.transport.postEvents(sessionId, events);
      },
    }).catch(() => undefined).finally(() => {
      if (recoveryRef.current === operation) recoveryRef.current = null;
    });
    recoveryRef.current = operation;
  }, []);

  useEffect(() => {
    let disposed = false;
    let failed = false;
    const client = new BrainClient(opts.createWorker(), { detector_in_worker: opts.detector_in_worker });
    clientRef.current = client;
    const reportError = (e: { code: string; message: string; recoverable: boolean }) => {
      if (disposed || failed) return;
      setError({ code: e.code, message: e.message });
      if (!e.recoverable) {
        failed = true;
        setReady(false);
        setDetectorReady(false);
        setSessionState('FAILED');
        setTick(null);
        setLastPose(null);
        setMovementDetection(null);
        setMovementDetections({});
        setStartInfo(null);
        syncerRef.current?.stop();
        client.dispose();
      }
      optsRef.current.onError?.(e);
    };
    const offs = [
      client.on('tick', (t) => { if (!failed) setTick(t); }),
      client.on('pose', (f) => { if (!failed) setLastPose(f); }),
      client.on('state', (s) => {
        if (failed) return;
        setSessionState(s);
        if (s !== 'ACTIVE') { setMovementDetection(null); setMovementDetections({}); }
      }),
      client.on('movement_detection', (d) => {
        if (failed) return;
        setMovementDetection(d);
        setMovementDetections((previous) => ({ ...previous, [d.model_task]: d }));
      }),
      client.on('ready', (info) => { if (!failed) setDetectorReady(info.detector); }),
      client.on('error', reportError),
    ];
    (async () => {
      try {
        await client.init(opts.config, opts.detector);
        if (disposed || failed) return;
        const packs = typeof opts.packs === 'function' ? await opts.packs() : opts.packs;
        if (disposed || failed) return;
        await client.installPacks(packs);
        if (disposed || failed) return;
        const movementModels = opts.movement_models ?? (opts.movement_model ? [opts.movement_model] : []);
        if (movementModels.length) {
          try { await client.loadMovementModels(movementModels); }
          catch (error) {
            if (disposed || failed) return;
            reportError({ code: 'MODEL_UNAVAILABLE', message: (error as Error).message, recoverable: true });
          }
        }
        if (!disposed && !failed) setReady(true);
        // Ship evidence left behind by earlier sessions (closed tab, crash, offline) before any new session starts.
        if (!disposed && !failed) recoverWhenOnline(client);
      } catch (e) {
        if (disposed || failed) return;
        const err = e as Error & { code?: string };
        reportError({ code: err.code ?? 'INTERNAL', message: err.message, recoverable: false });
      }
    })();
    return () => {
      disposed = true;
      offs.forEach((off) => off());
      syncerRef.current?.stop();
      client.dispose();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const calibrate = useCallback((c: Calibration) => clientRef.current!.calibrate(c), []);
  const start = useCallback(async (req: SessionStartRequest) => {
    const client = clientRef.current!;
    const info = await client.start(req);
    setStartInfo(info);
    const sync = optsRef.current.sync;
    if (sync) {
      recoverWhenOnline(client);
      syncerRef.current?.stop();
      syncerRef.current = new OutboxSyncer(client, sync.transport, req.session_id, { interval_ms: sync.interval_ms, online: sync.online ?? browserOnline });
      syncerRef.current.start();
    }
    return info;
  }, []);
  const pause = useCallback(() => clientRef.current!.pause(), []);
  const resume = useCallback(() => clientRef.current!.resume(), []);
  const complete = useCallback(async () => {
    const summary = await clientRef.current!.complete();
    // Final flush of the outbox before the session is torn down.
    if (syncerRef.current) {
      await syncerRef.current.flush();
      syncerRef.current.stop();
    }
    return summary;
  }, []);
  const offerPoseFrame = useCallback((frame: PoseFrame) => clientRef.current?.offerPoseFrame(frame), []);
  const offerImage = useCallback<BrainClient['offerImage']>((bitmap, meta) => {
    if (clientRef.current) clientRef.current.offerImage(bitmap, meta);
    else bitmap.close();
  }, []);
  const nextFrameId = useCallback(() => clientRef.current?.nextFrameId() ?? 0, []);

  const pinSubject = useCallback<BrainClient['pinSubject']>((point) => {
    if (!clientRef.current) return Promise.reject(new Error('Brain client is not ready'));
    return clientRef.current.pinSubject(point);
  }, []);

  return { ready, detectorReady, sessionState, tick, lastPose, movementDetection, movementDetections, error, startInfo, calibrate, start, pause, resume, complete, offerPoseFrame, offerImage, nextFrameId, pinSubject, client: clientRef.current };
}
