import {
  CONTRACT_VERSION, makeEventId, type MissingReason, type MovementEvent, type PhaseDefinition, type PhaseGraph, type RecognitionState,
} from '@apexformz/contracts';
import type { FeatureMap } from '@apexformz/features';
import { evaluateConditions } from './conditions';
import type { PhaseSpan, TemporalSessionContext, TemporalUpdate } from './types';

export interface SegmenterInput {
  frame_id: number;
  timestamp_ms: number;
  features: FeatureMap;
  /** False when pose quality forbids recognition (ambiguous subject, framing, track change). */
  quality_ok: boolean;
  quality_reasons?: MissingReason[];
  /** True when the signal pipeline reported a time gap or track change for this frame. */
  continuity_broken?: boolean;
}

interface HoldTracker {
  target: string;
  since_ms: number;
}

/**
 * Deterministic, causal phase segmenter driven entirely by the sport pack's
 * phase graph (TRD 10). Implements the recognition state machine
 *   IDLE -> CANDIDATE -> CONFIRMED -> EXECUTING -> COMPLETE | ABORTED, plus UNKNOWN,
 * with hysteresis (hold_ms), minimum phase durations, timeouts and no
 * future-frame access. Static holds use the same machine with one phase.
 *
 * Generalises the legacy ApexFormz PhaseDetector (trigger hold, minimum gap,
 * optional one-phase lookahead) without any sport-specific values.
 */
export class PhaseSegmenter {
  private state: RecognitionState = 'IDLE';
  private phase: PhaseDefinition | null = null;
  private phaseEnteredMs: number | null = null;
  private phaseEnteredFrame: number | null = null;
  private hold: HoldTracker | null = null;
  private execution: PhaseSpan[] = [];
  private executionId: string | null = null;
  private executionStartMs: number | null = null;
  private executions = 0;
  private sequence = 0;
  private lastFrameId: number | null = null;
  private lastUpdate: TemporalUpdate | null = null;
  private invalidSinceMs: number | null = null;
  private restExitSinceMs: number | null = null;
  private evidence: number[] = [];
  private readonly phases: Map<string, PhaseDefinition>;
  private readonly edges: Map<string, string[]>;
  private readonly isStatic: boolean;

  constructor(
    private readonly graph: PhaseGraph,
    private readonly ctx: TemporalSessionContext,
    private readonly options: { unknown_after_ms?: number; max_evidence_frames?: number; rest_exit_grace_ms?: number } = {},
  ) {
    this.phases = new Map(graph.phases.map((p) => [p.id, p]));
    this.edges = new Map();
    for (const p of graph.phases) this.edges.set(p.id, []);
    for (const e of graph.edges) this.edges.get(e.from)?.push(e.to);
    this.isStatic = graph.kind === 'static_hold';
  }

  get currentState(): RecognitionState {
    return this.state;
  }

  get currentPhaseId(): string | null {
    return this.phase?.id ?? null;
  }

  /** Reset temporal state (time gap, track change, suspend/resume). Aborts any execution. */
  reset(reason: string, timestampMs: number, frameId: number): MovementEvent | null {
    let ev: MovementEvent | null = null;
    if (this.state === 'EXECUTING' || this.state === 'CONFIRMED' || this.state === 'CANDIDATE') {
      ev = this.event('ABORTED', timestampMs, frameId, { end_ms: timestampMs, unknown_reason: reason });
    }
    this.state = 'IDLE';
    this.phase = null;
    this.phaseEnteredMs = null;
    this.phaseEnteredFrame = null;
    this.hold = null;
    this.execution = [];
    this.executionId = null;
    this.executionStartMs = null;
    this.invalidSinceMs = null;
    this.restExitSinceMs = null;
    this.evidence = [];
    return ev;
  }

