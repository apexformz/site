"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Camera, CameraOff, ChevronLeft, Play, RotateCcw, Volume2, VolumeX, X } from 'lucide-react';
import type { AssessmentSet, FeedbackAction, FeatureSpec, MovementCatalog, MovementDefinition, PhaseGraph, PoseFrame, SessionStartRequest, SportPackManifest, TelemetrySample, TechniqueCriteria } from '@apexformz/contracts';
import { GUIDED_REVIEW_MAX_AGE_MS, type BrainTick } from '@apexformz/runtime';
import { AdaptiveScheduler, PoseDetectorBridge, createLegacyAdapterState, fetchMovementModelIndex, toLegacyFrameAnalysis, type LegacyFrameAnalysis, type MovementModelConfig } from '@apexformz/brain-client';
import { useApexBrain } from '@apexformz/brain-client/react';
import type { FrameAnalysis, PoseKeypoints, Sport } from '@smartcoach/types';
import { PoseSkeleton } from '@/components/PoseSkeleton';
import { TrainingStats } from '@/components/TrainingStats';
import { ActionableFeedback } from '@/components/ActionableFeedback';
import { useVoiceCoaching } from '@/hooks/useVoiceCoaching';
import { DEFAULT_CALIBRATION, DETECTOR_OPTIONS, ORT_WASM_BASE_URL, detectorOptions, loadSetup, parsePoseBackend, runtimeConfig, type CoachingMode } from '@/lib/brain/config';
import { loadPackInput } from '@/lib/brain/packs';
import { poseFrameToLegacyKeypoints } from '@/lib/brain/poseAdapter';
import { tapToRawPoint } from '@/lib/brain/tapToPin';
import { currentAssessment as presentAssessment, currentDetections, currentFeedback, selectedMovement as resolveMovement, trackingBoundary } from '@/lib/brain/presentation';
import { modelsForMovement, recognitionModeFromParam } from '@/lib/brain/recognition';
import { projectDraftReferenceFeedback, summarizeTechnique } from '@/lib/brain/techniqueSummary';
import { authenticatedBrainSyncTransport, createSession, retryBrainSessionSync, saveBrainSession, type StoredBrainSession } from '@/lib/brain/session';
import { QualityBanner } from './QualityBanner';
import { PhaseTimeline } from './PhaseTimeline';
import { DynamicProgress } from './DynamicProgress';
import { dynamicProgress } from '@/lib/brain/dynamicProgress';
import { updateLastAttemptReview, visibleLastAttemptReview } from '@/lib/brain/lastAttemptReview';
import { createTechniqueReview, recordTechniqueAssessment, type TechniqueReviewAccumulator } from '@/lib/brain/sessionTechniqueReview';
import { AttemptReviewDetails } from './AttemptReviewDetails';
import { PinControl, type PinView } from './PinControl';
import { CriterionPanel } from './CriterionPanel';
import { FeedbackToast } from './FeedbackToast';
import { TelemetryHud } from './TelemetryHud';
import { RepetitionTile } from './RepetitionTile';
import { MovementRecognitionPanel, type RecognitionLoadState } from './MovementRecognitionPanel';
import { TechniqueStatus } from './TechniqueStatus';

const TARGET_FPS = 24;

interface Props {
  sport: Sport;
}

/**
 * On-device Brain training page for sport-pack sports. Pose detection and the
 * whole coaching pipeline run inside a module worker; this component only
 * captures camera frames, renders and coordinates (TRD 01).
 */
export default function BrainTrainingPage({ sport }: Props) {
  const params = useSearchParams();
  // A changed drill or mode gets its own worker, so a strict session cannot reuse development options.
  return <BrainTrainingSession key={`${sport}/${params.toString()}`} sport={sport} />;
}

