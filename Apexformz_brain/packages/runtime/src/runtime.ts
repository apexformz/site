import {
  BrainError, assertValid, isContractCompatible,
  type Calibration, type DynamicReferenceModel, type EquipmentMeasurementFrame, type ErrorCode, type MissingReason, type PoseFrame, type SessionStartRequest, type SportPackBundle,
} from '@apexformz/contracts';
import { SignalPipeline } from '@apexformz/signal';
import { FeatureEngine, type FeatureContext } from '@apexformz/features';
import { gatePoseQuality } from '@apexformz/perception';
import { SportPackRegistry, SportRouter, loadSportPack, type SportContext, type SportPackInput } from '@apexformz/sport-runtime';
import { PhaseSegmenter, RepetitionDetector, type TemporalUpdate } from '@apexformz/analysis';
import { CriterionEvaluator, DynamicReferenceComparator, mergeHumanVariance } from '@apexformz/scoring';
import { CoachingPolicy } from '@apexformz/coaching';
import { SessionStateMachine } from './session_fsm';
import { EventOutbox } from './outbox';
import { TelemetryCollector } from './telemetry';
import { equipmentFrameMismatch, validateEquipmentFrame } from './equipment';
import { guidedPhase, guidedPhaseEnd } from './guided';
import { DynamicAttemptObserver, dynamicMotionFeatures } from './dynamic_attempt';
import { dynamicReferenceAssessment } from './dynamic_reference_assessment';
import { DEFAULT_RUNTIME_CONFIG, GUIDED_REVIEW_MAX_AGE_MS, type BrainRuntimeConfig, type BrainTick, type SessionSummary, type RecognitionContext } from './types';

interface ActiveSession {
  request: SessionStartRequest;
  ctx: SportContext;
  signal: SignalPipeline;
  features: FeatureEngine;
  featureCtx: FeatureContext;
  segmenter: PhaseSegmenter;
  repetition: RepetitionDetector;
  evaluator: CriterionEvaluator;
  guidedEvaluator: CriterionEvaluator;
  motionEvaluator: CriterionEvaluator;
  motionObserver: DynamicAttemptObserver | null;
  referenceComparator: DynamicReferenceComparator | null;
  referenceModel: DynamicReferenceModel | null;
  referenceState: BrainTick['dynamic_reference'];
  guidedAttempt: BrainTick['guided_attempt'];
  guidedCompletion: BrainTick['guided_completion'];
  policy: CoachingPolicy;
  outbox: EventOutbox;
  telemetry: TelemetryCollector;
  lastTelemetryMs: number | null;
  badQualitySinceMs: number | null;
  goodQualityFrames: number;
  lastFrameArrivalMs: number | null;
  /** Capture-time floor: older frames cannot cross processed frames or lifecycle transitions. */
  acceptFromMs: number;
  stats: { frames: number; completed: number; aborted: number; assessments: number; feedback: number; lastScore: number | null; states: Record<string, number> };
  recognition?: RecognitionContext | null;
  equipment?: EquipmentMeasurementFrame | null;
}

/**
 * BrainRuntime: the common deterministic execution framework (TRD 01).
 *
 * CAMERA -> (pose worker) -> SIGNAL + FEATURES -> SPORT ROUTER -> TEMPORAL / CRITERIA
 *        -> EVIDENCE -> COACHING -> UI, with a local event outbox for async cloud sync.
 *
 * No network call sits on the per-frame path. The latest-frame slot has size
 * one; stale frames are overwritten and counted rather than queued.
 */
export class BrainRuntime {
  readonly config: BrainRuntimeConfig;
  readonly registry = new SportPackRegistry();
  readonly router = new SportRouter(this.registry);
  private fsm: SessionStateMachine;
  private session: ActiveSession | null = null;
  private slot: PoseFrame | null = null;
  private slotArrivalMs: number | null = null;
  private tickId = 0;
  private calibration: Calibration | null = null;
  private pendingSessionId: string | null = null;
  private transitionLog: Array<{ from: string; to: string; monotonic_ms: number; reason: string }> = [];
  private clock: () => number;

