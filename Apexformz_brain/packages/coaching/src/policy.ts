import {
  CONTRACT_VERSION, makeEventId,
  type AssessmentSet, type CriterionEvidence, type FeedbackAction, type FeedbackTemplates, type MissingReason, type Severity,
} from '@apexformz/contracts';

export interface CoachingInput {
  timestamp_ms: number;
  frame_id: number;
  assessment: AssessmentSet | null;
  quality_ok: boolean;
  quality_reasons: MissingReason[];
  /** Whether the active phase permits verbal cues. */
  cue_allowed: boolean;
  /** Recognition state for context (no cues while IDLE on technique). */
  recognition_state: string;
  movement_id: string | null;
  /** Identity of the observed execution/attempt; null during an unassigned rest. */
  evidence_scope?: string | null;
  /** Additional current-motion proof required before releasing historical audio. */
  deferred_cue_allowed?: boolean;
}

export interface CoachingOptions {
  session_id: string;
  sport_pack_id: string;
  sport_pack_version: string;
  locale?: string;
  /** Allow draft (unreviewed) cues; production should be false. */
  allow_draft_cues: boolean;
  /** Setup/quality instruction cooldown per reason. */
  setup_cooldown_ms?: number;
  /** Quality reason must persist this long before instructing. */
  setup_persistence_ms?: number;
  modality?: Array<'visual' | 'audio' | 'haptic'>;
  /** Explicit rubric-to-catalog mapping, including PASS results without feedback text. */
  criterion_error_ids?: Record<string, string>;
  /** Optional bounded audio deferral for dynamic movement only. */
  deferred_cue_max_age_ms?: number;
}

const SEVERITY_RANK: Record<Severity, number> = { safety: 0, high: 1, medium: 2, low: 3 };

interface ActiveCue {
  event_id: string;
  error_id: string;
  expires_ms: number;
  acked: boolean;
}

interface PendingCue {
  criterion: CriterionEvidence;
  weights: Record<string, number>;
  movement_id: string | null;
  scope: string | null;
  created_ms: number;
}

/**
 * Coaching decision state machine (TRD 11):
 *   ASSESSMENT -> CANDIDATE_CUE -> STABILITY_GUARD -> PRIORITY_RANK -> COOLDOWN_CHECK -> FEEDBACK_ISSUED -> ACK/EXPIRE
 * Safety and setup instructions outrank technique cues; at most one primary
 * correction is active during motion; cue timing respects phase permissions.
 */
export class CoachingPolicy {
  private sequence = 0;
  private lastIssuedMs: number | null = null;
  private lastPositiveMs: number | null = null;
  private cooldowns = new Map<string, number>();
  private improveStreak = new Map<string, number>();
  private repeatCount = new Map<string, number>();
  private qualitySince = new Map<string, number>();
  private active: ActiveCue | null = null;
  private secondary: string[] = [];
  private lastSuppressed: string | null = null;
  private cleanAssessments = 0;
  private pending: PendingCue | null = null;
  private lastObserved = new Map<string, string>();
  private lastIssuedEvidence = new Map<string, string>();
  private evidenceScope: string | null = null;

  constructor(private readonly templates: FeedbackTemplates, private readonly opts: CoachingOptions) {}

  get lastSuppressedReason(): string | null {
    return this.lastSuppressed;
  }

  get queuedSecondary(): string[] {
    return [...this.secondary];
  }

  ack(eventId: string): void {
    if (this.active?.event_id === eventId) this.active.acked = true;
  }

  reset(): void {
    this.resetTechniqueEvidence();
    this.qualitySince.clear();
  }

  /** Forget technique evidence while a sustained camera/setup issue is still being observed. */
  resetTechniqueEvidence(): void {
    this.improveStreak.clear();
    this.active = null;
    this.secondary = [];
    this.cleanAssessments = 0;
    this.pending = null;
    this.lastObserved.clear();
    this.lastIssuedEvidence.clear();
    this.evidenceScope = null;
  }