function BrainTrainingSession({ sport }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const setup = useMemo(() => loadSetup(sport), [sport]);
  const movementId = params.get('movement') ?? setup?.movement_id ?? null;
  const mode: CoachingMode = (params.get('mode') ?? setup?.mode ?? (sport === 'squash' ? 'development' : 'strict')) === 'development' ? 'development' : 'strict';
  const recognitionMode = recognitionModeFromParam(params.get('recognition'));
  const showDiagnostics = params.get('diagnostics') === '1';
  const calibration = setup?.calibration ?? DEFAULT_CALIBRATION;
  const poseBackendChoice = sport === 'squash' ? 'mediapipe' : parsePoseBackend(params.get('backend') ?? setup?.pose_backend);
  const detectorOpts = useMemo(() => detectorOptions(poseBackendChoice), [poseBackendChoice]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isCameraChanging, setIsCameraChanging] = useState(false);
  const cameraTransitionRef = useRef(false);
  const cameraGenerationRef = useRef(0);
  const cameraSinceRef = useRef(0);
  const [dimensions, setDimensions] = useState({ width: 1280, height: 720 });
  const [isRecording, setIsRecording] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const startingRef = useRef(false);
  const finishingRef = useRef(false);
  const mountedRef = useRef(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [duration, setDuration] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [pose, setPose] = useState<PoseKeypoints | null>(null);
  const [poseTimestamp, setPoseTimestamp] = useState<number | null>(null);
  const [poseLatency, setPoseLatency] = useState<number | null>(null);
  const [lastAssessment, setLastAssessment] = useState<AssessmentSet | null>(null);
  const [lastAttemptReview, setLastAttemptReview] = useState<AssessmentSet | null>(null);
  const [lastFeedback, setLastFeedback] = useState<FeedbackAction | null>(null);
  const [lastTelemetry, setLastTelemetry] = useState<TelemetrySample | null>(null);
  const [legacy, setLegacy] = useState<LegacyFrameAnalysis | null>(null);
  const [hasCurrentPose, setHasCurrentPose] = useState(false);
  const [presentationNow, setPresentationNow] = useState(0);
  const presentationSinceRef = useRef(Infinity);
  const lastPresentedTickRef = useRef<BrainTick | null>(null);
  const [mainThreadDetector, setMainThreadDetector] = useState<'off' | 'loading' | 'ready' | 'failed'>('off');
  const [startError, setStartError] = useState<string | null>(null);
  const [poseBackendName, setPoseBackendName] = useState<string | null>(null);
  const [executionsCompleted, setExecutionsCompleted] = useState(0);
  const [recognitionStatus, setRecognitionStatus] = useState<RecognitionLoadState>('loading');
  const [recognitionMessage, setRecognitionMessage] = useState<string | null>(null);
  const [recognitionModels, setRecognitionModels] = useState<MovementModelConfig[]>([]);
  const [selectedDrill, setSelectedDrill] = useState<MovementDefinition | null>(null);
  const modelLoadRef = useRef<Promise<void> | null>(null);

  const backendBackedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const adapterStateRef = useRef(createLegacyAdapterState());
  const mainDetectorRef = useRef<PoseDetectorBridge | null>(null);
  const frameSeqRef = useRef(0);
  // TRD 01 fallback mode: capture rate and input scale follow measured processing time and thermal state.
  const schedulerRef = useRef(new AdaptiveScheduler({ target_fps: TARGET_FPS }));
  const lastQueueAgeRef = useRef(0);
  const [scheduleMode, setScheduleMode] = useState<string>('full');
  const storedRef = useRef<StoredBrainSession | null>(null);
  const techniqueReviewRef = useRef<TechniqueReviewAccumulator | null>(null);
  const lastNonemptyAssessmentRef = useRef<AssessmentSet | null>(null);
  const loadedPackRef = useRef<SportPackManifest | null>(null);
  const loadedFeatureSpecsRef = useRef<FeatureSpec[]>([]);
  const plannedChecksRef = useRef<Array<{ criterion_id: string; name: string }>>([]);
  const [pinView, setPinView] = useState<PinView>({ state: 'unpinned', personCount: 0, error: null });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const { announce, stop: stopVoice } = useVoiceCoaching();

  const brain = useApexBrain({
    createWorker: () => new Worker(new URL('../../workers/brain.worker.ts', import.meta.url), { type: 'module' }),
    config: runtimeConfig(mode),
    detector: detectorOpts,
    detector_in_worker: true,
    packs: () => loadPackInput(sport).then((p) => {
      const manifest = p.manifest as SportPackManifest;
      loadedPackRef.current = manifest;
      const catalog = JSON.parse(p.assets[manifest.movements]) as MovementCatalog;
      const drill = resolveMovement(catalog, movementId);
      if (!drill) throw new Error('Choose a supported drill in setup before entering the studio.');
      const technique = JSON.parse(p.assets[manifest.technique_rubrics]) as TechniqueCriteria;
      loadedFeatureSpecsRef.current = technique.features;
      const drillCriteria = technique.criteria.filter(c => c.movement_id === drill.id && c.validation_status !== 'disabled');
      const referenceCriteria = drillCriteria.filter(c => c.evaluator.kind === 'dynamic_reference');
      plannedChecksRef.current = (referenceCriteria.length ? referenceCriteria : drillCriteria).map(c => ({ criterion_id: c.criterion_id, name: c.criterion_id.split('.').at(-1)!.replace(/^dynamic_ref_/, '').replace(/_/g, ' ') }));
      if (mountedRef.current) setSelectedDrill(drill);
      return [p];
    }),
    sync: {
      transport: authenticatedBrainSyncTransport(),
      interval_ms: 3000,
      online: () => backendBackedRef.current && (typeof navigator === 'undefined' || navigator.onLine),
    },
  });

  const phaseGraph = (brain.startInfo?.phase_graph as PhaseGraph | undefined) ?? null;
  const pack = brain.startInfo?.pack ?? null;
  const movementName = (brain.startInfo?.movement as { canonical_name?: string } | undefined)?.canonical_name ?? null;
  const activeLike = brain.sessionState === 'ACTIVE' || brain.sessionState === 'DEGRADED';
  useEffect(() => {
    const client = brain.client;
    if (!client) return;
    return client.on('tick', tick => {
      const accumulator = techniqueReviewRef.current;
      if (!accumulator) return;
      recordTechniqueAssessment(accumulator, tick.assessment, { handedness: calibration.handedness, featureSpecs: loadedFeatureSpecsRef.current });
      if (tick.assessment?.criteria.length && tick.assessment.session_id === accumulator.review.session_id && tick.assessment.movement_id === accumulator.review.movement_id) lastNonemptyAssessmentRef.current = tick.assessment;
    });
  }, [brain.client, calibration.handedness]);

  useEffect(() => {
    if (brain.sessionState !== 'FAILED') return;
    cameraGenerationRef.current++;
    cameraSinceRef.current = performance.now();
    setIsCameraActive(false);
    setIsRecording(false);
    setPose(null);
    setPoseTimestamp(null);
    stopVoice();
  }, [brain.sessionState, stopVoice]);

  // Recognition models are optional; finish their load attempt before a session can start.
  useEffect(() => {
    const client = brain.client;
    if (sport !== 'squash' || !brain.ready || !client || !selectedDrill) return;
    let active = true;
    const controller = new AbortController();
    setRecognitionStatus('loading');
    setRecognitionMessage(`Loading the ${selectedDrill.type === 'static' ? 'static pose' : 'dynamic movement'} model for this drill.`);
    modelLoadRef.current = (async () => {
      try {
        const availableModels = await fetchMovementModelIndex(new URL('/models/squash/index.json', window.location.origin).href, 'squash', {
          allow_provisional: recognitionMode === 'preview',
          signal: controller.signal,
          ort_wasm_base_url: ORT_WASM_BASE_URL,
        });
        const models = modelsForMovement(availableModels, selectedDrill);
        if (!active) return;
        if (!models.length) {
          setRecognitionModels([]);
          setRecognitionStatus('unavailable');
          setRecognitionMessage('Squash recognition models are not available yet. You can still use the selected drill.');
          return;
        }
        const loaded = await client.loadMovementModels(models);
        if (!active) return;
        setRecognitionModels(loaded);
        setRecognitionStatus('ready');
        const hasProvisional = loaded.some((m) => m.calibration.status === 'provisional');
        setRecognitionMessage(hasProvisional
          ? recognitionMode === 'validated' ? 'Validated-only recognition is waiting for reviewed thresholds.' : 'Recognition is provisional. Only the selected drill’s model runs; technique corrections use separate criteria.'
          : null);
      } catch (error) {
        if (!active) return;
        console.warn('Squash recognition unavailable:', error);
        setRecognitionModels([]);
        setRecognitionStatus('unavailable');
        setRecognitionMessage('Squash recognition could not load. You can still use the selected drill. Reload this page to retry.');
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [sport, brain.ready, brain.client, recognitionMode, selectedDrill]);

  // Camera -----------------------------------------------------------------
  const toggleCamera = useCallback(async () => {
    if (cameraTransitionRef.current) return;
    cameraTransitionRef.current = true;
    setIsCameraChanging(true);
    cameraGenerationRef.current++;
    cameraSinceRef.current = performance.now();
    setHasCurrentPose(false);
    setPose(null);
    setPoseTimestamp(null);
    stopVoice();
    mainDetectorRef.current?.resetTracking();
    try {
      if (isCameraActive) {
        setIsCameraActive(false);
        if (isRecording && activeLike) await brain.pause();
      } else {
        if (isRecording && brain.sessionState === 'PAUSED') await brain.resume();
        if (mountedRef.current) setIsCameraActive(true);
      }
    } catch (error) {
      if (mountedRef.current) setStartError((error as Error).message);
    } finally {
      cameraTransitionRef.current = false;
      if (mountedRef.current) setIsCameraChanging(false);
    }
  }, [isCameraActive, isRecording, activeLike, brain.pause, brain.resume, brain.sessionState, stopVoice]);

  // Also pause if camera acquisition fails or the browser stops its track.
  useEffect(() => {
    if (!isCameraActive && isRecording && activeLike && !cameraTransitionRef.current) {
      void brain.pause().catch((error: Error) => { if (mountedRef.current) setStartError(error.message); });
    }
  }, [isCameraActive, isRecording, activeLike, brain.pause]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let active = true;
    async function setupCamera() {
      if (!isCameraActive) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' }, audio: false });
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }
        stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
          if (active) { cameraGenerationRef.current++; setIsCameraActive(false); }
        }));
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        if (!active) return;
        console.error('Camera error:', err);
        setIsCameraActive(false);
      }
    }
    void setupCamera();
    return () => {
      active = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [isCameraActive]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setDimensions({ width: e.contentRect.width, height: e.contentRect.height });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Fallback: main-thread detector when the worker could not initialise one.
  useEffect(() => {
    if (!brain.ready || brain.detectorReady) return;
    let active = true;
    setMainThreadDetector('loading');
    const bridge = new PoseDetectorBridge({ ...DETECTOR_OPTIONS, backend: 'mediapipe' });
    bridge.init().then(() => {
      if (!active) { bridge.close(); return; }
      mainDetectorRef.current = bridge;
      setMainThreadDetector('ready');
    }).catch((e) => {
      if (!active) return;
      console.error('Main-thread pose detector failed:', e);
      setMainThreadDetector('failed');
    });
    return () => {
      active = false;
      if (mainDetectorRef.current === bridge) mainDetectorRef.current = null;
      bridge.close();
    };
  }, [brain.ready, brain.detectorReady]);

  // Frame loop ---------------------------------------------------------------
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let active = true;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!video || !isCameraActive || video.readyState < 2 || !brain.ready || startingRef.current) return;
      if (now - last < schedulerRef.current.current.interval_ms) return;
      last = now;
      const session_id = sessionIdRef.current ?? 'preview';
      const generation = cameraGenerationRef.current;
      const meta = { session_id, timestamp_ms: performance.now(), camera_id: 'webcam', mirror: false as const, orientation: 'landscape' as const };
      if (brain.detectorReady) {
        // Raw camera frames are not flipped before inference, so mirror=false; the UI mirrors for display only.
        const scale = schedulerRef.current.current.scale;
        const resize = scale < 1 ? { resizeWidth: Math.round((video.videoWidth || 1280) * scale), resizeHeight: Math.round((video.videoHeight || 720) * scale), resizeQuality: 'low' as const } : undefined;
        createImageBitmap(video, resize as ImageBitmapOptions).then((bmp) => {
          if (active && generation === cameraGenerationRef.current) brain.offerImage(bmp, meta);
          else bmp.close();
        }).catch(() => undefined);
      } else if (mainThreadDetector === 'ready' && mainDetectorRef.current) {
        const frame = mainDetectorRef.current.detect(video, { ...meta, frame_id: frameSeqRef.current++, image_size: [video.videoWidth || 1280, video.videoHeight || 720] });
        if (frame) {
          setPose(poseFrameToLegacyKeypoints(frame, [video.videoWidth || frame.image_size[0], video.videoHeight || frame.image_size[1]]));
          setPoseTimestamp(frame.timestamp_ms);
          brain.offerPoseFrame(frame);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => { active = false; cancelAnimationFrame(raf); };
  }, [isCameraActive, brain.ready, brain.detectorReady, brain.offerImage, brain.offerPoseFrame, mainThreadDetector]);

  // Tap-to-pin --------------------------------------------------------------
  // The display is mirrored and object-cover cropped; the detector sees raw frames, so undo both.
  const pinAtTap = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    const el = containerRef.current;
    if (!video || !el || !brain.detectorReady || (e.target as HTMLElement).closest('button, a, [data-no-pin]')) return;
    const point = tapToRawPoint(e, el.getBoundingClientRect(), { width: video.videoWidth, height: video.videoHeight });
    if (!point) return;
    setPinView((prev) => ({ ...prev, state: 'pending', error: null }));
    brain.pinSubject(point).then((status) => {
      if (status.state === 'unpinned') setPinView((prev) => ({ ...prev, state: 'unpinned', error: status.last_error }));
    }).catch(() => setPinView((prev) => ({ ...prev, state: 'unpinned', error: 'pinning unavailable' })));
  }, [brain.detectorReady, brain.pinSubject]);

  const unpin = useCallback(() => {
    brain.pinSubject(null).catch(() => undefined);
    setPinView((prev) => ({ ...prev, state: 'unpinned', error: null }));
  }, [brain.pinSubject]);

  // The worker waits a few frames for a person under the finger; if no pinned frame arrives, say so.
  useEffect(() => {
    if (pinView.state !== 'pending') return;
    const timer = setTimeout(() => setPinView((prev) => (prev.state === 'pending' ? { ...prev, state: 'unpinned', error: 'no person found at the tapped point' } : prev)), 2000);
    return () => clearTimeout(timer);
  }, [pinView.state]);

  // Worker outputs -----------------------------------------------------------
  useEffect(() => {
    const client = brain.client;
    if (!client) return;
    const offPose = client.on('pose', (frame: PoseFrame, latency: number) => {
      if (frame.timestamp_ms < cameraSinceRef.current) return;
      const pinned = frame.tracked_subject_id?.startsWith('pinned-') ?? false;
      const personCount = frame.quality.person_count ?? 0;
      setPinView((prev) => {
        const state = pinned ? (frame.normalized_landmarks.length ? 'tracking' : frame.quality.ambiguous_people ? 'uncertain' : 'searching')
          : prev.state === 'pending' ? 'pending' : 'unpinned';
        return prev.state === state && prev.personCount === personCount ? prev : { state, personCount, error: state === 'unpinned' ? prev.error : null };
      });
      setPose(poseFrameToLegacyKeypoints(frame, [videoRef.current?.videoWidth || frame.image_size[0], videoRef.current?.videoHeight || frame.image_size[1]]));
      setPoseTimestamp(frame.timestamp_ms);
      setPoseLatency(latency);
      setScheduleMode(schedulerRef.current.observe(latency, lastQueueAgeRef.current).mode);
    });
    const offReady = client.on('ready', (info) => {
      const backend = (info as { pose_backend?: string | null }).pose_backend ?? (info.detector ? 'mediapipe' : null);
      setPoseBackendName(backend);
    });
    return () => {
      offPose();
      offReady();
    };
  }, [brain.client]);

  useEffect(() => {
    if (isCameraActive && isRecording && activeLike) return;
    // A camera restart or resumed session must receive a fresh tick before showing live verdicts.
    lastPresentedTickRef.current = brain.tick;
    setHasCurrentPose(false);
    setLastFeedback(null);
    setLastAttemptReview(null);
    setLegacy(null);
    presentationSinceRef.current = Infinity;
    adapterStateRef.current = createLegacyAdapterState();
    stopVoice();
  }, [isCameraActive, isRecording, activeLike, brain.tick, stopVoice]);

  useEffect(() => {
    const tick = brain.tick;
    if (!isCameraActive || !isRecording || !activeLike || !tick || tick === lastPresentedTickRef.current) return;
    lastPresentedTickRef.current = tick;
    if (!Number.isFinite(presentationSinceRef.current) || trackingBoundary(tick)) {
      presentationSinceRef.current = tick.timestamp_ms;
      adapterStateRef.current = createLegacyAdapterState();
    }
    setPresentationNow(performance.now());
    setHasCurrentPose(true);
    setFrameCount((c) => c + 1);
    if (tick.assessment) setLastAssessment(tick.assessment);
    setLastAttemptReview(previous => selectedDrill?.type === 'dynamic' ? updateLastAttemptReview(previous, tick, { live: true, sessionId, movementId }, tick.timestamp_ms) : null);
    setLastFeedback((previous) => currentFeedback(tick.feedback ?? previous, tick, true, tick.timestamp_ms));
    if (tick.telemetry) {
      setLastTelemetry(tick.telemetry);
      lastQueueAgeRef.current = tick.telemetry.queue_age_ms;
      schedulerRef.current.thermal(tick.telemetry.thermal_state as 'nominal' | 'fair' | 'serious' | 'critical' | null | undefined);
    }
    if (tick.temporal?.completed) setExecutionsCompleted((n) => n + 1);
    const phaseOrder = phaseGraph?.phases.map((p) => p.id) ?? [];
    const analysis = toLegacyFrameAnalysis(tick, adapterStateRef.current, phaseOrder, { handedness: calibration.handedness, featureSpecs: loadedFeatureSpecsRef.current });
    setLegacy(analysis);
  }, [brain.tick, phaseGraph, isCameraActive, isRecording, activeLike, calibration.handedness, selectedDrill?.type, sessionId, movementId]);

  useEffect(() => {
    if (!isCameraActive) return;
    const timer = setInterval(() => setPresentationNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, [isCameraActive]);
  useEffect(() => () => stopVoice(), [stopVoice]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (isRecording && activeLike && isCameraActive) interval = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(interval);
  }, [isRecording, activeLike, isCameraActive]);

  // Session lifecycle --------------------------------------------------------
  const startSession = useCallback(async () => {
    if (startingRef.current || isRecording) return;
    if (!movementId) {
      setStartError('Choose a movement in the setup page first.');
      return;
    }
    startingRef.current = true;
    // Discard preview captures and stop feeding frames until calibration/start has committed.
    cameraGenerationRef.current++;
    setIsStarting(true);
    setStartError(null);
    try {
      if (sport === 'squash') {
        if (!modelLoadRef.current) throw new Error('Wait for recognition models to finish loading.');
        await modelLoadRef.current;
      }
      if (!mountedRef.current) return;
      const loadedPack = loadedPackRef.current;
      if (!loadedPack) throw new Error('Wait for the selected sport pack to finish loading.');
      const base: Omit<SessionStartRequest, 'session_id'> = {
        sport_pack_id: sport,
        sport_pack_version: loadedPack.version,
        movement_id: movementId,
        calibration,
        pinned_models: [{ model_id: 'heuristic_phase_segmenter', version: '1.0.0' }],
      };
      const created = await createSession(base);
      if (!mountedRef.current) return;
      backendBackedRef.current = created.backend_backed;
      sessionIdRef.current = created.session_id;
      setSessionId(created.session_id);
      await brain.calibrate(calibration);
      const info = await brain.start({ ...base, session_id: created.session_id, sport_pack_version: pack?.version ?? base.sport_pack_version });
      if (!mountedRef.current) return;
      cameraGenerationRef.current++;
      cameraSinceRef.current = performance.now();
      mainDetectorRef.current?.resetTracking();
      adapterStateRef.current = createLegacyAdapterState();
      techniqueReviewRef.current = (info.movement as MovementDefinition).type === 'dynamic' ? createTechniqueReview(created.session_id, (info.movement as MovementDefinition).id, plannedChecksRef.current) : null;
      lastNonemptyAssessmentRef.current = null;
      storedRef.current = {
        session_id: created.session_id,
        sport,
        movement_id: (info.movement as { id: string }).id,
        movement_name: (info as { movement?: { canonical_name?: string } }).movement?.canonical_name ?? null,
        mode,
        backend_backed: created.backend_backed,
        athlete_id: created.athlete_id,
        start_request: { ...base, session_id: created.session_id, sport_pack_version: info.pack.version },
        completion_sync: created.athlete_id ? 'pending' : 'local',
        outbox_local: true,
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
        last_assessment: null,
        pack: { id: info.pack.id, version: info.pack.version },
      };
      saveBrainSession(storedRef.current);
      setIsRecording(true);
      setDuration(0);
      setFrameCount(0);
      setLastAssessment(null);
      setLastAttemptReview(null);
      setLastFeedback(null);
      setExecutionsCompleted(0);
    } catch (e) {
      if (mountedRef.current) setStartError((e as Error).message);
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setIsStarting(false);
    }
  }, [movementId, sport, calibration, mode, brain, pack?.version, isRecording]);

  const stopSession = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id || finishingRef.current) return;
    finishingRef.current = true;
    cameraGenerationRef.current++;
    try {
      const summary = await brain.complete();
      // Wait for this worker's queued IndexedDB writes before the results sync reads that store.
      await brain.client?.recoverOutbox().catch(() => undefined);
      stopVoice();
      const stored: StoredBrainSession = {
        ...(storedRef.current ?? { session_id: id, sport, movement_id: movementId ?? '', mode, backend_backed: backendBackedRef.current, started_at: new Date().toISOString(), pack: pack ? { id: pack.id, version: pack.version } : null }),
        ended_at: new Date().toISOString(),
        summary,
        duration_s: duration,
        completion_sync: storedRef.current?.athlete_id ? 'pending' : 'local',
        last_assessment: techniqueReviewRef.current ? lastNonemptyAssessmentRef.current : lastAssessment,
        session_technique_review: techniqueReviewRef.current?.review ?? null,
        repetition: brain.tick?.repetition
          ? { rep_count: brain.tick.repetition.rep_count, period_ms: brain.tick.repetition.period_ms, periodicity: brain.tick.repetition.periodicity, dominant_feature: brain.tick.repetition.dominant_feature }
          : null,
        pose_backend: poseBackendName,
      };
      // Write the complete review before network calls so navigation/offline errors cannot lose it.
      saveBrainSession(stored);
      storedRef.current = stored;
      techniqueReviewRef.current = null;
      setIsRecording(false);
      setIsCameraActive(false);
      await retryBrainSessionSync(stored);
      sessionIdRef.current = null;
      router.push(`/results/${id}`);
    } catch (e) {
      setStartError((e as Error).message);
      setIsRecording(false);
    } finally { finishingRef.current = false; }
  }, [brain, stopVoice, sport, movementId, mode, pack, lastAssessment, router, poseBackendName, duration]);

  const detectorLabel = brain.detectorReady ? 'worker' : mainThreadDetector === 'ready' ? 'main-thread' : mainThreadDetector === 'failed' ? 'unavailable' : 'loading';
  const nowMs = Math.max(presentationNow, brain.tick?.timestamp_ms ?? 0);
  const visiblePose = isCameraActive && brain.ready && poseTimestamp !== null
    && poseTimestamp >= cameraSinceRef.current && nowMs - poseTimestamp <= 1000 ? pose : null;
  const poseEvidenceAvailable = isCameraActive && isRecording && activeLike && hasCurrentPose
    && Boolean(brain.tick && nowMs - brain.tick.timestamp_ms <= 1000);
  const usablePose = poseEvidenceAvailable && brain.sessionState === 'ACTIVE' && Boolean(brain.tick?.quality.ok) && !brain.tick?.signal.dropped;
  const currentAssessment = usablePose ? presentAssessment(lastAssessment, brain.tick, presentationSinceRef.current) : null;
  const visibleFeedback = projectDraftReferenceFeedback(currentFeedback(lastFeedback, brain.tick, poseEvidenceAvailable, nowMs), currentAssessment);
  const recognitionLive = poseEvidenceAvailable && brain.sessionState === 'ACTIVE' && Boolean(brain.tick && !trackingBoundary(brain.tick));
  const visibleDetections = currentDetections(brain.movementDetections, recognitionLive, sessionId, nowMs, presentationSinceRef.current);
  useEffect(() => { if (!visibleFeedback || !voiceEnabled) stopVoice(); }, [visibleFeedback, voiceEnabled, stopVoice]);
  const waitingMessage = !isCameraActive ? 'Enable the camera to begin pose tracking.'
    : !isRecording ? 'Start a session to check pose quality and technique.'
      : brain.sessionState !== 'ACTIVE' ? 'Coaching is paused. Waiting for an active session and a fresh pose.'
        : 'Waiting for the first pose frame. Keep your full body in view.';
  const dynamicTimingInterrupted = selectedDrill?.type === 'dynamic' && Boolean(brain.tick?.signal.time_gap);
  const movementProgress = dynamicProgress(phaseGraph, brain.tick, poseEvidenceAvailable);
  const correctionsEmptyState = !poseEvidenceAvailable ? { title: 'No assessment yet', description: waitingMessage }
    : !usablePose ? { title: 'Assessment unavailable', description: 'Waiting for a clear, stable pose before assessing technique.' }
      : !currentAssessment?.criteria.length && dynamicTimingInterrupted ? { title: 'Movement timing restarted', description: 'A gap between camera observations interrupted the sequence. Begin again from the starting position, then pause briefly after your attempt for feedback.' }
      : !currentAssessment?.criteria.length ? selectedDrill?.type === 'dynamic' ? { title: movementProgress.title, description: movementProgress.description } : { title: 'Tracking live · waiting for assessment', description: 'Body poses are arriving, but no fresh technique result is available yet. Keep your full body visible while the selected position is checked.' }
        : currentAssessment.score === null ? { title: 'No overall technique score', description: currentAssessment.criteria.some(c => c.measurement.reason === 'RUBRIC_UNVALIDATED') ? 'These criteria still need coach validation. Reviewed mode withholds their verdicts; coaching preview can show clearly labelled draft corrections.' : 'Review the individual criteria. Partial posture evidence does not establish a completed, correct execution.' }
          : { title: 'No corrections reported', description: 'No actionable corrections are available for the currently assessed criteria. Other criteria may still be unassessed.' };
  const scoreAvailable = currentAssessment?.score != null;
  const criteriaIssues = currentAssessment ? legacy?.issues ?? [] : [];
  const legacyAnalysis = (usablePose && currentAssessment ? legacy : null) as unknown as FrameAnalysis | null;
  const techniqueSummary = summarizeTechnique(currentAssessment, correctionsEmptyState, selectedDrill?.type);
  const previousAttempt = selectedDrill?.type === 'dynamic' ? visibleLastAttemptReview(lastAttemptReview, currentAssessment, brain.tick, { live: usablePose, sessionId, movementId }, nowMs) : null;
  const previousAttemptSummary = previousAttempt ? summarizeTechnique(previousAttempt, { title: 'Attempt reviewed', description: 'Review the available checks from the previous attempt.' }, 'dynamic') : null;
  const currentAttemptReview = selectedDrill?.type === 'dynamic' && currentAssessment && (brain.tick?.temporal?.completed || currentAssessment.criteria.some(c => ['guided_attempt_completed', 'dynamic_reference_completed'].includes((c as typeof c & { meta?: { assessment_source?: string } }).meta?.assessment_source ?? ''))) ? currentAssessment : null;
  useEffect(() => {
    // Use the latest queued review so an expiring older review cannot erase a
    // newly completed attempt delivered by the same render's tick effect.
    setLastAttemptReview(current => current && (!isCameraActive || !isRecording || !activeLike || !brain.tick
      || nowMs - brain.tick.timestamp_ms > 1000 || nowMs - current.timestamp_ms >= GUIDED_REVIEW_MAX_AGE_MS) ? null : current);
  }, [isCameraActive, isRecording, activeLike, brain.tick, nowMs]);
  // Generic rhythmic motion is not a completed execution of the selected drill.
  const repCount = executionsCompleted;

  return (
    <div className="flex h-screen bg-black overflow-hidden select-none">
      {/* Sidebar controls */}
      <div className="w-20 shrink-0 bg-background/50 border-r border-white/10 flex flex-col items-center py-8 gap-8 z-50">
        <button onClick={() => router.push(`/train/${sport}/setup`)} className="p-3 glass-card hover:bg-white/10 transition-colors" title="Back to setup">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div className="flex-1 flex flex-col gap-4">
          <button disabled={isCameraChanging || isStarting} onClick={toggleCamera} className={`p-4 rounded-2xl transition-all disabled:opacity-40 ${isCameraActive ? 'bg-primary text-primary-foreground shadow-glow' : 'glass-card'}`} title="Toggle camera">
            {isCameraActive ? <Camera className="w-6 h-6" /> : <CameraOff className="w-6 h-6" />}
          </button>
          <button
            disabled={isCameraChanging || isStarting || (!isRecording && (!isCameraActive || !brain.ready || (!brain.detectorReady && mainThreadDetector !== 'ready') || (sport === 'squash' && recognitionStatus === 'loading')))}
            onClick={isRecording ? stopSession : startSession}
            className={`p-4 rounded-2xl transition-all disabled:opacity-40 ${isRecording ? 'bg-accent-danger animate-pulse shadow-glow shadow-accent-danger/40' : 'btn-secondary text-secondary-foreground p-0 w-14 h-14 flex items-center justify-center'}`}
            title={isRecording ? 'Finish session' : 'Start session'}
          >
            {isRecording ? <X className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
          </button>
          <button onClick={() => setVoiceEnabled((v) => !v)} className="p-3 glass-card hover:bg-white/10 transition-colors text-white/60" title="Toggle voice cues">
            {voiceEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
          </button>
        </div>
        <button onClick={() => window.location.reload()} className="p-3 text-white/40 hover:text-white transition-colors" title="Reload">
          <RotateCcw className="w-6 h-6" />
        </button>
      </div>

      <main className="min-w-0 min-h-0 flex-1 flex flex-col lg:flex-row overflow-hidden">
        <div className="min-w-0 min-h-0 flex-1 relative flex items-center justify-center p-4 overflow-hidden" style={{ containerType: 'size' }}>
          <div ref={containerRef} onPointerUp={isCameraActive ? pinAtTap : undefined} className="relative w-full aspect-video glass-card overflow-hidden bg-black/40 border-primary/20 flex items-center justify-center shadow-2xl" style={{ maxWidth: 'min(64rem, calc(100cqh * 16 / 9))' }}>
            {isCameraActive ? (
              <>
                <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover mirror" />
                <PoseSkeleton coaching pose={visiblePose} analysis={legacyAnalysis} width={dimensions.width} height={dimensions.height} videoWidth={videoRef.current?.videoWidth} videoHeight={videoRef.current?.videoHeight} />

                {showDiagnostics && <div className="absolute top-4 left-4 z-50">
                  <TelemetryHud telemetry={lastTelemetry} sessionState={brain.sessionState} pack={pack} detector={detectorLabel} poseLatencyMs={poseLatency} suppressedReason={brain.tick?.suppressed_reason ?? null} poseBackend={poseBackendName ?? (mainThreadDetector === 'ready' ? 'mediapipe (main thread)' : null)} scheduleMode={scheduleMode} />
                </div>}

                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />

                <div className="absolute top-6 right-6 z-20 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <img src="/logo.png" alt="Apexformz Logo" className="w-8 h-8 object-contain" />
                    <span className="text-2xl font-black uppercase italic text-primary leading-none tracking-tighter">Apexformz Brain</span>
                  </div>
                  <span className="text-xs text-secondary/60 font-medium tracking-widest uppercase">{sport} / {movementName ?? movementId?.split('.').slice(1).join(' ').replace(/_/g, ' ') ?? 'no movement selected'}</span>
                  <div className="mt-1">
                    <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${mode === 'strict' ? 'border-secondary/40 text-secondary' : 'border-accent-warning/40 text-accent-warning'}`}>
                      {mode === 'strict' ? 'reviewed coaching · unvalidated verdicts withheld' : 'coaching preview · provisional corrections'}
                    </span>
                  </div>
                </div>

                <div className="absolute bottom-4 left-4 right-4 z-30 pointer-events-none max-w-sm flex flex-col gap-2">
                  <div className="pointer-events-auto self-start"><PinControl view={pinView} onUnpin={unpin} /></div>
                  <TechniqueStatus summary={techniqueSummary} compact />
                </div>

                {isRecording && (
                  <div className="absolute top-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-accent-danger/20 border border-accent-danger/40 px-4 py-1.5 rounded-full z-40">
                    <div className="w-2 h-2 rounded-full bg-accent-danger animate-ping" />
                    <span className="text-xs font-bold tracking-widest text-accent-danger uppercase">Session {brain.sessionState}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-4 text-white/20 overflow-auto">
                <CameraOff className="w-24 h-24 mb-4 stroke-[1]" />
                <p className="text-xl font-medium">Camera is disabled</p>
                <button disabled={isCameraChanging || isStarting} onClick={toggleCamera} className="mt-4 btn-primary text-sm tracking-widest px-8 disabled:opacity-40">ENABLE CAMERA TO START</button>
              </div>
            )}

            {isCameraActive && !brain.ready && !brain.error && (
              <div className="absolute inset-0 glass-card bg-black/80 flex flex-col items-center justify-center z-[100]">
                <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mb-6" />
                <p className="text-primary font-bold tracking-widest animate-pulse font-mono uppercase text-center">Loading Brain worker<br />and sport pack...</p>
              </div>
            )}

            {brain.error && !brain.ready && (
              <div className="absolute inset-0 glass-card bg-black/80 flex flex-col items-center justify-center z-[110] p-12 text-center">
                <h2 className="text-2xl font-black uppercase italic text-white mb-2">Brain failed to start</h2>
                <p className="text-white/60 text-sm max-w-sm mb-2 leading-relaxed">{brain.error.code}: {brain.error.message}</p>
                <button onClick={() => window.location.reload()} className="btn-primary px-12 py-3 text-xs tracking-[0.2em] mt-6">RELOAD</button>
              </div>
            )}
          </div>
        </div>

        {/* Right sidebar */}
        <div className="w-full lg:w-96 min-w-0 min-h-0 shrink-0 max-h-[42vh] lg:max-h-none bg-background/30 border-t lg:border-t-0 lg:border-l border-white/10 p-5 flex flex-col gap-4 overflow-y-auto z-40 custom-scrollbar">
          {startError && (
            <div className="glass-card p-4 border-l-4 border-l-accent-danger bg-accent-danger/5">
              <p className="text-sm font-bold text-accent-danger">Cannot start</p>
              <p className="text-xs text-white/50 mt-1">{startError}</p>
            </div>
          )}
          <div className="shrink-0">
            <p className="text-[10px] uppercase tracking-widest text-sky-300">Selected drill · {selectedDrill?.type === 'static' ? 'Static position' : 'Dynamic movement'}</p>
            <h2 className="text-xl font-semibold text-white mt-1" data-testid="selected-drill-name">{selectedDrill?.canonical_name ?? 'Loading selected drill…'}</h2>
            <p className="text-xs text-white/50 mt-1">{Math.floor(duration / 60)}:{(duration % 60).toString().padStart(2, '0')} · {frameCount} poses received · {repCount} {selectedDrill?.type === 'static' ? 'holds' : 'reps'} completed</p>
          </div>
          <TechniqueStatus summary={techniqueSummary} />
          {selectedDrill?.type === 'dynamic' && <DynamicProgress graph={phaseGraph} progress={movementProgress} />}
          <FeedbackToast feedback={visibleFeedback} announce={announce} voiceEnabled={voiceEnabled} />
          {currentAttemptReview && <section className="rounded-xl border border-sky-300/25 p-3 shrink-0" aria-label="Current attempt review"><p className="text-xs font-semibold text-sky-200">Checks from this attempt</p><AttemptReviewDetails assessment={currentAttemptReview} context={{ handedness: calibration.handedness, featureSpecs: loadedFeatureSpecsRef.current }} /></section>}
          {previousAttemptSummary && <section className="rounded-xl border border-amber-300/35 bg-amber-300/5 p-3 shrink-0" aria-label="Last attempt review" data-testid="last-attempt-review">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-200">Last attempt review</p>
            <p className="text-sm font-semibold text-white mt-2">{previousAttemptSummary.title}</p>
            <p className="text-sm text-white/80 mt-1">{previousAttemptSummary.detail}</p>
            <AttemptReviewDetails assessment={previousAttempt!} context={{ handedness: calibration.handedness, featureSpecs: loadedFeatureSpecsRef.current }} />
            <p className="text-[11px] text-white/50 mt-2">From your previous attempt; use this for the next repetition. Current body colors follow fresh measurements only.</p>
          </section>}
          {criteriaIssues.length > 0 && <ActionableFeedback issues={criteriaIssues} emptyState={correctionsEmptyState} />}
          {!usablePose && <QualityBanner ok={poseEvidenceAvailable ? usablePose : null} reasons={brain.tick?.quality.reasons ?? []} instruction={visibleFeedback} sessionState={brain.sessionState} waitingMessage={waitingMessage} />}
          <p className="text-[10px] text-white/60 leading-relaxed px-1" aria-label="Skeleton feedback legend">Blue = tracking · Red = correction · Green = reviewed check in range. Dashed red is preview guidance. Blue is not a technique verdict.</p>
          {selectedDrill?.type === 'dynamic' && poseEvidenceAvailable && brain.tick?.guided_attempt && <p className="text-xs text-white/60 leading-relaxed" role="status">{brain.tick.guided_attempt.source === 'motion_bout' ? 'Analysing the movement attempt.' : `Checking ${phaseGraph?.phases.find(p => p.id === brain.tick?.guided_attempt?.phase_id)?.name ?? 'the current position'}.`}{!brain.tick.guided_attempt.cue_allowed ? ' Voice cues wait until the action ends.' : ''}</p>}
          {currentAssessment && brain.tick?.guided_completion && currentAssessment.phase_id === brain.tick.guided_completion.phase_id && <p className="text-xs text-white/60 leading-relaxed" role="status">{brain.tick.guided_completion.source === 'motion_bout' ? 'Body-position review from the observed attempt.' : `Review of ${phaseGraph?.phases.find(p => p.id === brain.tick?.guided_completion?.phase_id)?.name ?? 'the previous attempt'}.`}</p>}
          {selectedDrill?.source?.instruction && <p className="text-sm text-white/70 leading-relaxed">{selectedDrill.source.instruction}</p>}
          <details className="rounded-xl border border-white/10 p-3 shrink-0">
            <summary className="text-sm font-medium text-white/75 cursor-pointer">Measured technique checks</summary>
            <div className="mt-3"><CriterionPanel assessment={currentAssessment} /></div>
          </details>
          {sport === 'squash' && <details className="rounded-xl border border-white/10 p-3 shrink-0">
            <summary className="text-sm font-medium text-white/75 cursor-pointer">Movement recognition details</summary>
            <div className="mt-3"><MovementRecognitionPanel status={recognitionStatus} message={recognitionMessage} models={recognitionModels} detections={visibleDetections} recording={isRecording} live={recognitionLive} mode={recognitionMode} selectedMovement={selectedDrill} /></div>
          </details>}
          <details className="rounded-xl border border-white/10 p-3 shrink-0">
            <summary className="text-sm font-medium text-white/75 cursor-pointer">Session progress and phases</summary>
            <div className="mt-3 flex flex-col gap-3">
              <PhaseTimeline graph={phaseGraph} temporal={poseEvidenceAvailable ? brain.tick?.temporal ?? null : null} />
              <RepetitionTile repetition={poseEvidenceAvailable ? brain.tick?.repetition ?? null : null} executionsCompleted={executionsCompleted} movementType={selectedDrill?.type} diagnostics={showDiagnostics} />
              <TrainingStats score={Math.round((currentAssessment?.score ?? 0) * 100)} scoreAvailable={scoreAvailable} scoreLabel={currentAssessment?.criteria.some(c => c.provenance.provisional) ? 'Preview score' : 'Form score'} duration={duration} frameCount={frameCount} isConnected={brain.ready} connectionError={brain.error?.message ?? null} repCount={repCount} repLabel={selectedDrill?.type === 'static' ? 'Holds' : 'Reps'} />
            </div>
          </details>
          <details className="text-xs text-white/50 shrink-0">
            <summary className="cursor-pointer">About coaching preview</summary>
            <p className="mt-2 leading-relaxed">Preview corrections use draft criteria and recorded reference positions or movement sequences that still need coach validation. Dynamic comparisons align visible parts of your movement with a recording from the selected view and handedness. Only observable body features are checked; unassessed features are not counted as correct. Camera frames stay on this device.</p>
          </details>
        </div>
      </main>

      <style jsx>{`
        .mirror {
          transform: rotateY(180deg);
        }
      `}</style>
    </div>
  );
}