  constructor(config: Partial<BrainRuntimeConfig> = {}, clock?: () => number) {
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...config };
    this.clock = clock ?? (() => Date.now());
    this.fsm = new SessionStateMachine((t) => {
      if (this.session) this.session.acceptFromMs = Math.max(this.session.acceptFromMs, t.monotonic_ms);
      this.transitionLog.push({ from: t.from, to: t.to, monotonic_ms: t.monotonic_ms, reason: t.reason });
      this.session?.outbox.append('session.transition', t.monotonic_ms, { ...t });
    });
  }

  // ---------------------------------------------------------------------------
  // Packs
  // ---------------------------------------------------------------------------

  async installPack(input: SportPackInput): Promise<SportPackBundle> {
    const bundle = await loadSportPack(input, {
      platform: this.config.platform,
      hmac_keys: this.config.hmac_keys,
      trust_mode: this.config.pack_trust_mode,
      trust_registry: this.config.pack_trust_registry,
      allow_unsigned: this.config.allow_unsigned_packs,
    });
    this.registry.install(bundle);
    return bundle;
  }

  /** Report the latest movement recognition (from the worker's recognizers) for recognition-gated coaching. */
  noteRecognition(r: RecognitionContext): void {
    if (this.session) this.session.recognition = r;
  }

  /** Supply independently observed equipment evidence before its matching pose frame is processed. */
  noteEquipment(frame: EquipmentMeasurementFrame): void {
    validateEquipmentFrame(frame);
    if (!isContractCompatible(frame.schema_version)) throw new BrainError('CONTRACT_VERSION_INCOMPATIBLE', `equipment contract ${frame.schema_version}`, { recoverable: false });
    const s = this.session;
    if (!s || !this.fsm.isActiveLike()) throw new BrainError('INVALID_TRANSITION', 'equipment evidence requires an active session', { recoverable: true });
    if (frame.session_id !== s.request.session_id) throw new BrainError('SCHEMA_INVALID', 'equipment session does not match the active session', { recoverable: true });
    if (s.equipment && (frame.frame_id < s.equipment.frame_id || frame.timestamp_ms < s.equipment.timestamp_ms)) throw new BrainError('SCHEMA_INVALID', 'equipment evidence timestamps regressed', { recoverable: true });
    s.equipment = structuredClone(frame);
  }

  /** True when gating is on and a recent, confident, admissible recognition contradicts the selected drill's family. */
  private recognitionMismatch(s: ActiveSession, nowMs: number): boolean {
    const g = this.config.recognition_gating;
    const r = s.recognition;
    if (!g?.enabled || !r || !r.level || !r.family_id) return false;
    if ((g.require_validated ?? true) && !r.validated) return false;
    if (nowMs - r.timestamp_ms > (g.max_age_ms ?? 1500)) return false;
    if ((r.probability ?? 0) < (g.min_probability ?? 0.8)) return false;
    const selectedFamily = s.ctx.movement.family_id;
    return !!selectedFamily && r.family_id !== selectedFamily;
  }

  installBundle(bundle: SportPackBundle): void {
    this.registry.install(bundle);
  }

  activatePack(id: string, version: string): void {
    this.registry.activate(id, version);
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /** Id of the active (or pending) session, null when idle. */
  get sessionId(): string | null {
    return this.session?.request.session_id ?? this.pendingSessionId ?? null;
  }

  get sessionState() {
    return this.fsm.state;
  }

  get transitions() {
    return this.transitionLog;
  }

  requestPermissions(nowMs = this.clock()): void {
    this.fsm.transition('PERMISSIONS', nowMs, 'permissions_requested');
  }

  permissionsGranted(nowMs = this.clock()): void {
    this.fsm.transition('CALIBRATING', nowMs, 'permissions_granted');
  }

  permissionsDenied(nowMs = this.clock()): void {
    this.fsm.transition('IDLE', nowMs, 'permissions_denied');
  }

  calibrate(calibration: Calibration, nowMs = this.clock()): void {
    assertValid('calibration', calibration, 'calibration');
    this.calibration = calibration;
    if (this.fsm.state === 'IDLE') {
      this.fsm.transition('PERMISSIONS', nowMs, 'implicit_permissions');
      this.fsm.transition('CALIBRATING', nowMs, 'implicit_permissions_granted');
    }
    this.fsm.transition('READY', nowMs, 'calibrated');
  }

  /** Pin pack and model versions and start the real-time loop. */
  start(request: SessionStartRequest, nowMs = this.clock()): SportContext {
    assertValid('sessionStartRequest', request, 'session start request');
    if (!isContractCompatible(request.calibration ? '1.0.0' : '1.0.0')) throw new BrainError('CONTRACT_VERSION_INCOMPATIBLE', 'incompatible contract', { recoverable: false });
    if (this.fsm.state !== 'READY') throw new BrainError('INVALID_TRANSITION', `cannot start session from ${this.fsm.state}`, { recoverable: true });
    const ctx = this.router.open(request.session_id, request.sport_pack_id, request.movement_id, request.sport_pack_version);
    for (const m of request.pinned_models ?? []) {
      const known = ctx.pack.manifest.models.some((pm) => pm.path === m.model_id || pm.role === m.model_id);
      if (!known && m.model_id !== 'heuristic_phase_segmenter') {
        this.router.close(request.session_id);
        throw new BrainError('UNKNOWN_MODEL_ID', `model ${m.model_id} is not part of ${ctx.pack.manifest.id}@${ctx.pack.manifest.version}`, { recoverable: false });
      }
    }
    const calibration = request.calibration;
    const view = calibration.nominal_view;
    const signal = new SignalPipeline({ ...(this.config.signal ?? {}), view });
    const motionFeatureSpecs = this.config.guided_coaching ? dynamicMotionFeatures(ctx.phase_graph, ctx.feature_specs, ctx.criteria) : ctx.feature_specs;
    const features = new FeatureEngine(motionFeatureSpecs, this.config.guided_coaching && ctx.phase_graph.kind !== 'static_hold'
      ? { cadence_max_gap_ms: signal.config.max_gap_ms } : undefined);
    const featureCtx: FeatureContext = { view, handedness: calibration.handedness, handedness_assumed: calibration.handedness_assumed };
    const segmenter = new PhaseSegmenter(ctx.phase_graph, {
      session_id: request.session_id,
      sport_pack_id: ctx.pack.manifest.id,
      sport_pack_version: ctx.pack.manifest.version,
      movement_id: ctx.movement.id,
      model_version: 'heuristic_phase_segmenter@1.0.0',
    });
    const createEvaluator = () => new CriterionEvaluator(ctx.criteria.filter(c => c.evaluator.kind !== 'dynamic_reference'), ctx.phase_graph, ctx.pack.feedback_templates, {
      session_id: request.session_id,
      sport_pack_id: ctx.pack.manifest.id,
      sport_pack_version: ctx.pack.manifest.version,
      rubric_version: ctx.pack.technique_criteria.rubric_version,
      view,
      athlete_context: calibration.athlete_context ?? 'unknown',
      capabilities_available: this.config.capabilities_available,
      strict_rubrics: this.config.strict_rubrics,
      allow_draft_feedback: this.config.allow_draft_feedback,
      guided_coaching: this.config.guided_coaching,
      minimum_coverage: ctx.pack.technique_criteria.aggregation.minimum_coverage,
      human_variance: mergeHumanVariance(ctx.pack.technique_criteria.aggregation.human_variance, this.config.human_variance),
      models: ctx.pack.models,
      feature_specs: ctx.feature_specs,
      featureUnit: (id) => features.unitOf(id),
      locale: this.config.locale,
    });
    const evaluator = createEvaluator();
    const referencePath = ctx.criteria.find(c => c.evaluator.kind === 'dynamic_reference')?.evaluator.model_reference;
    const referenceModel = referencePath ? ctx.pack.models?.[referencePath] as DynamicReferenceModel | undefined : undefined;
    const referenceComparator = referenceModel && ctx.phase_graph.kind === 'dynamic_sequence'
      ? new DynamicReferenceComparator(referenceModel, { view, handedness: calibration.handedness, handedness_assumed: calibration.handedness_assumed, emit_interval_ms: 0 }) : null;
    const policy = new CoachingPolicy(ctx.pack.feedback_templates, {
      session_id: request.session_id,
      sport_pack_id: ctx.pack.manifest.id,
      sport_pack_version: ctx.pack.manifest.version,
      allow_draft_cues: this.config.allow_draft_feedback,
      locale: this.config.locale,
      criterion_error_ids: Object.fromEntries(ctx.criteria.map(c => [c.criterion_id, c.error_id])),
      deferred_cue_max_age_ms: this.config.guided_coaching && ctx.phase_graph.kind !== 'static_hold' ? 8000 : 0,
    });
    const outbox = new EventOutbox({
      quota: this.config.outbox_quota,
      sink: this.config.outbox_sink,
      session_id: request.session_id,
      sport_pack_id: ctx.pack.manifest.id,
      sport_pack_version: ctx.pack.manifest.version,
      producer: this.config.producer,
    });
    this.session = {
      request, ctx, signal, features, featureCtx, segmenter, repetition: new RepetitionDetector(), evaluator, guidedEvaluator: createEvaluator(), guidedAttempt: null, guidedCompletion: null, policy, outbox,
      motionEvaluator: createEvaluator(),
      referenceComparator, referenceModel: referenceModel ?? null, referenceState: null,
      motionObserver: this.config.guided_coaching && ctx.phase_graph.kind !== 'static_hold' ? new DynamicAttemptObserver(ctx.phase_graph, motionFeatureSpecs, ctx.criteria) : null,
      telemetry: new TelemetryCollector(),
      lastTelemetryMs: null,
      badQualitySinceMs: null,
      goodQualityFrames: 0,
      lastFrameArrivalMs: null,
      acceptFromMs: nowMs,
      stats: { frames: 0, completed: 0, aborted: 0, assessments: 0, feedback: 0, lastScore: null, states: {} },
    };
    this.pendingSessionId = request.session_id;
    outbox.append('pack.activation', nowMs, { sport_pack_id: ctx.pack.manifest.id, sport_pack_version: ctx.pack.manifest.version, movement_id: ctx.movement.id, pinned_models: request.pinned_models ?? [] });
    outbox.append('calibration', nowMs, { ...calibration });
    this.fsm.transition('ACTIVE', nowMs, 'session_started');
    return ctx;
  }

  pause(nowMs = this.clock()): void {
    this.fsm.transition('PAUSED', nowMs, 'paused');
  }

  /** Resume after pause or app suspend: temporal windows are reset, never bridged. */
  resume(nowMs = this.clock()): void {
    if (!this.session) throw new BrainError('INVALID_TRANSITION', 'no active session', { recoverable: true });
    this.session.acceptFromMs = nowMs;
    this.slot = null; // a frame captured before the resume must not be processed after it
    this.session.signal.reset();
    this.session.features.reset();
    this.session.segmenter.reset('RESUME', nowMs, -1);
    this.session.repetition.reset();
    this.session.evaluator.reset();
    this.session.guidedEvaluator.reset();
    this.session.motionEvaluator.reset();
    this.session.motionObserver?.reset();
    this.session.referenceComparator?.reset();
    this.session.referenceState = null;
    this.session.guidedAttempt = null;
    this.session.guidedCompletion = null;
    this.session.equipment = null;
    this.session.policy.reset();
    this.slot = null;
    this.fsm.transition('ACTIVE', nowMs, 'resumed');
  }

  /** Call periodically from the host to detect camera loss when no frames arrive. */
  heartbeat(nowMs = this.clock()): void {
    const s = this.session;
    if (!s || !this.fsm.isActiveLike()) return;
    if (s.lastFrameArrivalMs !== null && nowMs - s.lastFrameArrivalMs > this.config.camera_lost_ms && this.fsm.state === 'ACTIVE') {
      this.fsm.transition('DEGRADED', nowMs, 'camera_lost', 'CAMERA_LOST');
      s.outbox.append('error', nowMs, { code: 'CAMERA_LOST', message: 'no frames received' });
    }
  }

  complete(nowMs = this.clock()): SessionSummary {
    const s = this.session;
    if (!s) throw new BrainError('INVALID_TRANSITION', 'no active session to complete', { recoverable: true });
    this.fsm.transition('COMPLETING', nowMs, 'complete_requested');
    const ev = s.segmenter.reset('SESSION_COMPLETE', nowMs, -1);
    if (ev) s.outbox.append('movement.event', nowMs, ev as unknown as Record<string, unknown>);
    s.outbox.append('telemetry.sample', nowMs, s.telemetry.sample(s.request.session_id, nowMs, 0, this.router.executedPacks(s.request.session_id)) as unknown as Record<string, unknown>);
    this.fsm.transition('LOCAL_COMMITTED', nowMs, 'local_commit');
    const summary = this.summary();
    this.router.close(s.request.session_id);
    return summary;
  }

  markSyncPending(nowMs = this.clock()): void {
    this.fsm.transition('SYNC_PENDING', nowMs, 'sync_started');
  }

  markSynced(nowMs = this.clock()): void {
    this.fsm.transition('SYNCED', nowMs, 'sync_complete');
    this.session = null;
    this.fsm.transition('IDLE', nowMs, 'session_closed');
  }

  fail(code: ErrorCode, message: string, nowMs = this.clock()): void {
    this.session?.outbox.append('error', nowMs, { code, message });
    this.fsm.transition('FAILED', nowMs, message, code);
    if (this.session) this.router.close(this.session.request.session_id);
  }

  recoverFromFailure(nowMs = this.clock()): void {
    this.fsm.transition('IDLE', nowMs, 'recovered');
    this.session = null;
  }

  // ---------------------------------------------------------------------------
  // Data plane
  // ---------------------------------------------------------------------------

  /** Latest-frame slot of size one: a newer frame overwrites an unprocessed one. */
  offer(frame: PoseFrame, arrivalMs = this.clock()): void {
    const s = this.session;
    if (!s || !this.fsm.isActiveLike()) return;
    if (frame.timestamp_ms < s.acceptFromMs) {
      // In-flight inference may finish after a lifecycle or camera-loss boundary.
      s.telemetry.increment('discarded_frames');
      return;
    }
    if (this.slot) s.telemetry.increment('discarded_frames');
    this.slot = frame;
    this.slotArrivalMs = arrivalMs;
    s.lastFrameArrivalMs = arrivalMs;
  }

  /** Process the frame in the slot, if any. */
  tick(nowMs = this.clock()): BrainTick | null {
    const frame = this.slot;
    if (!frame) return null;
    this.slot = null;
    return this.processFrame(frame, nowMs, this.slotArrivalMs ?? nowMs);
  }

  /** Convenience for hosts that process synchronously: offer + tick. */
  process(frame: PoseFrame, nowMs = this.clock(), equipment?: EquipmentMeasurementFrame): BrainTick | null {
    if (equipment) this.noteEquipment(equipment);
    this.offer(frame, nowMs);
    return this.tick(nowMs);
  }

  private processFrame(frame: PoseFrame, nowMs: number, arrivalMs: number): BrainTick | null {
    const s = this.session;
    if (!s || !this.fsm.isActiveLike()) return null;
    // A heartbeat may advance the boundary after offer() but before the slot is consumed.
    if (frame.timestamp_ms < s.acceptFromMs) {
      s.telemetry.increment('discarded_frames');
      return null;
    }
    if (frame.session_id !== s.request.session_id) {
      throw new BrainError('SCHEMA_INVALID', `frame for session ${frame.session_id} offered to ${s.request.session_id}`, { recoverable: true });
    }
    if (!isContractCompatible(frame.schema_version)) throw new BrainError('CONTRACT_VERSION_INCOMPATIBLE', `pose frame contract ${frame.schema_version}`, { recoverable: false });
    s.acceptFromMs = Math.max(s.acceptFromMs, frame.timestamp_ms);
    const tel = s.telemetry;
    this.tickId++;
    s.stats.frames++;
    tel.frame(frame.timestamp_ms);
    const pack = s.ctx.pack.manifest;

    // 1. Quality gate (perception)
    const quality = tel.time('quality', () => gatePoseQuality(frame));
    if (!quality.ok) {
      for (const r of quality.reasons) tel.abstain(r);
      s.outbox.append('pose.quality', frame.timestamp_ms, { frame_id: frame.frame_id, ok: false, reasons: quality.reasons });
    }
    this.updateDegraded(quality.ok, frame.timestamp_ms, s);

    // 2. Signal
    const previousPose = s.signal.window.latest();
    const sig = tel.time('signal', () => s.signal.process(frame));
    if (sig.dropped) {
      tel.increment('dropped_inferences');
      return this.tickFor(frame, s, quality, { dropped: true, drop_reason: sig.drop_reason, time_gap: false, track_changed: false, normalization_valid: false, mirror_applied: false }, [], null, null, null, null, 'frame_dropped', nowMs, arrivalMs);
    }
    const continuityBroken = sig.time_gap || sig.track_changed;
    if (continuityBroken) {
      s.features.reset();
      s.repetition.reset();
      s.evaluator.reset();
      s.guidedEvaluator.reset();
      s.motionEvaluator.reset();
      s.motionObserver?.reset();
      s.referenceComparator?.reset();
      s.referenceState = null;
      s.guidedAttempt = null;
      s.guidedCompletion = null;
      s.equipment = null;
      // A new tracked subject cannot inherit the previous subject's personal variance baseline.
      if (sig.track_changed) s.evaluator.resetRepetitions();
      // Repeated static snapshots can support a verbal correction at a low
      // inference rate. This retains cue persistence/cooldown only, never pose
      // history: all temporal/scoring windows above have already been reset.
      const repeatedStaticObservation = this.config.guided_coaching && s.ctx.phase_graph.kind === 'static_hold' &&
        sig.time_gap && !sig.track_changed && quality.ok && sig.frame?.normalization_valid && previousPose?.normalization_valid &&
        previousPose.quality.framing_ok && !previousPose.quality.ambiguous_people && !previousPose.quality.track_changed && !previousPose.quality.missing_joints.length &&
        frame.timestamp_ms - previousPose.timestamp_ms <= this.config.camera_lost_ms;
      if (!repeatedStaticObservation) {
        if (s.ctx.phase_graph.kind === 'static_hold' && !sig.track_changed) s.policy.resetTechniqueEvidence();
        else s.policy.reset();
      }
      tel.increment(sig.time_gap ? 'time_gaps' : 'track_changes');
    }
    if (s.ctx.phase_graph.kind === 'static_hold' && (!quality.ok || !sig.frame?.normalization_valid)) s.policy.resetTechniqueEvidence();

    // 3. Features
    const featureMap = tel.time('features', () => s.features.compute(s.signal.window, s.featureCtx));
    const features = [...featureMap.values()];
    for (const f of features) if (!f.valid && f.reason) tel.abstain(`feature:${f.reason}`);

    // 3b. Class-agnostic repetition / periodicity (no sport knowledge; informs telemetry and UI)
    s.repetition.noteUnits(features);
    const repetition = tel.time('repetition', () => s.repetition.update(featureMap, frame.timestamp_ms));

    // 4. Temporal
    const temporal = tel.time('temporal', () => s.segmenter.update({
      frame_id: frame.frame_id,
      timestamp_ms: frame.timestamp_ms,
      features: featureMap,
      quality_ok: quality.ok,
      quality_reasons: quality.reasons,
      continuity_broken: continuityBroken,
    }));
    tel.recognition(temporal.state);
    if (temporal.completed) s.stats.completed++;
    if (temporal.aborted_reason) s.stats.aborted++;
    for (const ev of temporal.events) s.outbox.append('movement.event', frame.timestamp_ms, ev as unknown as Record<string, unknown>);

    // 5. Criteria + evidence
    const suppliedEquipment = s.equipment;
    const equipmentReason = suppliedEquipment ? equipmentFrameMismatch(suppliedEquipment, frame, s.featureCtx.view) : null;
    if (suppliedEquipment && suppliedEquipment.frame_id <= frame.frame_id) s.equipment = null;
    const equipment = suppliedEquipment ? equipmentReason ? { reason: equipmentReason } : { frame: suppliedEquipment } : undefined;
    let assessment = tel.time('scoring', () => s.evaluator.observe(temporal, featureMap, quality.ok, quality.reasons, equipment));
    const recognizedAssessment = assessment;
    if (!quality.ok || continuityBroken || !sig.frame?.normalization_valid || temporal.completed) {
      s.motionObserver?.reset();
      s.motionEvaluator.reset();
    }
    const motionAttempt = quality.ok && !continuityBroken && sig.frame?.normalization_valid && !temporal.completed
      ? s.motionObserver?.observe({ frame_id: frame.frame_id, timestamp_ms: frame.timestamp_ms, features: featureMap }) ?? null : null;
    // Slow inference still provides a usable current static posture. Temporal
    // history above is reset on every gap; this exception uses only this frame
    // and cannot confirm a hold, bridge a movement, or carry another athlete.
    const currentStaticObservation = s.ctx.phase_graph.kind === 'static_hold' && sig.frame?.normalization_valid && !sig.track_changed;
    let candidate = this.config.guided_coaching && quality.ok &&
      (currentStaticObservation || !continuityBroken && !temporal.aborted_reason)
      ? guidedPhase(s.ctx.phase_graph, s.ctx.feature_specs, featureMap, temporal) : null;
    const retainedCompletion = s.guidedCompletion;
    const stableEndpoint = retainedCompletion?.source === 'motion_bout' ? { cue_allowed: s.motionObserver?.reviewIsCurrent === true }
      : retainedCompletion ? guidedPhaseEnd(s.ctx.phase_graph, s.ctx.feature_specs, featureMap, retainedCompletion.phase_id) : null;
    s.guidedCompletion = retainedCompletion && quality.ok && !continuityBroken && (retainedCompletion.source === 'motion_bout' || !temporal.aborted_reason) &&
      frame.timestamp_ms - retainedCompletion.ended_ms <= GUIDED_REVIEW_MAX_AGE_MS && stableEndpoint?.cue_allowed === true &&
      (retainedCompletion.source === 'motion_bout' || !candidate || candidate.cue_allowed === true) ? retainedCompletion : null;
    const previousAttempt = s.guidedAttempt;
    const previousPhase = s.ctx.phase_graph.phases.find(p => p.id === previousAttempt?.phase_id);
    const expired = previousAttempt && !['rest', 'hold'].includes(previousPhase?.kind ?? '') && frame.timestamp_ms - previousAttempt.since_ms > (previousPhase?.max_duration_ms ?? s.ctx.phase_graph.window_ms ?? 4000);
    if (expired && candidate?.id === previousAttempt.phase_id) candidate = null;
    let completedGuidance: BrainTick['assessment'] = null;
    if (previousAttempt && previousAttempt.source !== 'motion_bout' && candidate?.id !== previousAttempt.phase_id && !expired && quality.ok && !continuityBroken && !temporal.aborted_reason) {
      const target = guidedPhaseEnd(s.ctx.phase_graph, s.ctx.feature_specs, featureMap, previousAttempt.phase_id);
      if (target) {
        completedGuidance = s.guidedEvaluator.completeGuided(temporal, previousAttempt.phase_id, previousAttempt.since_ms);
        if (completedGuidance) s.guidedCompletion = { ...previousAttempt, ended_ms: frame.timestamp_ms, cue_allowed: target.cue_allowed ?? !['action', 'contact'].includes(target.kind) };
      }
    }
    if (candidate) {
      if (s.guidedAttempt?.phase_id !== candidate.id || s.guidedAttempt.source === 'motion_bout') {
        s.guidedEvaluator.reset();
        s.guidedAttempt = { phase_id: candidate.id, since_ms: frame.timestamp_ms, cue_allowed: candidate.cue_allowed ?? !['action', 'contact'].includes(candidate.kind) };
      }
      const guidedAssessment = s.guidedEvaluator.observeGuided(temporal, featureMap, candidate.id, s.guidedAttempt.since_ms);
      if (!assessment || assessment.phase_id !== candidate.id) assessment = guidedAssessment;
    } else {
      s.guidedAttempt = null;
      s.guidedEvaluator.reset();
    }
    if (completedGuidance && !assessment) assessment = completedGuidance;
    // Preview motion intervals are independent of the correctness-gated phase
    // segmenter. They never modify temporal.completed or execution counters.
    const recognizedActivePhase = temporal.phase_id && !['IDLE', 'CANDIDATE'].includes(temporal.state) &&
      s.ctx.phase_graph.phases.some(p => p.id === temporal.phase_id && ['action', 'contact'].includes(p.kind));
    // Bout identity changes even while canonical phase evidence owns output.
    // Otherwise a hidden onset could reuse the previous bout's live samples.
    if (motionAttempt?.started || motionAttempt?.completed) s.motionEvaluator.reset();
    if (motionAttempt && !recognizedActivePhase) {
      const observation = { ...temporal, execution_id: null };
      let motionAssessment: BrainTick['assessment'] = null;
      for (const sample of motionAttempt.samples) {
        motionAssessment = s.motionEvaluator.observeGuided({ ...observation, frame_id: sample.frame_id, timestamp_ms: sample.timestamp_ms }, sample.features, motionAttempt.phase_id, motionAttempt.since_ms) ?? motionAssessment;
      }
      if (motionAttempt.completed) {
        motionAssessment = s.motionEvaluator.completeGuided(observation, motionAttempt.phase_id, motionAttempt.since_ms, motionAttempt.observed_end);
        s.guidedAttempt = null;
        s.guidedCompletion = motionAssessment ? { phase_id: motionAttempt.phase_id, since_ms: motionAttempt.since_ms, ended_ms: frame.timestamp_ms, cue_allowed: true, source: 'motion_bout' } : null;
      } else {
        s.guidedAttempt = { phase_id: motionAttempt.phase_id, since_ms: motionAttempt.since_ms, cue_allowed: false, source: 'motion_bout' };
        s.guidedCompletion = null;
      }
      if (!recognizedAssessment?.criteria.length || recognizedAssessment.phase_id !== motionAttempt.phase_id) assessment = motionAssessment;
    }
    if (recognizedActivePhase) {
      if (s.guidedAttempt?.source === 'motion_bout') s.guidedAttempt = null;
      if (s.guidedCompletion?.source === 'motion_bout') s.guidedCompletion = null;
      assessment = recognizedAssessment;
    }
    if (!motionAttempt && s.guidedCompletion?.source === 'motion_bout') s.guidedAttempt = null;
    // Recorded dynamic trajectories own body comparison when present. Generic
    // posture templates must not contradict the selected recorded movement.
    // The heuristic segmenter remains separate and never turns a reference
    // comparison into a recognized repetition or observed equipment contact.
    const referenceResult = s.referenceComparator?.observe({
      frame_id: frame.frame_id, timestamp_ms: frame.timestamp_ms, features: featureMap,
      quality_ok: quality.ok && !!sig.frame?.normalization_valid, continuity_broken: continuityBroken,
    }) ?? null;
    if (s.referenceComparator && s.referenceModel) {
      s.referenceState = referenceResult && quality.ok && !continuityBroken ? {
        status: referenceResult.status, progress: referenceResult.progress,
        reference_id: referenceResult.reference_id, attempt_id: referenceResult.attempt_id,
        cue_allowed: s.referenceComparator.cueAllowed, current: referenceResult.current, reason: referenceResult.reason ?? null,
        complete_capture: s.referenceModel.references.find(r => r.id === referenceResult.reference_id)?.complete_capture ?? false,
      } : null;
      // Waiting measures readiness for the next attempt, not technique. An
      // empty waiting verdict must not erase a supported completed correction
      // while coaching waits for a fresh quiet moment to speak.
      assessment = referenceResult && referenceResult.status !== 'waiting' && quality.ok && !continuityBroken && sig.frame?.normalization_valid
        ? dynamicReferenceAssessment(referenceResult, s.referenceModel, s.ctx.criteria.filter(c => c.evaluator.kind === 'dynamic_reference'), {
          session_id: s.request.session_id, sport_pack_id: pack.id, sport_pack_version: pack.version,
          rubric_version: s.ctx.pack.technique_criteria.rubric_version, movement_id: s.ctx.movement.id,
          view: s.featureCtx.view, strict: this.config.strict_rubrics, allow_draft_feedback: this.config.allow_draft_feedback,
        }, frame.frame_id, frame.timestamp_ms) : null;
      s.guidedAttempt = null;
      s.guidedCompletion = null;
    }
    if (assessment) {
      s.stats.assessments++;
      s.stats.lastScore = assessment.score;
      tel.coverage(assessment.coverage.ratio);
      for (const c of assessment.criteria) {
        s.stats.states[c.state] = (s.stats.states[c.state] ?? 0) + 1;
        if (c.state !== 'PASS' && c.state !== 'IMPROVE' && c.measurement.reason) tel.abstain(`criterion:${c.measurement.reason}`);
      }
      s.outbox.append('assessment.set', frame.timestamp_ms, assessment as unknown as Record<string, unknown>);
    }

    // 6. Coaching
    const degraded = this.fsm.state === 'DEGRADED';
    // Recognition-gated coaching: measurements continue, but technique cues pause while the athlete is confidently
    // recognised doing a different kind of movement from the selected drill; a quality instruction explains why.
    const mismatch = this.recognitionMismatch(s, frame.timestamp_ms);
    if (mismatch) tel.abstain('coaching:movement_mismatch');
    const feedback = assessment?.retrospective ? null : tel.time('coaching', () => s.policy.decide({
      timestamp_ms: frame.timestamp_ms,
      frame_id: frame.frame_id,
      assessment,
      quality_ok: quality.ok && !mismatch,
      quality_reasons: mismatch ? [...quality.reasons, 'MOVEMENT_NOT_CONFIRMED'] : quality.reasons,
      cue_allowed: (s.referenceComparator ? s.referenceComparator.cueAllowed : s.guidedAttempt ? s.guidedAttempt.cue_allowed : s.guidedCompletion ? s.guidedCompletion.cue_allowed : temporal.cue_allowed) && !degraded,
      recognition_state: temporal.state,
      movement_id: s.ctx.movement.id,
      evidence_scope: referenceResult?.attempt_id ?? assessment?.execution_id ?? (s.guidedAttempt?.source === 'motion_bout' ? `motion:${s.guidedAttempt.since_ms}`
        : s.guidedCompletion?.source === 'motion_bout' ? `motion:${s.guidedCompletion.since_ms}` : temporal.execution_id),
      deferred_cue_allowed: s.referenceComparator ? s.referenceComparator.cueAllowed : s.motionObserver?.deferredCueSafe ?? false,
    }));
    if (feedback) {
      s.stats.feedback++;
      s.outbox.append('feedback.action', frame.timestamp_ms, feedback as unknown as Record<string, unknown>);
    }

    return this.tickFor(
      frame, s, quality,
      { dropped: false, time_gap: sig.time_gap, track_changed: sig.track_changed, normalization_valid: sig.frame?.normalization_valid ?? false, mirror_applied: sig.frame?.mirror_applied ?? false },
      features, temporal, repetition, assessment, feedback, feedback ? null : (assessment?.retrospective ? 'retrospective_equipment' : degraded ? 'degraded' : s.policy.lastSuppressedReason), nowMs, arrivalMs,
      this.config.emit_landmarks ? sig.frame?.body : undefined,
    );
  }

  private tickFor(
    frame: PoseFrame, s: ActiveSession, quality: { ok: boolean; reasons: MissingReason[] }, signal: BrainTick['signal'],
    features: BrainTick['features'], temporal: TemporalUpdate | null, repetition: BrainTick['repetition'], assessment: BrainTick['assessment'], feedback: BrainTick['feedback'],
    suppressed: string | null, nowMs: number, arrivalMs: number, landmarks?: BrainTick['body_landmarks'],
  ): BrainTick {
    const pack = s.ctx.pack.manifest;
    let telemetry = null;
    if (s.lastTelemetryMs === null || nowMs - s.lastTelemetryMs >= this.config.telemetry_interval_ms) {
      s.lastTelemetryMs = nowMs;
      telemetry = s.telemetry.sample(s.request.session_id, frame.timestamp_ms, nowMs - arrivalMs, this.router.executedPacks(s.request.session_id));
      s.outbox.append('telemetry.sample', frame.timestamp_ms, telemetry as unknown as Record<string, unknown>);
    }
    return {
      tick_id: this.tickId,
      frame_id: frame.frame_id,
      timestamp_ms: frame.timestamp_ms,
      session_state: this.fsm.state,
      quality,
      signal,
      features,
      temporal,
      repetition,
      assessment,
      dynamic_reference: quality.ok && !signal.dropped && !signal.time_gap && !signal.track_changed ? s.referenceState : null,
      guided_attempt: quality.ok && !signal.dropped && !signal.track_changed &&
        (!signal.time_gap || s.ctx.phase_graph.kind === 'static_hold' && signal.normalization_valid) ? s.guidedAttempt : null,
      guided_completion: quality.ok && !signal.dropped && !signal.time_gap && !signal.track_changed ? s.guidedCompletion : null,
      feedback,
      suppressed_reason: suppressed,
      executed_pack: { id: pack.id, version: pack.version },
      telemetry,
      body_landmarks: landmarks,
    };
  }

  private updateDegraded(qualityOk: boolean, frameTs: number, s: ActiveSession): void {
    if (!qualityOk) {
      s.goodQualityFrames = 0;
      if (s.badQualitySinceMs === null) s.badQualitySinceMs = frameTs;
      if (this.fsm.state === 'ACTIVE' && frameTs - s.badQualitySinceMs >= this.config.degraded_after_ms) {
        // This transition is caused by the capture, as are the following frame events.
        this.fsm.transition('DEGRADED', frameTs, 'insufficient_visibility', 'DEGRADED_INPUT');
      }
      return;
    }
    s.badQualitySinceMs = null;
    s.goodQualityFrames++;
    if (this.fsm.state === 'DEGRADED' && s.goodQualityFrames >= this.config.revalidate_frames) {
      this.fsm.transition('ACTIVE', frameTs, 'revalidated');
    }
  }

  // ---------------------------------------------------------------------------
  // Outbox / telemetry
  // ---------------------------------------------------------------------------

  drainOutbox(max = 200) {
    return this.session?.outbox.drain(max) ?? [];
  }

  ackOutbox(eventIds: string[]): void {
    this.session?.outbox.ack(eventIds);
  }

  outboxPending(): number {
    return this.session?.outbox.pending() ?? 0;
  }

  telemetry(nowMs = this.clock()) {
    const s = this.session;
    if (!s) return null;
    return s.telemetry.sample(s.request.session_id, nowMs, 0, this.router.executedPacks(s.request.session_id));
  }

  summary(): SessionSummary {
    const s = this.session;
    if (!s) throw new BrainError('INVALID_TRANSITION', 'no session', { recoverable: true });
    const tel = s.telemetry.sample(s.request.session_id, 0, 0, []);
    return {
      session_id: s.request.session_id,
      sport_pack_id: s.ctx.pack.manifest.id,
      sport_pack_version: s.ctx.pack.manifest.version,
      movement_id: s.ctx.movement.id,
      frames_processed: s.stats.frames,
      frames_discarded: tel.discarded_frames,
      executions_completed: s.stats.completed,
      executions_aborted: s.stats.aborted,
      assessments: s.stats.assessments,
      feedback_issued: s.stats.feedback,
      last_score: s.stats.lastScore,
      criterion_state_counts: { ...s.stats.states },
      abstention_reasons: tel.abstention_reasons,
      outbox_pending: s.outbox.pending(),
      transitions: this.transitionLog.length,
    };
  }

  /** Active sport context (read-only view for hosts). */
  context(): SportContext | null {
    return this.session?.ctx ?? null;
  }
}