  update(input: SegmenterInput): TemporalUpdate {
    // Idempotent per frame.
    if (this.lastUpdate && this.lastFrameId === input.frame_id) return { ...this.lastUpdate, events: [] };
    this.lastFrameId = input.frame_id;
    const events: MovementEvent[] = [];
    const previousState = this.state;
    const previousPhaseId = this.phase?.id ?? null;
    let endedPhase: PhaseSpan | null = null;
    let completed = false;
    let abortedReason: string | null = null;
    let unknownReason: string | null = null;
    let phaseChanged = false;
    const blocked: MissingReason[] = [];
    const t = input.timestamp_ms;

    if (input.continuity_broken) {
      const ev = this.reset('TIME_GAP', t, input.frame_id);
      if (ev) events.push(ev);
      abortedReason = previousState !== 'IDLE' ? 'TIME_GAP' : null;
    } else if (!input.quality_ok) {
      if (this.state === 'EXECUTING' || this.state === 'CONFIRMED' || this.state === 'CANDIDATE') {
        const ev = this.reset(input.quality_reasons?.[0] ?? 'DEGRADED_INPUT', t, input.frame_id);
        if (ev) events.push(ev);
        abortedReason = input.quality_reasons?.[0] ?? 'DEGRADED_INPUT';
      }
      blocked.push(...(input.quality_reasons ?? []));
    } else {
      this.trackEvidence(input.frame_id);
      const result = this.step(input, events);
      endedPhase = result.endedPhase;
      completed = result.completed;
      abortedReason = result.abortedReason;
      unknownReason = result.unknownReason;
      phaseChanged = result.phaseChanged;
      blocked.push(...result.blocked);
    }

    const update: TemporalUpdate = {
      frame_id: input.frame_id,
      timestamp_ms: t,
      state: this.state,
      previous_state: previousState,
      movement_id: this.ctx.movement_id,
      phase_id: this.phase?.id ?? null,
      previous_phase_id: previousPhaseId,
      phase_changed: phaseChanged,
      phase_entered_ms: this.phaseEnteredMs,
      phase_duration_ms: this.phaseEnteredMs !== null ? t - this.phaseEnteredMs : null,
      ended_phase: endedPhase,
      execution_id: this.executionId,
      execution_started_ms: this.executionStartMs,
      completed,
      aborted_reason: abortedReason,
      unknown_reason: unknownReason,
      confidence: this.confidence(input.features),
      evidence_frames: [...this.evidence],
      execution_phases: this.execution.map((s) => ({ ...s })),
      cue_allowed: this.phase ? (this.phase.cue_allowed ?? (this.phase.kind !== 'action' && this.phase.kind !== 'contact')) : true,
      contact_evidence: this.phase?.contact_evidence ?? 'none',
      events,
      blocked_reasons: [...new Set(blocked)],
    };
    this.lastUpdate = update;
    if (completed || abortedReason) {
      // After completion/abort the machine is idle again for the next frame.
      if (completed) this.finishExecution();
    }
    return update;
  }

  // ---------------------------------------------------------------------------

