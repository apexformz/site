import {
  CONTRACT_VERSION, makeEventId,
  type AssessmentSet, type AthleteContext, type Capability, type Coverage, type CriterionDefinition, type CriterionEvidence,
  type EquipmentMeasurementFrame, type FeedbackTemplates, type FeatureSpec, type Handedness, type MissingReason, type PhaseGraph, type Unit, type ViewLabel,
} from '@apexformz/contracts';
import type { FeatureMap } from '@apexformz/features';
import type { TemporalUpdate } from '@apexformz/analysis';
import { PhaseAccumulator, type FeatureSample, type PhaseFeatureStats } from './accumulator';
import { aggregateSamples, scoreAgainst, type Verdict } from './rules';
import { DEFAULT_HUMAN_VARIANCE, RepetitionVarianceTracker, varianceBand, zoneFor, type HumanVarianceConfig } from './variance';

export interface ScoringContext {
  session_id: string;
  sport_pack_id: string;
  sport_pack_version: string;
  rubric_version: string;
  view: ViewLabel;
  athlete_context: AthleteContext;
  capabilities_available: Capability[];
  /** Strict: provisional rubrics abstain (UNCERTAIN). Non-strict: evaluate but mark provisional. */
  strict_rubrics: boolean;
  /** Allow draft (unreviewed) feedback text to be attached to IMPROVE results. */
  allow_draft_feedback: boolean;
  minimum_coverage: number;
  /** Resolved human variance model (core defaults <- pack rubric profile <- runtime overrides). */
  human_variance: HumanVarianceConfig;
  /** Static-hold live evaluation interval. */
  live_interval_ms?: number;
  /** Live posture feedback inside recognized dynamic phases. Timing remains boundary-only. */
  guided_coaching?: boolean;
  /** Optional reference-set models keyed by manifest path. */
  models?: Record<string, unknown>;
  /** Declared geometry for reference/rubric target consistency checks. */
  feature_specs?: FeatureSpec[];
  featureUnit: (featureId: string) => Unit;
  locale?: string;
}

export interface ReferenceSetModel {
  features: string[];
  reference_vectors: Array<Array<number | null>>;
  /** Optional metadata is aligned one-to-one with reference_vectors. Legacy models omit it. */
  reference_views?: ViewLabel[];
  reference_handedness?: Handedness[];
  reference_handedness_assumed?: boolean[];
  unit?: Unit;
  weights?: number[];
  threshold: number;
  tolerance?: number;
  validation_status?: string;
}

/**
 * Criterion evaluator with abstention (TRD 11). Produces CriterionEvidence with
 * one of PASS / IMPROVE / UNCERTAIN / NOT_ASSESSABLE / NOT_APPLICABLE and a
 * coverage-gated AssessmentSet. No blind averaging: every criterion carries
 * its own measurement, reason and provenance.
 */
export class CriterionEvaluator {
  private readonly acc = new PhaseAccumulator();
  private equipmentByPhase = new Map<string, EquipmentMeasurementFrame[]>();
  private equipmentReasons = new Map<string, MissingReason>();
  private executionResults = new Map<string, CriterionEvidence>();
  private executionId: string | null = null;
  private lastLiveMs: number | null = null;
  private sequence = 0;
  private consecutiveSatisfied = new Map<string, number[]>();
  private readonly repetitions: RepetitionVarianceTracker;
  private readonly hv: HumanVarianceConfig;

  constructor(
    private readonly criteria: CriterionDefinition[],
    private readonly graph: PhaseGraph,
    private readonly feedback: FeedbackTemplates,
    private readonly ctx: ScoringContext,
  ) {
    this.hv = ctx.human_variance ?? DEFAULT_HUMAN_VARIANCE;
    this.repetitions = new RepetitionVarianceTracker(this.hv.consistency);
  }

  /** Reset per-execution state. The athlete's repetition history is kept: it is session-level evidence. */
  reset(): void {
    this.acc.reset();
    this.equipmentByPhase.clear();
    this.equipmentReasons.clear();
    this.executionResults.clear();
    this.executionId = null;
    this.lastLiveMs = null;
    this.consecutiveSatisfied.clear();
  }

  /** Forget the athlete's repetition history (new session or new athlete). */
  resetRepetitions(): void {
    this.repetitions.reset();
  }