  decide(input: CoachingInput): FeedbackAction | null {
    const t = input.timestamp_ms;
    this.lastSuppressed = null;
    if (this.active && (t >= this.active.expires_ms || this.active.acked)) this.active = null;
    const maxAge = this.opts.deferred_cue_max_age_ms ?? 0;
    if (this.pending && (t - this.pending.created_ms > maxAge || input.movement_id !== this.pending.movement_id ||
      input.evidence_scope && this.pending.scope && input.evidence_scope !== this.pending.scope)) this.pending = null;
    if (input.evidence_scope && input.evidence_scope !== this.evidenceScope) {
      this.improveStreak.clear();
      this.lastObserved.clear();
      this.cleanAssessments = 0;
      this.evidenceScope = input.evidence_scope;
    }
    if (!input.quality_ok) {
      this.pending = null;
      this.improveStreak.clear();
    }

    // 1. Safety / setup instructions take precedence and are independent of recognition state.
    const setup = this.setupInstruction(input);
    if (setup) return setup;
    for (const key of [...this.qualitySince.keys()]) if (!input.quality_reasons.includes(key as MissingReason)) this.qualitySince.delete(key);

    if (!input.quality_ok) {
      this.lastSuppressed = `quality:${input.quality_reasons.join(',') || 'unknown'}`;
      return null;
    }
    if (!input.assessment && !this.pending) return null;

    // 2. Candidate cues from IMPROVE criteria.
    const criteria = input.assessment?.criteria ?? [];
    // A later verdict for the same criterion and observed phase supersedes it.
    // A correct resting pose in another phase does not erase the earlier action.
    if (this.pending && criteria.some(c => c.criterion_id === this.pending!.criterion.criterion_id &&
      c.phase_id === this.pending!.criterion.phase_id && c.timestamp_ms >= this.pending!.criterion.timestamp_ms && c.state !== 'IMPROVE')) this.pending = null;
    const improves = criteria.filter((c) => c.state === 'IMPROVE');
    const passes = criteria.filter((c) => c.state === 'PASS');
    const seen = new Set(improves.map((c) => c.criterion_id));
    for (const c of criteria) if (!seen.has(c.criterion_id)) this.improveStreak.set(c.criterion_id, 0);
    for (const c of improves) {
      const key = this.observationKey(c, input.evidence_scope);
      if (this.lastObserved.get(c.criterion_id) !== key) this.improveStreak.set(c.criterion_id, (this.improveStreak.get(c.criterion_id) ?? 0) + 1);
      this.lastObserved.set(c.criterion_id, key);
    }

    // 3. Stability guard: persistence per feedback entry.
    const stable = improves.filter((c) => {
      if (this.lastIssuedEvidence.get(c.criterion_id) === this.observationKey(c, input.evidence_scope)) return false;
      const entry = this.entryFor(c);
      const need = entry?.persistence_count ?? 2;
      const meta = (c as CriterionEvidence & { meta?: { assessment_source?: string } }).meta;
      // A completed, continuously observed attempted interval already contains
      // repeated samples. Do not require the athlete to repeat the entire motion
      // merely to hear its first post-attempt geometric correction.
      if (['guided_attempt_completed', 'dynamic_reference_completed'].includes(meta?.assessment_source ?? '') && new Set(c.evidence.frame_ids).size >= Math.max(3, need)) return true;
      return (this.improveStreak.get(c.criterion_id) ?? 0) >= need;
    });

    if (this.pending && !stable.some(c => c.criterion_id === this.pending!.criterion.criterion_id)) stable.push(this.pending.criterion);
    if (!stable.length) {
      if (!improves.length && passes.length) {
        this.cleanAssessments++;
        return this.positive(input, passes);
      }
      this.cleanAssessments = 0;
      this.lastSuppressed = improves.length ? 'stability_guard' : 'no_candidates';
      return null;
    }
    this.cleanAssessments = 0;

    // 4. Priority rank: severity, then weight, then lowest score.
    const weights = { ...this.pending?.weights, ...input.assessment?.weights };
    stable.sort((a, b) => {
      const sa = SEVERITY_RANK[a.severity ?? 'low'];
      const sb = SEVERITY_RANK[b.severity ?? 'low'];
      if (sa !== sb) return sa - sb;
      // A specific measured fault is more actionable than a whole-pose
      // similarity cue at the same severity. Keep reference guidance as fallback.
      const referenceA = a.provenance.evaluator === 'reference_nearest' ? 1 : 0;
      const referenceB = b.provenance.evaluator === 'reference_nearest' ? 1 : 0;
      if (referenceA !== referenceB) return referenceA - referenceB;
      const wa = weights[a.criterion_id] ?? 1;
      const wb = weights[b.criterion_id] ?? 1;
      if (wa !== wb) return wb - wa;
      return (a.score ?? 0) - (b.score ?? 0);
    });

    // 5. Cooldown and one-primary-at-a-time checks.
    const policy = this.templates.policy ?? {};
    const globalMin = policy.global_min_interval_ms ?? 5000;
    const primary = stable[0];
    const deferred = this.pending?.criterion.criterion_id === primary.criterion_id && t > this.pending.created_ms;
    if (maxAge > 0 && primary.severity !== 'safety') {
      const previous = this.pending?.criterion.criterion_id === primary.criterion_id ? this.pending : null;
      this.pending = { criterion: primary, weights, movement_id: input.movement_id, scope: input.evidence_scope ?? previous?.scope ?? null,
        created_ms: previous?.created_ms ?? t };
    }
    const rest = stable.slice(1);
    const maxQ = policy.max_secondary_queue ?? 3;
    this.secondary = rest.map((c) => c.criterion_id).filter((id, i) => i < maxQ);

    if (!input.cue_allowed && primary.severity !== 'safety') {
      this.lastSuppressed = 'phase_not_cueable';
      return null;
    }
    if (deferred && input.deferred_cue_allowed === false && primary.severity !== 'safety') {
      this.lastSuppressed = 'motion_not_settled';
      return null;
    }
    if (this.active && primary.severity !== 'safety') {
      this.lastSuppressed = `active_cue:${this.active.error_id}`;
      return null;
    }
    if (this.lastIssuedMs !== null && t - this.lastIssuedMs < globalMin && primary.severity !== 'safety') {
      this.lastSuppressed = 'global_interval';
      return null;
    }
    const entry = this.entryFor(primary);
    if (!entry) {
      this.pending = null;
      this.lastSuppressed = 'no_feedback_entry';
      return null;
    }
    if (entry.review_status !== 'approved' && !this.opts.allow_draft_cues) {
      this.pending = null;
      this.lastSuppressed = 'feedback_not_reviewed';
      return null;
    }
    const until = this.cooldowns.get(entry.error_id);
    if (until !== undefined && t < until) {
      this.lastSuppressed = `cooldown:${entry.error_id}`;
      return null;
    }

    // 6. Issue.
    const locale = this.opts.locale ?? this.templates.default_locale;
    const repeats = (this.repeatCount.get(entry.error_id) ?? 0) + 1;
    this.repeatCount.set(entry.error_id, repeats);
    // Dynamic reference cues carry the measured direction and body part. Keep
    // that original evidence when the cue waits for a safe pause.
    const measured = primary.provenance.evaluator === 'dynamic_reference' ? primary.feedback : null;
    const rationale = measured?.rationale ?? entry.rationale?.[locale] ?? entry.rationale?.en ?? null;
    const baseCue = measured?.cue ?? entry.cue[locale] ?? entry.cue.en;
    const cue = repeats >= 3 && rationale ? `${baseCue} ${rationale}` : baseCue;
    const text = deferred ? `For your next attempt: ${cue}` : cue;
    const action = this.action(input, {
      kind: 'technique_cue',
      priority: primary.severity === 'safety' ? 'safety' : 'primary',
      error_id: entry.error_id,
      criterion_id: primary.criterion_id,
      text,
      rationale,
      cooldown_ms: entry.cooldown_ms,
      evidence: primary.evidence.frame_ids,
      review_status: entry.review_status,
    });
    this.cooldowns.set(entry.error_id, t + entry.cooldown_ms);
    this.lastIssuedMs = t;
    this.active = { event_id: action.event_id, error_id: entry.error_id, expires_ms: action.expires_ms, acked: false };
    this.improveStreak.set(primary.criterion_id, 0);
    this.lastIssuedEvidence.set(primary.criterion_id, this.observationKey(primary, this.pending?.scope ?? input.evidence_scope));
    this.pending = null;
    return action;
  }