  private step(input: SegmenterInput, events: MovementEvent[]) {
    const t = input.timestamp_ms;
    let endedPhase: PhaseSpan | null = null;
    let completed = false;
    let abortedReason: string | null = null;
    let unknownReason: string | null = null;
    let phaseChanged = false;
    const blocked: MissingReason[] = [];
    const initial = this.phases.get(this.graph.initial)!;

    if (this.state === 'IDLE' || this.state === 'COMPLETE' || this.state === 'ABORTED' || this.state === 'UNKNOWN') {
      const r = evaluateConditions(initial.enter, input.features);
      if (!r.evaluable) blocked.push(...r.reasons);
      if (r.all_satisfied) {
        this.enterPhase(initial, t, input.frame_id, false);
        this.state = 'CANDIDATE';
        this.hold = { target: initial.id, since_ms: t };
        events.push(this.event('CANDIDATE', t, input.frame_id));
      } else {
        this.state = 'IDLE';
      }
      return { endedPhase, completed, abortedReason, unknownReason, phaseChanged, blocked };
    }

    if (this.state === 'CANDIDATE') {
      const r = evaluateConditions(initial.enter, input.features);
      if (!r.evaluable) blocked.push(...r.reasons);
      if (!r.all_satisfied) {
        // Candidate dropped before confirmation: back to idle silently (no execution started).
        this.state = 'IDLE';
        this.phase = null;
        this.phaseEnteredMs = null;
        this.hold = null;
        return { endedPhase, completed, abortedReason, unknownReason, phaseChanged, blocked };
      }
      const needed = this.graph.confirm_hold_ms ?? initial.hold_ms ?? 0;
      if (t - (this.hold?.since_ms ?? t) >= needed) {
        this.state = 'CONFIRMED';
        this.hold = null;
        if (this.isStatic) {
          this.startExecution(t, initial.id);
        }
        events.push(this.event('CONFIRMED', t, input.frame_id));
      }
      return { endedPhase, completed, abortedReason, unknownReason, phaseChanged, blocked };
    }

    // CONFIRMED or EXECUTING
    const current = this.phase!;
    const inPhaseMs = t - (this.phaseEnteredMs ?? t);

    if (this.isStatic) {
      const r = evaluateConditions(current.enter, input.features);
      if (!r.evaluable) {
        blocked.push(...r.reasons);
        if (this.invalidSinceMs === null) this.invalidSinceMs = t;
        if (t - this.invalidSinceMs > (this.options.unknown_after_ms ?? 1000)) {
          unknownReason = 'FEATURES_INVALID';
          events.push(this.event('UNKNOWN', t, input.frame_id, { unknown_reason: unknownReason }));
          this.abort(t, input.frame_id);
          abortedReason = 'FEATURES_INVALID';
        }
        return { endedPhase, completed, abortedReason, unknownReason, phaseChanged, blocked };
      }
      this.invalidSinceMs = null;
      if (!r.all_satisfied) {
        if (inPhaseMs >= current.min_duration_ms) {
          endedPhase = this.closePhase(t, input.frame_id);
          completed = true;
          this.state = 'COMPLETE';
          events.push(this.event('COMPLETE', t, input.frame_id, { end_ms: t }));
        } else {
          this.abort(t, input.frame_id);
          abortedReason = 'HOLD_TOO_SHORT';
          events.push(this.event('ABORTED', t, input.frame_id, { end_ms: t, unknown_reason: abortedReason }));
        }
      }
      return { endedPhase, completed, abortedReason, unknownReason, phaseChanged, blocked };
    }

    // Dynamic sequence --------------------------------------------------------
    if (current.max_duration_ms != null && inPhaseMs > current.max_duration_ms && this.state === 'EXECUTING') {
      abortedReason = 'PHASE_TIMEOUT';
      events.push(this.event('ABORTED', t, input.frame_id, { end_ms: t, unknown_reason: abortedReason }));
      this.abort(t, input.frame_id);
      return { endedPhase, completed, abortedReason, unknownReason, phaseChanged, blocked };
    }
    if (this.state === 'EXECUTING' && this.graph.abort_timeout_ms != null && this.executionStartMs !== null && t - this.executionStartMs > this.graph.abort_timeout_ms) {
      abortedReason = 'EXECUTION_TIMEOUT';
      events.push(this.event('ABORTED', t, input.frame_id, { end_ms: t, unknown_reason: abortedReason }));
      this.abort(t, input.frame_id);
      return { endedPhase, completed, abortedReason, unknownReason, phaseChanged, blocked };
    }

    const targets = this.candidateTargets(current.id);
    let anyEvaluable = false;
    for (const targetId of targets) {
      const target = this.phases.get(targetId)!;
      if (targetId === this.graph.initial) continue; // repetition edge handled after completion
      const r = evaluateConditions(target.enter, input.features);
      if (!r.evaluable) {
        blocked.push(...r.reasons);
        continue;
      }
      anyEvaluable = true;
      if (!r.all_satisfied) {
        if (this.hold?.target === targetId) this.hold = null;
        continue;
      }
      if (inPhaseMs < current.min_duration_ms) continue;
      if (!this.hold || this.hold.target !== targetId) this.hold = { target: targetId, since_ms: t };
      const needed = target.hold_ms ?? 0;
      if (t - this.hold.since_ms < needed) continue;

      // Transition.
      endedPhase = this.closePhase(t, input.frame_id);
      if (this.state === 'CONFIRMED') {
        this.startExecution(t, current.id, endedPhase);
        this.state = 'EXECUTING';
      }
      this.enterPhase(target, t, input.frame_id, true);
      phaseChanged = true;
      this.hold = null;
      events.push(this.event('EXECUTING', t, input.frame_id));
      if (this.graph.terminal.includes(target.id) && target.min_duration_ms === 0) {
        completed = this.complete(t, input.frame_id, events);
        endedPhase = this.execution[this.execution.length - 1] ?? endedPhase;
      }
      break;
    }

    if (!phaseChanged && this.state === 'EXECUTING' && this.graph.terminal.includes(current.id) && inPhaseMs >= current.min_duration_ms) {
      endedPhase = this.closePhase(t, input.frame_id);
      completed = this.complete(t, input.frame_id, events);
    }

    if (!anyEvaluable && targets.length) {
      if (this.invalidSinceMs === null) this.invalidSinceMs = t;
      if (this.state === 'EXECUTING' && t - this.invalidSinceMs > (this.options.unknown_after_ms ?? 1000)) {
        unknownReason = 'FEATURES_INVALID';
        events.push(this.event('UNKNOWN', t, input.frame_id, { unknown_reason: unknownReason }));
        this.abort(t, input.frame_id);
        abortedReason = 'FEATURES_INVALID';
      }
    } else {
      this.invalidSinceMs = null;
    }

    if (this.state === 'CONFIRMED' && !phaseChanged) {
      // Still in the initial (rest) phase. Leaving the rest condition is normal while the athlete
      // transitions toward the first action phase, so only drop back to IDLE after a grace period
      // with no target phase in progress (the athlete walked away rather than started moving).
      const r = evaluateConditions(current.enter, input.features);
      if (r.evaluable && !r.all_satisfied && !this.hold) {
        if (this.restExitSinceMs === null) this.restExitSinceMs = t;
        const grace = this.graph.abort_timeout_ms ?? this.options.rest_exit_grace_ms ?? 2000;
        if (t - this.restExitSinceMs > Math.min(grace, this.options.rest_exit_grace_ms ?? 2000)) {
          this.state = 'IDLE';
          this.phase = null;
          this.phaseEnteredMs = null;
          this.restExitSinceMs = null;
        }
      } else {
        this.restExitSinceMs = null;
      }
    }
    return { endedPhase, completed, abortedReason, unknownReason, phaseChanged, blocked };
  }