  /**
   * Feed one frame. Returns an AssessmentSet when a phase ends, when a static
   * hold is live-evaluated, or when an execution completes; null otherwise.
   */
  observe(update: TemporalUpdate, features: FeatureMap, qualityOk: boolean, qualityReasons: MissingReason[] = [], equipment?: { frame?: EquipmentMeasurementFrame; reason?: MissingReason }): AssessmentSet | null {
    if (update.execution_id && update.execution_id !== this.executionId) {
      this.acc.reset();
      this.equipmentByPhase.clear();
      this.equipmentReasons.clear();
      this.executionResults.clear();
      this.executionId = update.execution_id;
      this.lastLiveMs = null;
    }
    const active = update.state === 'EXECUTING' || update.state === 'CONFIRMED' || update.state === 'COMPLETE';
    if (active && update.phase_id) this.acc.observe(update.phase_id, features, update.frame_id, update.timestamp_ms, qualityOk, qualityReasons);
    if (active && update.phase_id && equipment) {
      if (qualityOk && equipment.frame) {
        const list = this.equipmentByPhase.get(update.phase_id) ?? [];
        list.push(equipment.frame);
        this.equipmentByPhase.set(update.phase_id, list);
      } else if (equipment.reason) this.equipmentReasons.set(update.phase_id, equipment.reason);
    }

    if (update.aborted_reason) {
      this.reset();
      return null;
    }

    const isStatic = this.graph.kind === 'static_hold';
    let shouldEmit = false;

    if (update.ended_phase) {
      for (const c of this.criteria) {
        if (!this.criterionAppliesToPhase(c, update.ended_phase.phase_id)) continue;
        this.executionResults.set(c.criterion_id, this.evaluateCriterion(c, update, [update.ended_phase.phase_id], update.ended_phase.end_ms ?? update.timestamp_ms));
      }
      shouldEmit = true;
    }

    const livePhase = this.graph.phases.find(p => p.id === update.phase_id);
    if ((isStatic && update.state === 'CONFIRMED' || this.ctx.guided_coaching && active && livePhase && (update.phase_duration_ms ?? 0) >= (livePhase.min_duration_ms ?? 0)) && update.phase_id) {
      const interval = this.ctx.live_interval_ms ?? 500;
      if ((!this.ctx.guided_coaching || this.acc.frames(update.phase_id).length >= 3) && (this.lastLiveMs === null || update.timestamp_ms - this.lastLiveMs >= interval)) {
        this.lastLiveMs = update.timestamp_ms;
        let liveEvaluated = false;
        for (const c of this.criteria) {
          if (!this.criterionAppliesToPhase(c, update.phase_id)) continue;
          // A peak already beyond its upper bound cannot become acceptable as
          // more samples arrive. Other whole-phase verdicts still need an end.
          const partialPeak = !isStatic && this.irreversiblePeak(c);
          if (!isStatic && (['phase_duration', 'ordering'].includes(c.evaluator.kind) || c.evaluator.aggregate?.startsWith('phase_') && !partialPeak)) continue;
          const evidence = this.evaluateCriterion(c, update, [update.phase_id], update.timestamp_ms);
          if (partialPeak && !this.supportedPeakViolation(c, evidence, update.phase_id)) continue;
          this.executionResults.set(c.criterion_id, partialPeak ? this.partialPeakEvidence(evidence) : evidence);
          liveEvaluated = true;
        }
        shouldEmit ||= liveEvaluated;
      }
    }

    if (update.completed) {
      const phaseIds = update.execution_phases.map((p) => p.phase_id);
      for (const c of this.criteria) {
        if (c.phase_ids === null) {
          this.executionResults.set(c.criterion_id, this.evaluateCriterion(c, update, phaseIds, update.timestamp_ms));
        } else if (!this.executionResults.has(c.criterion_id)) {
          this.executionResults.set(c.criterion_id, this.abstain(c, update, 'NOT_ASSESSABLE', 'PHASE_NOT_ACTIVE', update.timestamp_ms, []));
        }
      }
      shouldEmit = true;
    }

    if (!shouldEmit) return null;
    const set = this.buildSet(update, [...this.executionResults.values()]);
    // Guided static feedback follows the current attempt rather than averaging
    // a corrected posture with minutes of earlier errors in the same hold.
    if (isStatic && this.ctx.guided_coaching) this.acc.reset();
    if (update.completed) this.reset();
    return set;
  }

  /** Isolated guided observer: callers use a separate evaluator so guessed setup evidence never enters execution scoring. */
  observeGuided(update: TemporalUpdate, features: FeatureMap, phaseId: string, sinceMs: number): AssessmentSet | null {
    const phase = this.graph.phases.find(p => p.id === phaseId)!;
    const currentObservation = this.graph.kind === 'static_hold' || ['rest', 'hold'].includes(phase.kind);
    const stationary = currentObservation || ['rest', 'hold'].includes(phase.kind);
    // Static coaching compares the current geometry while the athlete adjusts.
    // A single observation is explicit evidence, not a sustained or completed
    // hold. Never average the old incorrect pose into its current correction.
    if (currentObservation) this.acc.reset();
    this.acc.observe(phaseId, features, update.frame_id, update.timestamp_ms, true);
    const eligible = this.criteria.filter(c => this.criterionAppliesToPhase(c, phaseId) &&
      !['phase_duration', 'equipment_dependent', 'ordering'].includes(c.evaluator.kind) &&
      (this.graph.kind === 'static_hold' || !c.evaluator.aggregate?.startsWith('phase_') || stationary && c.evaluator.aggregate === 'phase_mean' || this.irreversiblePeak(c)));
    if (!eligible.length) { if (stationary) this.acc.reset(); return null; }
    const interval = this.ctx.live_interval_ms ?? 500;
    const minimum = currentObservation ? 0 : Math.max(stationary || phaseId === this.graph.initial ? interval : 0, phase.hold_ms ?? 0, phase.min_duration_ms ?? 0);
    if (update.timestamp_ms - sinceMs < minimum || !currentObservation && this.acc.frames(phaseId).length < 3) return null;
    if (this.lastLiveMs !== null && update.timestamp_ms - this.lastLiveMs < interval) return null;
    this.lastLiveMs = update.timestamp_ms;
    // Intention supplies the target, not evidence that a phase/execution was recognized.
    const observation = { ...update, phase_id: phaseId, ended_phase: null, confidence: 0 };
    const criteria = eligible.map(c => {
      const evidence = this.evaluateCriterion(c, observation, [phaseId], update.timestamp_ms);
      if (!currentObservation && this.irreversiblePeak(c) && !this.supportedPeakViolation(c, evidence, phaseId)) return null;
      return { ...evidence, meta: { ...(evidence as CriterionEvidence & { meta?: Record<string, unknown> }).meta, assessment_source: 'guided_attempt', assumed_phase: true, partial_interval: true,
        ...(!currentObservation && this.irreversiblePeak(c) ? { monotonic_violation: true } : {}), ...(currentObservation ? { current_observation: true } : {}) } };
    }).filter((c): c is NonNullable<typeof c> => c !== null);
    if (!criteria.length) return null;
    const result = this.buildSet(observation, criteria);
    // These are selected-target corrections, never a score for a recognized execution.
    result.score = null;
    if (stationary) this.acc.reset();
    return result;
  }