  private setupInstruction(input: CoachingInput): FeedbackAction | null {
    const t = input.timestamp_ms;
    const persistence = this.opts.setup_persistence_ms ?? 400;
    const cooldown = this.opts.setup_cooldown_ms ?? 6000;
    const locale = this.opts.locale ?? this.templates.default_locale;
    for (const reason of input.quality_reasons) {
      if (!this.qualitySince.has(reason)) this.qualitySince.set(reason, t);
      const since = this.qualitySince.get(reason)!;
      if (t - since < persistence) continue;
      const until = this.cooldowns.get(`setup:${reason}`);
      if (until !== undefined && t < until) continue;
      const texts = this.templates.generic[reason];
      if (!texts) continue;
      this.cooldowns.set(`setup:${reason}`, t + cooldown);
      this.lastIssuedMs = t;
      return this.action(input, {
        kind: reason === 'AMBIGUOUS_SUBJECT' || reason === 'FRAMING_INVALID' ? 'setup_instruction' : 'quality_instruction',
        priority: 'setup',
        error_id: null,
        criterion_id: null,
        text: texts[locale] ?? texts.en,
        rationale: null,
        cooldown_ms: cooldown,
        evidence: [input.frame_id],
        review_status: 'approved',
      });
    }
    return null;
  }