  private candidateTargets(from: string): string[] {
    const direct = this.edges.get(from) ?? [];
    if (!this.graph.allow_skip) return direct;
    const skip = direct.flatMap((d) => this.edges.get(d) ?? []).filter((x) => x !== this.graph.initial && !direct.includes(x));
    return [...direct, ...skip];
  }

  private enterPhase(p: PhaseDefinition, t: number, frameId: number, record: boolean): void {
    this.phase = p;
    this.phaseEnteredMs = t;
    this.phaseEnteredFrame = frameId;
    if (record) this.execution.push({ phase_id: p.id, start_ms: t, end_ms: null, start_frame: frameId, end_frame: null });
  }

  private closePhase(t: number, frameId: number): PhaseSpan | null {
    const open = this.execution.find((s) => s.end_ms === null);
    if (open) {
      open.end_ms = t;
      open.end_frame = frameId;
      return { ...open };
    }
    if (this.phase && this.phaseEnteredMs !== null) {
      return { phase_id: this.phase.id, start_ms: this.phaseEnteredMs, end_ms: t, start_frame: this.phaseEnteredFrame ?? frameId, end_frame: frameId };
    }
    return null;
  }

  private startExecution(t: number, initialPhaseId: string, restSpan?: PhaseSpan | null): void {
    this.executions++;
    this.executionId = `${this.ctx.session_id}:exec:${this.executions}`;
    this.executionStartMs = t;
    this.execution = [];
    if (this.isStatic) {
      this.execution.push({ phase_id: initialPhaseId, start_ms: this.phaseEnteredMs ?? t, end_ms: null, start_frame: this.phaseEnteredFrame ?? 0, end_frame: null });
    } else if (restSpan) {
      this.execution.push({ ...restSpan });
    }
  }

  private complete(t: number, frameId: number, events: MovementEvent[]): boolean {
    this.state = 'COMPLETE';
    events.push(this.event('COMPLETE', t, frameId, { end_ms: t }));
    return true;
  }

  private finishExecution(): void {
    this.phase = null;
    this.phaseEnteredMs = null;
    this.phaseEnteredFrame = null;
    this.hold = null;
    this.executionId = null;
    this.executionStartMs = null;
    this.execution = [];
    this.evidence = [];
  }

  private abort(t: number, frameId: number): void {
    this.closePhase(t, frameId);
    this.state = 'ABORTED';
    this.finishExecution();
  }

  private trackEvidence(frameId: number): void {
    const max = this.options.max_evidence_frames ?? 120;
    this.evidence.push(frameId);
    if (this.evidence.length > max) this.evidence.splice(0, this.evidence.length - max);
  }

  private confidence(features: FeatureMap): number {
    if (!this.phase) return 0;
    const r = evaluateConditions(this.phase.enter, features);
    if (!r.evaluable) return 0;
    const holdBoost = this.state === 'EXECUTING' || this.state === 'CONFIRMED' ? 1 : 0.5;
    return Math.max(0, Math.min(1, r.confidence * holdBoost));
  }

  private event(state: RecognitionState, t: number, frameId: number, extra: Partial<MovementEvent> = {}): MovementEvent {
    this.sequence++;
    return {
      schema_version: CONTRACT_VERSION,
      session_id: this.ctx.session_id,
      event_id: makeEventId(`${this.ctx.session_id}:mv`, this.sequence),
      execution_id: this.executionId,
      movement_id: this.ctx.movement_id,
      phase_id: this.phase?.id ?? null,
      start_ms: this.phaseEnteredMs ?? t,
      end_ms: extra.end_ms ?? null,
      confidence: 1,
      evidence_frames: this.evidence.slice(-30).concat(frameId),
      state,
      model_version: this.ctx.model_version,
      unknown_reason: extra.unknown_reason ?? null,
      contact_evidence: this.phase?.contact_evidence ?? 'none',
      retrospective: false,
      sport_pack_id: this.ctx.sport_pack_id,
      sport_pack_version: this.ctx.sport_pack_version,
    };
  }
}