  /** Whole-phase rules only after a continuously observed kinematic candidate has an observable endpoint. */
  completeGuided(update: TemporalUpdate, phaseId: string, sinceMs: number, observedEnd?: { timestamp_ms: number; frame_id: number }): AssessmentSet | null {
    const phase = this.graph.phases.find(p => p.id === phaseId)!;
    const frames = this.acc.frames(phaseId);
    const endMs = observedEnd?.timestamp_ms ?? update.timestamp_ms;
    if (this.graph.kind === 'static_hold' || frames.length < 3 || endMs - sinceMs < Math.max(phase.hold_ms ?? 0, phase.min_duration_ms ?? 0)) return null;
    const observation: TemporalUpdate = { ...update, confidence: 0, phase_id: phaseId, ended_phase: {
      phase_id: phaseId, start_ms: sinceMs, end_ms: endMs, start_frame: frames[0], end_frame: observedEnd?.frame_id ?? frames.at(-1)!,
    } };
    const criteria = this.criteria.filter(c => this.criterionAppliesToPhase(c, phaseId) && !['phase_duration', 'equipment_dependent', 'ordering'].includes(c.evaluator.kind)).map(c => {
      const evidence = this.evaluateCriterion(c, observation, [phaseId], update.timestamp_ms);
      return { ...evidence, meta: { ...(evidence as CriterionEvidence & { meta?: Record<string, unknown> }).meta, assessment_source: 'guided_attempt_completed', assumed_phase: true, ...(observedEnd ? { observed_end_ms: endMs, published_ms: update.timestamp_ms } : {}) } };
    });
    if (!criteria.length) return null;
    const result = this.buildSet(observation, criteria);
    result.score = null;
    return result;
  }

  private criterionAppliesToPhase(c: CriterionDefinition, phaseId: string): boolean {
    return c.phase_ids !== null && c.phase_ids.includes(phaseId);
  }

  private irreversiblePeak(c: CriterionDefinition): boolean {
    return c.evaluator.aggregate === 'phase_max' && ['max_value', 'max_abs'].includes(c.evaluator.kind);
  }

  private supportedPeakViolation(c: CriterionDefinition, evidence: CriterionEvidence, phaseId: string): boolean {
    if (evidence.state !== 'IMPROVE') return false;
    const selected = this.selectFeature(c, [phaseId]);
    if (!selected.id) return false;
    const samples = this.acc.merged([phaseId], selected.id).samples;
    const band = varianceBand(c.evaluator, this.ctx.featureUnit(selected.id), this.ctx.athlete_context, this.hv).band;
    // Two independently observed high-confidence violations prevent a single
    // noisy peak from becoming an irreversible live correction.
    return samples.filter(s => {
      const verdict = scoreAgainst(c.evaluator, s.value);
      return s.confidence >= (c.evaluator.min_confidence ?? 0.5) && zoneFor(verdict.pass, verdict.distance, band) === 'improve';
    }).length >= 2;
  }

  private partialPeakEvidence(evidence: CriterionEvidence): CriterionEvidence {
    return { ...evidence, meta: { ...(evidence as CriterionEvidence & { meta?: Record<string, unknown> }).meta, partial_interval: true, monotonic_violation: true } } as CriterionEvidence;
  }

  // ---------------------------------------------------------------------------

  private evaluateCriterion(c: CriterionDefinition, update: TemporalUpdate, phaseIds: string[], tsMs: number): CriterionEvidence {
    const frames = phaseIds.flatMap((p) => this.acc.frames(p));

    if (c.validation_status === 'disabled') return this.abstain(c, update, 'NOT_ASSESSABLE', 'RUBRIC_DISABLED', tsMs, frames);
    if (c.athlete_context !== 'any' && this.ctx.athlete_context !== 'unknown' && !c.athlete_context.includes(this.ctx.athlete_context)) {
      return this.abstain(c, update, 'NOT_APPLICABLE', 'NOT_APPLICABLE', tsMs, frames);
    }
    if (c.view_constraints !== 'any' && !c.view_constraints.includes(this.ctx.view)) return this.abstain(c, update, 'NOT_ASSESSABLE', 'VIEW_INVALID', tsMs, frames);

    const missingCap = c.requires_capabilities.find((cap) => !this.ctx.capabilities_available.includes(cap));
    if (missingCap) return this.abstain(c, update, 'NOT_ASSESSABLE', 'CAPABILITY_MISSING', tsMs, frames);

    // Pose quality during the window.
    const q = phaseIds.map((p) => this.acc.quality(p)).reduce((a, b) => ({ bad_fraction: Math.max(a.bad_fraction, b.bad_fraction), dominant_reason: b.dominant_reason ?? a.dominant_reason, total: a.total + b.total }), { bad_fraction: 0, dominant_reason: null as MissingReason | null, total: 0 });
    if (q.bad_fraction > 0.3 && q.dominant_reason) return this.abstain(c, update, 'NOT_ASSESSABLE', q.dominant_reason, tsMs, frames);
    if (c.evaluator.kind === 'equipment_dependent') return this.evaluateEquipment(c, update, phaseIds, tsMs, frames, 1 - q.bad_fraction);

    if (c.evaluator.kind === 'phase_duration') {
      const duration = this.phaseDuration(c, update);
      if (duration === null) return this.abstain(c, update, 'NOT_ASSESSABLE', 'PHASE_NOT_ACTIVE', tsMs, frames);
      // Timing rubrics are rubrics: strict mode withholds provisional verdicts here exactly as for feature rubrics.
      if (this.ctx.strict_rubrics && c.validation_status !== 'approved') {
        return this.abstain(c, update, 'UNCERTAIN', 'RUBRIC_UNVALIDATED', tsMs, frames, undefined, { value: duration, unit: 'ms' });
      }
      const verdict = scoreAgainst(c.evaluator, duration);
      return this.judge(c, update, verdict, c.evaluator, { value: duration, unit: 'ms' }, update.confidence, 1, frames, tsMs, null);
    }

    if (c.evaluator.kind === 'reference_nearest') {
      return this.evaluateReference(c, update, phaseIds, tsMs, frames, 1 - q.bad_fraction);
    }

    // Select the measured feature.
    const selected = this.selectFeature(c, phaseIds);
    if (!selected.id) return this.abstain(c, update, c.missing_data_policy === 'uncertain' ? 'UNCERTAIN' : 'NOT_ASSESSABLE', selected.reason ?? 'MISSING_JOINT', tsMs, frames);
    const stats = this.acc.merged(phaseIds, selected.id);
    if (!stats.samples.length) {
      const reason = (Object.entries(stats.invalid_reasons).sort((a, b) => b[1] - a[1])[0]?.[0] as MissingReason | undefined) ?? 'INSUFFICIENT_HISTORY';
      return this.abstain(c, update, c.missing_data_policy === 'uncertain' ? 'UNCERTAIN' : 'NOT_ASSESSABLE', reason, tsMs, frames, selected.id);
    }
    const aggregate = c.evaluator.aggregate ?? 'latest';
    // A maximum absolute-deviation rule must retain the largest excursion on
    // either side. A signed maximum would hide a large negative lean as soon
    // as the athlete returns closer to neutral.
    const measured = c.evaluator.kind === 'max_abs' && ['phase_max', 'window_max'].includes(aggregate)
      ? stats.samples.reduce((peak, sample) => Math.abs(sample.value) > Math.abs(peak) ? sample.value : peak, 0)
      : aggregateSamples(stats.samples, aggregate);
    const meanConf = stats.samples.reduce((a, s) => a + s.confidence, 0) / stats.samples.length;
    const evidenceQuality = Math.min(meanConf, 1 - q.bad_fraction, stats.samples.length / Math.max(1, frames.length));
    const minConf = c.evaluator.min_confidence ?? 0.5;
    if (!Number.isFinite(evidenceQuality) || evidenceQuality < minConf) return this.abstain(c, update, 'UNCERTAIN', 'LOW_CONFIDENCE', tsMs, frames, selected.id, { value: measured, unit: this.ctx.featureUnit(selected.id) });

    // Contradiction check for sample-wise verdicts on 'latest' aggregates.
    if (aggregate === 'latest' && stats.samples.length >= 4) {
      const passFraction = stats.samples.filter((s) => scoreAgainst(c.evaluator, s.value).pass).length / stats.samples.length;
      if (passFraction > 0.35 && passFraction < 0.65) {
        return this.abstain(c, update, 'UNCERTAIN', 'CONTRADICTORY_EVIDENCE', tsMs, frames, selected.id, { value: measured, unit: this.ctx.featureUnit(selected.id) });
      }
    }

    if (this.ctx.strict_rubrics && c.validation_status !== 'approved') {
      return this.abstain(c, update, 'UNCERTAIN', 'RUBRIC_UNVALIDATED', tsMs, frames, selected.id, { value: measured, unit: this.ctx.featureUnit(selected.id) });
    }

    const verdict = scoreAgainst(c.evaluator, measured);
    return this.judge(c, update, verdict, c.evaluator, { value: measured, unit: this.ctx.featureUnit(selected.id), feature_id: selected.id }, update.confidence, evidenceQuality, frames, tsMs, selected.id);
  }