  private positive(input: CoachingInput, passes: CriterionEvidence[]): FeedbackAction | null {
    const interval = this.templates.policy?.positive_reinforcement_interval_ms ?? 15000;
    const t = input.timestamp_ms;
    const measuredReferenceEnd = passes.some(c => {
      const meta = (c as CriterionEvidence & { meta?: { assessment_source?: string; dynamic_reference?: { segment_matched?: boolean } } }).meta;
      return c.provenance.evaluator === 'dynamic_reference' && meta?.assessment_source === 'dynamic_reference_completed'
        && meta.dynamic_reference?.segment_matched === true && new Set(c.evidence.frame_ids).size >= 3;
    });
    if (this.cleanAssessments < 2 && !measuredReferenceEnd) return null;
    // Same guards as a technique cue: nothing is spoken in a non-cueable phase or while a primary cue is active.
    if (!input.cue_allowed) {
      this.lastSuppressed = 'phase_not_cueable';
      return null;
    }
    if (this.active) return null;
    if (this.lastPositiveMs !== null && t - this.lastPositiveMs < interval) return null;
    if (this.lastIssuedMs !== null && t - this.lastIssuedMs < (this.templates.policy?.global_min_interval_ms ?? 5000)) return null;
    const locale = this.opts.locale ?? this.templates.default_locale;
    // A draft positive cue is unreviewed text and sits behind the same review gate as a correction.
    const entry = passes.map((p) => this.entryFor(p)).find((e) => e?.positive_cue && (e.review_status === 'approved' || this.opts.allow_draft_cues));
    const text = entry?.positive_cue?.[locale] ?? entry?.positive_cue?.en ?? null;
    if (!text) {
      if (passes.some((p) => this.entryFor(p)?.positive_cue)) this.lastSuppressed = 'feedback_not_reviewed';
      return null;
    }
    this.lastPositiveMs = t;
    this.lastIssuedMs = t;
    return this.action(input, { kind: 'positive_reinforcement', priority: 'secondary', error_id: entry!.error_id, criterion_id: null, text, rationale: null, cooldown_ms: interval, evidence: [input.frame_id], review_status: entry!.review_status });
  }

  private entryFor(c: CriterionEvidence) {
    const errorId = c.feedback?.error_id ?? this.opts.criterion_error_ids?.[c.criterion_id] ?? this.templates.entries.find((e) => e.error_id.startsWith(c.criterion_id))?.error_id;
    return this.templates.entries.find((e) => e.error_id === errorId) ?? null;
  }

  private observationKey(c: CriterionEvidence, scope?: string | null): string {
    return `${scope ?? ''}:${c.phase_id ?? ''}:${c.timestamp_ms}:${c.evidence.frame_ids.join(',')}`;
  }

  private action(input: CoachingInput, p: { kind: FeedbackAction['kind']; priority: FeedbackAction['priority']; error_id: string | null; criterion_id: string | null; text: string; rationale: string | null; cooldown_ms: number; evidence: number[]; review_status: 'approved' | 'draft' }): FeedbackAction {
    this.sequence++;
    return {
      schema_version: CONTRACT_VERSION,
      session_id: this.opts.session_id,
      event_id: makeEventId(`${this.opts.session_id}:fb`, this.sequence),
      timestamp_ms: input.timestamp_ms,
      kind: p.kind,
      priority: p.priority,
      error_id: p.error_id,
      criterion_id: p.criterion_id,
      movement_id: input.movement_id,
      text: p.text,
      rationale: p.rationale,
      modality: this.opts.modality ?? ['visual', 'audio'],
      cooldown_ms: p.cooldown_ms,
      expires_ms: input.timestamp_ms + Math.min(p.cooldown_ms, 8000),
      evidence_frame_ids: p.evidence.slice(-30),
      provenance: { feedback_catalog_version: this.templates.catalog_version, sport_pack: this.opts.sport_pack_version, review_status: p.review_status },
      suppressed_reason: null,
      queued_secondary: [...this.secondary],
    };
  }
}