  /**
   * Duration (ms) measured by a `phase_duration` evaluator, or null when the boundaries are not known yet.
   *   measure = 'span' (default): start -> end of `phase_id`.
   *   measure = 'since_phase_start': start of `from_phase_id` -> start of `phase_id`.
   *   measure = 'since_phase_end':   end of `from_phase_id`   -> start of `phase_id`.
   * A terminal phase's own span is only its confirmation dwell (the graph completes as soon as the phase is
   * confirmed), so pack validation forbids 'span' on terminal phases; recovery times use `from_phase_id`.
   */
  private phaseDuration(c: CriterionDefinition, update: TemporalUpdate): number | null {
    const params = c.evaluator.params ?? {};
    const phaseId = (params.phase_id as string | undefined) ?? (c.phase_ids ? c.phase_ids[0] : undefined);
    if (!phaseId) return null;
    const fromId = params.from_phase_id as string | undefined;
    const measure = (params.measure as string | undefined) ?? (fromId ? 'since_phase_start' : 'span');
    const target = update.execution_phases.find((p) => p.phase_id === phaseId);
    if (!target) return null;
    if (measure === 'span') {
      if (target.end_ms === null || target.end_ms === undefined) return null;
      return target.end_ms - target.start_ms;
    }
    const from = update.execution_phases.find((p) => p.phase_id === fromId);
    if (!from) return null;
    if (measure === 'since_phase_end') {
      if (from.end_ms === null || from.end_ms === undefined) return null;
      return target.start_ms - from.end_ms;
    }
    return target.start_ms - from.start_ms;
  }

  private evaluateEquipment(c: CriterionDefinition, update: TemporalUpdate, phaseIds: string[], tsMs: number, frames: number[], qualityFraction: number): CriterionEvidence {
    const params = c.evaluator.params ?? {};
    const measurementId = typeof params.measurement_id === 'string' ? params.measurement_id : c.criterion_id;
    let samples = phaseIds.flatMap((phase) => this.equipmentByPhase.get(phase) ?? [])
      .flatMap((frame) => frame.measurements.filter((m) => m.measurement_id === measurementId && m.equipment_id === params.equipment).map((measurement) => ({ frame, measurement })));
    if (!samples.length) {
      const reason = phaseIds.map((p) => this.equipmentReasons.get(p)).find(Boolean) ?? (params.requires_contact ? 'CONTACT_UNOBSERVED' : 'EQUIPMENT_UNOBSERVED');
      return this.abstain(c, update, 'NOT_ASSESSABLE', reason, tsMs, frames);
    }
    if (new Set(samples.map(({ frame }) => `${frame.session_id}:${frame.camera_id}:${frame.tracked_subject_id}:${frame.view}`)).size !== 1) return this.abstain(c, update, 'NOT_ASSESSABLE', 'AMBIGUOUS_SUBJECT', tsMs, frames);
    if (samples.some(({ measurement: m }) => (params.measurement_unit && m.unit !== params.measurement_unit) || (params.quantity && m.quantity !== params.quantity))) return this.abstain(c, update, 'NOT_ASSESSABLE', 'SCALE_UNKNOWN', tsMs, frames);
    if (new Set(samples.map(({ measurement: m }) => `${m.unit}:${m.quantity}`)).size !== 1) return this.abstain(c, update, 'UNCERTAIN', 'CONTRADICTORY_EVIDENCE', tsMs, frames);
    if (params.requires_contact) {
      samples = samples.filter(({ frame, measurement: m }) => m.contact && m.contact.frame_id === frame.frame_id && m.contact.timestamp_ms === frame.timestamp_ms);
      if (!samples.length) return this.abstain(c, update, 'NOT_ASSESSABLE', 'CONTACT_UNOBSERVED', tsMs, frames);
    }
    // Contact is an explicit event sample. Continuous latest/end measurements must
    // reach the end of the assessed phase; an old packet cannot supply a live value.
    const aggregate = c.evaluator.aggregate ?? 'phase_end';
    if (!params.requires_contact && ['latest', 'phase_end'].includes(aggregate) && Math.max(...samples.map(({ frame }) => frame.frame_id)) !== Math.max(...frames)) return this.abstain(c, update, 'NOT_ASSESSABLE', 'STALE_FRAME', tsMs, frames);
    const usedFrames = samples.map(({ frame }) => frame.frame_id);
    const confidence = Math.min(qualityFraction, params.requires_contact ? 1 : new Set(usedFrames).size / Math.max(1, frames.length), ...samples.map(({ measurement: m }) => Math.min(m.confidence, params.requires_contact ? m.contact!.confidence : 1, m.ground_contact?.confidence ?? 1)));
    const retrospective = samples.some(({ frame }) => frame.retrospective);
    const measurement = { value: aggregateSamples(samples.map(({ frame, measurement: m }) => ({ frame_id: frame.frame_id, timestamp_ms: frame.timestamp_ms, value: m.value, confidence: m.confidence })), aggregate), unit: samples[0].measurement.unit };
    const meta = { equipment: samples.map(({ frame, measurement: m }) => ({ frame_id: frame.frame_id, timestamp_ms: frame.timestamp_ms, measurement_id: m.measurement_id, quantity: m.quantity, source: m.source, validation_status: m.validation_status, contact: m.contact ?? null, ground_contact: m.ground_contact ?? null, calibration_id: m.calibration_id ?? null })) };
    const abstain = (state: 'UNCERTAIN' | 'NOT_ASSESSABLE', reason: MissingReason) => ({ ...this.abstain(c, update, state, reason, tsMs, usedFrames, undefined, measurement, meta), retrospective });
    if (confidence < (c.evaluator.min_confidence ?? 0.5)) return abstain('UNCERTAIN', 'LOW_CONFIDENCE');
    if (samples.some(({ measurement: m }) => m.validation_status === 'disabled')) return abstain('NOT_ASSESSABLE', 'MODEL_UNAVAILABLE');
    const sourceProvisional = samples.some(({ measurement: m }) => m.validation_status !== 'approved');
    if (this.ctx.strict_rubrics && (c.validation_status !== 'approved' || sourceProvisional)) return abstain('UNCERTAIN', 'RUBRIC_UNVALIDATED');
    const kind = params.comparison_kind;
    if (!['range', 'max_value', 'min_value', 'max_abs'].includes(String(kind)) || (kind === 'range' ? !c.evaluator.range || c.evaluator.range.length !== 2 || !c.evaluator.range.every(Number.isFinite) || c.evaluator.range[0] > c.evaluator.range[1] : typeof c.evaluator.limit !== 'number' || !Number.isFinite(c.evaluator.limit))) return abstain('UNCERTAIN', 'RUBRIC_UNVALIDATED');
    const comparator = { ...c.evaluator, kind: kind as 'range' | 'max_value' | 'min_value' | 'max_abs' };
    const result = this.judge(c, update, scoreAgainst(comparator, measurement.value), comparator, measurement, update.confidence, confidence, usedFrames, tsMs, null, meta);
    return { ...result, retrospective, provenance: { ...result.provenance, provisional: result.provenance.provisional || sourceProvisional } };
  }

  private evaluateReference(c: CriterionDefinition, update: TemporalUpdate, phaseIds: string[], tsMs: number, frames: number[], qualityFraction: number): CriterionEvidence {
    const ref = this.ctx.models?.[c.evaluator.model_reference ?? ''] as ReferenceSetModel | undefined;
    if (!ref || !Array.isArray(ref.reference_vectors) || !ref.reference_vectors.length) return this.abstain(c, update, 'NOT_ASSESSABLE', 'MODEL_UNAVAILABLE', tsMs, frames);
    if (!Array.isArray(ref.features) || !ref.features.length || [ref.reference_views, ref.reference_handedness, ref.reference_handedness_assumed].some((a) => a !== undefined && (!Array.isArray(a) || a.length !== ref.reference_vectors.length))) {
      return this.abstain(c, update, 'NOT_ASSESSABLE', 'MODEL_UNAVAILABLE', tsMs, frames);
    }
    let candidates = ref.reference_vectors.map((values, index) => ({ values, index }));
    if (ref.reference_views !== undefined) {
      candidates = candidates.filter(({ index }) => this.ctx.view !== 'unknown' && ref.reference_views![index] === this.ctx.view);
      if (!candidates.length) return this.abstain(c, update, 'NOT_ASSESSABLE', 'VIEW_INVALID', tsMs, frames);
    }
    if (ref.features.some((id) => /(^|_)(non_?dominant|dominant)_/.test(id)) && (ref.reference_handedness !== undefined || ref.reference_handedness_assumed !== undefined)) {
      candidates = candidates.filter(({ index }) => ['left', 'right'].includes(ref.reference_handedness?.[index] ?? 'unknown') && ref.reference_handedness_assumed?.[index] !== true);
      if (!candidates.length) return this.abstain(c, update, 'NOT_ASSESSABLE', 'HANDEDNESS_UNKNOWN', tsMs, frames);
    }
    const aggregate = c.evaluator.aggregate ?? 'phase_mean';
    const vector: number[] = [];
    let evidenceQuality = 1;
    for (const fid of ref.features) {
      const st = this.acc.merged(phaseIds, fid);
      if (!st.samples.length) return this.abstain(c, update, c.missing_data_policy === 'uncertain' ? 'UNCERTAIN' : 'NOT_ASSESSABLE', 'MISSING_JOINT', tsMs, frames, fid);
      vector.push(aggregateSamples(st.samples, aggregate));
      const featureConfidence = st.samples.reduce((a, s) => a + s.confidence, 0) / st.samples.length;
      const featureQuality = Math.min(featureConfidence, qualityFraction, st.samples.length / Math.max(1, frames.length));
      if (!Number.isFinite(featureQuality) || featureQuality < (c.evaluator.min_confidence ?? 0.5)) return this.abstain(c, update, 'UNCERTAIN', 'LOW_CONFIDENCE', tsMs, frames, fid);
      evidenceQuality = Math.min(evidenceQuality, featureQuality);
    }
    const weights = ref.weights ?? ref.features.map(() => 1);
    let best = Infinity;
    let nearest: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
      const rv = candidate.values;
      let num = 0;
      let den = 0;
      for (let i = 0; i < vector.length; i++) {
        const referenceValue = rv[i];
        if (referenceValue === undefined || referenceValue === null || !Number.isFinite(referenceValue) || !Number.isFinite(weights[i]) || weights[i] <= 0) continue;
        num += weights[i] * (vector[i] - referenceValue) ** 2;
        den += weights[i];
      }
      if (den > 0 && Math.sqrt(num / den) < best) {
        best = Math.sqrt(num / den);
        nearest = candidate;
      }
    }
    if (!Number.isFinite(best) || !nearest) return this.abstain(c, update, 'NOT_ASSESSABLE', 'MODEL_UNAVAILABLE', tsMs, frames);
    const unit = ref.unit ?? 'none';
    if (this.ctx.strict_rubrics && (c.validation_status !== 'approved' || (ref.validation_status !== undefined && ref.validation_status !== 'approved'))) return this.abstain(c, update, 'UNCERTAIN', 'RUBRIC_UNVALIDATED', tsMs, frames, undefined, { value: best, unit });
    const refEvaluator = { ...c.evaluator, kind: 'max_value' as const, limit: ref.threshold, tolerance: ref.tolerance ?? ref.threshold };
    const verdict = scoreAgainst(refEvaluator, best);
    // Preserve the components of the *same* nearest vector used for this verdict.
    // A large global RMS alone cannot identify a faulty joint. A component above
    // this aggregate acceptance bound is an observed contributor, not a new
    // independently validated per-joint rubric. Consumers may localize only an
    // IMPROVE result, with this reference's existing provisional status.
    const localizationThreshold = ref.threshold + varianceBand(refEvaluator, unit, this.ctx.athlete_context, this.hv).band;
    const conflicts = this.referenceTargetConflicts(ref, nearest.values, phaseIds);
    const deviations = ref.features.flatMap((featureId, i) => {
      const reference = nearest.values[i];
      if (reference === undefined || reference === null || !Number.isFinite(reference) || !Number.isFinite(weights[i]) || weights[i] <= 0) return [];
      const delta = vector[i] - reference;
      const featureUnit = this.ctx.featureUnit(featureId);
      const conflictingCriteria = conflicts.get(featureId) ?? [];
      return [{ feature_id: featureId, observed: vector[i], reference, delta, absolute_delta: Math.abs(delta), weight: weights[i], weighted_squared_contribution: weights[i] * delta ** 2,
        unit: featureUnit, localization_threshold: localizationThreshold,
        outside_reference_band: featureUnit === unit && Math.abs(delta) > localizationThreshold,
        constraint_conflict: conflictingCriteria.length > 0, conflicting_criteria: conflictingCriteria }];
    }).sort((a, b) => b.weighted_squared_contribution - a.weighted_squared_contribution);
    const referenceMeta = {
      reference_features: ref.features, reference_view: ref.reference_views ? this.ctx.view : undefined,
      reference_index: nearest.index, reference_deviations: deviations,
    };
    const contributors = deviations.filter(d => d.outside_reference_band);
    // Do not issue a generic "copy the reference" instruction when every
    // measured difference would steer the athlete toward a rejected target.
    const result = !verdict.pass && contributors.length > 0 && contributors.every(d => d.constraint_conflict)
      ? this.abstain(c, update, 'UNCERTAIN', 'CONTRADICTORY_EVIDENCE', tsMs, frames, undefined, { value: best, unit }, referenceMeta)
      : this.judge(c, update, verdict, refEvaluator, { value: best, unit }, update.confidence, evidenceQuality, frames, tsMs, null, referenceMeta);
    return { ...result, provenance: { ...result.provenance, provisional: result.provenance.provisional || (ref.validation_status !== undefined && ref.validation_status !== 'approved') } };
  }

  /** A recorded reference is not a safe correction target when the pack's own geometric rule rejects it. */
  private referenceTargetConflicts(ref: ReferenceSetModel, vector: Array<number | null>, phaseIds: string[]): Map<string, string[]> {
    const specs = new Map(this.ctx.feature_specs?.map(f => [f.id, f]));
    const values = new Map(ref.features.map((id, i) => [id, vector[i]]));
    const resolve = (id: string, seen = new Set<string>()): { value: number; leaves: string[] } | null => {
      if (seen.has(id)) return null;
      seen.add(id);
      const direct = values.get(id);
      if (typeof direct === 'number' && Number.isFinite(direct)) return { value: direct, leaves: [id] };
      const spec = specs.get(id);
      if (!spec || !['min_of', 'max_of'].includes(spec.kind) || !Array.isArray(spec.params.features) || !spec.params.features.length) return null;
      const children = spec.params.features.map(child => typeof child === 'string' ? resolve(child, new Set(seen)) : null);
      if (children.some(child => child === null)) return null;
      const resolved = children as Array<{ value: number; leaves: string[] }>;
      return { value: (spec.kind === 'min_of' ? Math.min : Math.max)(...resolved.map(child => child.value)), leaves: resolved.flatMap(child => child.leaves) };
    };
    const conflicts = new Map<string, string[]>();
    for (const criterion of this.criteria) {
      if (criterion.validation_status === 'disabled' || !['range', 'min_value', 'max_value', 'max_abs'].includes(criterion.evaluator.kind)) continue;
      if (!phaseIds.some(phase => this.criterionAppliesToPhase(criterion, phase))) continue;
      if (criterion.view_constraints !== 'any' && !criterion.view_constraints.includes(this.ctx.view)) continue;
      if (criterion.athlete_context !== 'any' && this.ctx.athlete_context !== 'unknown' && !criterion.athlete_context.includes(this.ctx.athlete_context)) continue;
      if (criterion.requires_capabilities.some(cap => !this.ctx.capabilities_available.includes(cap))) continue;
      const selected = this.selectFeature(criterion, phaseIds).id;
      if (!selected || this.ctx.featureUnit(selected) !== ref.unit || ref.unit !== 'deg') continue;
      const reference = resolve(selected);
      if (!reference) continue;
      const verdict = scoreAgainst(criterion.evaluator, reference.value);
      const band = varianceBand(criterion.evaluator, ref.unit, this.ctx.athlete_context, this.hv).band;
      if (zoneFor(verdict.pass, verdict.distance, band) !== 'improve') continue;
      // Suppress reference directions for every component of a rejected composite
      // target. The separate scalar criterion retains its own measured correction.
      for (const feature of reference.leaves) conflicts.set(feature, [...(conflicts.get(feature) ?? []), criterion.criterion_id]);
    }
    return conflicts;
  }

  private selectFeature(c: CriterionDefinition, phaseIds: string[]): { id: string | null; reason?: MissingReason } {
    const sel = c.feature_selector;
    if (!sel) {
      const id = c.required_features[0];
      return id ? { id } : { id: null, reason: 'UNKNOWN_FEATURE' };
    }
    const statsFor = (id: string): PhaseFeatureStats => this.acc.merged(phaseIds, id);
    if (sel.mode === 'first_valid') {
      const id = sel.candidates.find((cnd) => statsFor(cnd).samples.length > 0);
      return id ? { id } : { id: null, reason: 'MISSING_JOINT' };
    }
    if (sel.mode === 'key_min' || sel.mode === 'key_max') {
      const keys = sel.keys ?? [];
      let bestIdx = -1;
      let bestVal = sel.mode === 'key_min' ? Infinity : -Infinity;
      sel.candidates.forEach((cnd, i) => {
        const keyId = keys[i];
        if (!keyId) return;
        const ks = statsFor(keyId).samples;
        const cs = statsFor(cnd).samples;
        if (!ks.length || !cs.length) return;
        const kv = aggregateSamples(ks, 'phase_min');
        const kmax = aggregateSamples(ks, 'phase_max');
        const metric = sel.mode === 'key_min' ? kv : kmax;
        if (sel.mode === 'key_min' ? metric < bestVal : metric > bestVal) {
          bestVal = metric;
          bestIdx = i;
        }
      });
      return bestIdx >= 0 ? { id: sel.candidates[bestIdx] } : { id: null, reason: 'MISSING_JOINT' };
    }
    // min / max of the candidates' own aggregated values
    let bestIdx = -1;
    let bestVal = sel.mode === 'min' ? Infinity : -Infinity;
    sel.candidates.forEach((cnd, i) => {
      const cs = statsFor(cnd).samples;
      if (!cs.length) return;
      const v = aggregateSamples(cs, c.evaluator.aggregate ?? 'latest');
      if (sel.mode === 'min' ? v < bestVal : v > bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    });
    return bestIdx >= 0 ? { id: sel.candidates[bestIdx] } : { id: null, reason: 'MISSING_JOINT' };
  }

  /**
   * Human variance layer (TRD 11): a measured deviation becomes IMPROVE only when it exceeds the sport's variance
   * band and is not natural trial-to-trial variation of this athlete. Smaller deviations are UNCERTAIN with
   * reason WITHIN_NORMAL_VARIANCE and carry the measurement, so nothing is hidden but no correction is spoken.
   */
  private judge(
    c: CriterionDefinition, update: TemporalUpdate, verdict: Verdict, evaluator: CriterionDefinition['evaluator'],
    measurement: { value: number; unit: Unit; feature_id?: string }, movementConf: number, evidenceQuality: number,
    frames: number[], tsMs: number, selectedFeature: string | null, extra?: Record<string, unknown>,
  ): CriterionEvidence {
    const vb = varianceBand(evaluator, measurement.unit, this.ctx.athlete_context, this.hv);
    const zone = zoneFor(verdict.pass, verdict.distance, vb.band);
    this.repetitions.record(c.criterion_id, update.execution_id, measurement.value, zone === 'improve');
    const reps = this.repetitions.stats(c.criterion_id);
    const variance = { zone, band: vb.band, distance: verdict.distance, relative_component: vb.relative_component, measurement_component: vb.measurement_component, pack_tolerance: vb.pack_tolerance, context_scale: vb.context_scale };
    const meta = { ...(extra ?? {}), variance, repetitions: reps };
    if (zone === 'within_variance') {
      return this.abstain(c, update, 'UNCERTAIN', 'WITHIN_NORMAL_VARIANCE', tsMs, frames, measurement.feature_id, { value: measurement.value, unit: measurement.unit }, meta);
    }
    if (zone === 'improve') {
      const natural = this.repetitions.isNaturalVariation(c.criterion_id, measurement.value, update.execution_id);
      if (natural.natural) {
        return this.abstain(c, update, 'UNCERTAIN', 'WITHIN_NORMAL_VARIANCE', tsMs, frames, measurement.feature_id, { value: measurement.value, unit: measurement.unit }, { ...meta, natural_variation: true });
      }
    }
    return this.finish(c, update, verdict, measurement, movementConf, evidenceQuality, frames, tsMs, selectedFeature, meta);
  }

  private finish(
    c: CriterionDefinition, update: TemporalUpdate, verdict: Verdict,
    measurement: { value: number; unit: Unit; feature_id?: string }, movementConf: number, evidenceQuality: number,
    frames: number[], tsMs: number, selectedFeature: string | null, extra?: Record<string, unknown>,
  ): CriterionEvidence {
    const entry = this.feedback.entries.find((e) => e.error_id === c.error_id);
    const locale = this.ctx.locale ?? this.feedback.default_locale;
    let feedback: CriterionEvidence['feedback'] = null;
    if (!verdict.pass && entry && (entry.review_status === 'approved' || this.ctx.allow_draft_feedback)) {
      feedback = { error_id: c.error_id, cue: entry.cue[locale] ?? entry.cue.en, rationale: entry.rationale?.[locale] ?? entry.rationale?.en };
    }
    return {
      criterion_id: c.criterion_id,
      movement_id: c.movement_id,
      phase_id: update.ended_phase?.phase_id ?? update.phase_id ?? null,
      state: verdict.pass ? 'PASS' : 'IMPROVE',
      score: verdict.score,
      measurement: { value: measurement.value, unit: measurement.unit, reason: null, feature_id: measurement.feature_id },
      confidence: { movement: movementConf, assessment: Math.max(0, Math.min(1, evidenceQuality)), evidence_quality: evidenceQuality },
      evidence: { frame_ids: frames.slice(-60), view: this.ctx.view, feature_ids: c.required_features, selected_feature_id: selectedFeature },
      feedback,
      provenance: {
        sport_pack: this.ctx.sport_pack_version,
        rubric: this.ctx.rubric_version,
        validation_status: c.validation_status,
        evaluator: c.evaluator.kind,
        provisional: c.validation_status !== 'approved',
      },
      severity: c.severity,
      timestamp_ms: tsMs,
      retrospective: false,
      ...(extra ? { meta: extra } : {}),
    } as CriterionEvidence;
  }

  private abstain(c: CriterionDefinition, update: TemporalUpdate, state: 'UNCERTAIN' | 'NOT_ASSESSABLE' | 'NOT_APPLICABLE', reason: MissingReason, tsMs: number, frames: number[], featureId?: string, measured?: { value: number; unit: Unit }, extra?: Record<string, unknown>): CriterionEvidence {
    const unit: Unit = measured?.unit ?? (featureId ? this.ctx.featureUnit(featureId) : ((c.evaluator.params?.measurement_unit as Unit) ?? 'none'));
    return {
      criterion_id: c.criterion_id,
      movement_id: c.movement_id,
      phase_id: update.ended_phase?.phase_id ?? update.phase_id ?? null,
      state,
      score: null,
      measurement: { value: measured?.value ?? null, unit, reason, feature_id: featureId },
      confidence: { movement: update.confidence, assessment: null },
      evidence: { frame_ids: frames.slice(-60), view: this.ctx.view, feature_ids: c.required_features, selected_feature_id: featureId ?? null },
      feedback: null,
      provenance: { sport_pack: this.ctx.sport_pack_version, rubric: this.ctx.rubric_version, validation_status: c.validation_status, evaluator: c.evaluator.kind, provisional: c.validation_status !== 'approved' },
      severity: c.severity,
      timestamp_ms: tsMs,
      retrospective: false,
      ...(extra ? { meta: extra } : {}),
    };
  }

  private buildSet(update: TemporalUpdate, criteria: CriterionEvidence[]): AssessmentSet {
    this.sequence++;
    const byId = new Map(this.criteria.map((c) => [c.criterion_id, c]));
    const required = criteria.filter((e) => e.state !== 'NOT_APPLICABLE' && byId.get(e.criterion_id)?.validation_status !== 'disabled');
    const scored = required.filter((e) => e.score !== null && (e.state === 'PASS' || e.state === 'IMPROVE'));
    const weights: Record<string, number> = {};
    let num = 0;
    let den = 0;
    for (const e of scored) {
      const w = byId.get(e.criterion_id)?.weight ?? 1;
      weights[e.criterion_id] = w;
      num += w * (e.score as number);
      den += w;
    }
    const ratio = required.length ? scored.length / required.length : 0;
    const coverage: Coverage = {
      evaluated: scored.length,
      required: required.length,
      ratio,
      minimum: this.ctx.minimum_coverage,
      omitted: required.filter((e) => e.score === null).map((e) => ({ criterion_id: e.criterion_id, reason: `${e.state}:${e.measurement.reason ?? 'unknown'}` })),
    };
    const score = den > 0 && ratio >= this.ctx.minimum_coverage && scored.every((e) => !e.provenance.provisional || !this.ctx.strict_rubrics) ? num / den : null;
    const confs = scored.map((e) => e.confidence.assessment ?? 0);
    return {
      schema_version: CONTRACT_VERSION,
      session_id: this.ctx.session_id,
      event_id: makeEventId(`${this.ctx.session_id}:as`, this.sequence),
      execution_id: update.execution_id,
      timestamp_ms: update.timestamp_ms,
      movement_id: update.movement_id,
      phase_id: update.ended_phase?.phase_id ?? update.phase_id ?? null,
      criteria,
      score,
      coverage,
      method: 'weighted_mean_of_valid_criteria',
      weights,
      uncertainty: confs.length ? 1 - confs.reduce((a, b) => a + b, 0) / confs.length : null,
      rubric_version: this.ctx.rubric_version,
      sport_pack_id: this.ctx.sport_pack_id,
      sport_pack_version: this.ctx.sport_pack_version,
      retrospective: criteria.some((c) => c.retrospective),
    };
  }
}

export type { FeatureSample };
