import type { CriterionEvidence } from '@apexformz/contracts';
import type { BrainTick } from '@apexformz/runtime';
import { criterionFeedbackCorrection, criterionFeedbackLabel, criterionVisualCue, isDynamicReferenceCriterion, type VisualCue, type VisualFeedbackContext } from './visual_feedback';

/**
 * Adapter from BrainTick to the legacy ApexFormz `FrameAnalysis` shape so the
 * existing UI components (PoseSkeleton, ActionableFeedback, TrainingStats)
 * keep working. Abstentions are preserved: a null score is reported as
 * `score_available: false`, never as a fake number, and only IMPROVE criteria
 * with reviewed feedback become "issues".
 */
export interface LegacyIssue {
  joint: string;
  problem: string;
  correction: string;
  severity: 'low' | 'medium' | 'high' | 'none';
  phase?: string;
  criterion_id?: string;
  state?: CriterionEvidence['state'];
  reason?: string | null;
  provisional?: boolean;
  affected_joints?: string[];
  affected_segments?: VisualCue['affected_segments'];
}

export interface LegacyFrameAnalysis {
  score: number;
  score_available: boolean;
  overall_severity: 'good' | 'warning' | 'error';
  issues: LegacyIssue[];
  visual_cues: VisualCue[];
  joint_angles: Record<string, number>;
  pose_name: string;
  dynamic: boolean;
  current_phase: string;
  phase_index: number;
  phase_changed: boolean;
  phase_scores: Record<string, number>;
  rep_count: number;
  rep_completed: boolean;
  fluidity_score: number;
  kinetic_chain: { score: number; order_expected: string[]; order_actual: string[] };
  total_phases: number;
  is_cyclical: boolean;
  trajectory_similarity: number | null;
  aqa_grade: number | null;
  brain: {
    recognition_state: string | null;
    quality_ok: boolean;
    quality_reasons: string[];
    criteria: CriterionEvidence[];
    coverage: number | null;
    suppressed_reason: string | null;
    provisional: boolean;
  };
}

const SEVERITY: Record<string, LegacyIssue['severity']> = { safety: 'high', high: 'high', medium: 'medium', low: 'low' };
/** One freshness window for current body colors, correction text, and the live assessment card. */
export const LIVE_ASSESSMENT_MAX_AGE_MS = 2000;
/** Geometry from this frame survives a cadence gap; previous-frame or identity-ambiguous evidence does not. */
export function hasCurrentObservationAssessment(tick: BrainTick, assessment = tick.assessment): boolean {
  return Boolean(assessment && assessment.timestamp_ms === tick.timestamp_ms && assessment.criteria.length > 0
    && tick.quality.ok && !tick.signal.dropped && !tick.signal.track_changed
    && !tick.quality.reasons.some(r => r === 'AMBIGUOUS_SUBJECT' || r === 'TRACK_CHANGED')
    && assessment.criteria.every(c => (c as CriterionEvidence & { meta?: { current_observation?: boolean } }).meta?.current_observation === true
      && c.evidence.frame_ids.length === 1 && c.evidence.frame_ids[0] === tick.frame_id));
}
const completedGuidance = (c: CriterionEvidence): boolean =>
  ['guided_attempt_completed', 'dynamic_reference_completed'].includes((c as CriterionEvidence & { meta?: { assessment_source?: string } }).meta?.assessment_source ?? '');

export interface LegacyAdapterState {
  rep_count: number;
  phase_index: Record<string, number>;
  last_assessment_criteria: CriterionEvidence[];
}

export function createLegacyAdapterState(): LegacyAdapterState {
  return { rep_count: 0, phase_index: {}, last_assessment_criteria: [] };
}

export function toLegacyFrameAnalysis(tick: BrainTick, state: LegacyAdapterState, phaseOrder: string[] = [], context: VisualFeedbackContext = {}): LegacyFrameAnalysis {
  const temporal = tick.temporal;
  const assessment = tick.assessment;
  if (assessment) state.last_assessment_criteria = assessment.criteria;
  const criteria = state.last_assessment_criteria;
  if (temporal?.completed) state.rep_count++;

  const issues: LegacyIssue[] = [];
  const currentPhase = tick.guided_attempt?.phase_id ?? temporal?.phase_id ?? null;
  const visualCues = tick.quality.ok && !tick.signal.dropped && !tick.signal.track_changed && (!tick.signal.time_gap || hasCurrentObservationAssessment(tick))
    ? criteria.filter(c => !c.retrospective && !completedGuidance(c) &&
      (isDynamicReferenceCriterion(c) ? c.timestamp_ms === tick.timestamp_ms && c.evidence.frame_ids.includes(tick.frame_id)
        : Boolean(currentPhase) && c.phase_id === currentPhase && tick.timestamp_ms >= c.timestamp_ms && tick.timestamp_ms - c.timestamp_ms <= LIVE_ASSESSMENT_MAX_AGE_MS)).map(c => criterionVisualCue(c, context))
    : [];
  for (const r of tick.quality.reasons) {
    issues.push({ joint: 'visibility', problem: r.replace(/_/g, ' ').toLowerCase(), correction: tick.feedback?.kind === 'setup_instruction' || tick.feedback?.kind === 'quality_instruction' ? tick.feedback.text : 'Adjust framing so your full body is visible.', severity: 'high', reason: r });
  }
  for (const c of criteria) {
    const textTtl = completedGuidance(c) && tick.guided_completion?.phase_id === c.phase_id ? 8000 : LIVE_ASSESSMENT_MAX_AGE_MS;
    if (c.state === 'IMPROVE' && c.feedback && !c.retrospective && tick.timestamp_ms >= c.timestamp_ms && tick.timestamp_ms - c.timestamp_ms <= textTtl) {
      const cue = criterionVisualCue(c, context);
      issues.push({ joint: criterionFeedbackLabel(c), problem: criterionFeedbackLabel(c), correction: criterionFeedbackCorrection(c) ?? c.feedback.cue, severity: SEVERITY[c.severity ?? 'low'] ?? 'low', phase: c.phase_id ?? undefined, criterion_id: c.criterion_id, state: c.state, reason: null, provisional: cue.provisional, affected_joints: cue.affected_joints, affected_segments: cue.affected_segments });
    }
  }

  const score = assessment?.score ?? null;
  const jointAngles: Record<string, number> = {};
  for (const f of tick.features) if (f.valid && f.value !== null && f.unit === 'deg') jointAngles[f.spec_id] = f.value;

  const phaseId = temporal?.phase_id ?? 'idle';
  if (phaseOrder.length) phaseOrder.forEach((p, i) => (state.phase_index[p] = i));
  const phaseScores: Record<string, number> = {};
  for (const c of criteria) if (c.score !== null && c.phase_id) phaseScores[c.phase_id] = Math.round(((phaseScores[c.phase_id] ?? c.score * 100) + c.score * 100) / 2);

  const provisional = criteria.some((c) => c.provenance.provisional);
  return {
    score: score === null ? 0 : Math.round(score * 100),
    score_available: score !== null,
    overall_severity: !tick.quality.ok ? 'error' : score === null ? 'warning' : score >= 0.76 ? 'good' : score >= 0.45 ? 'warning' : 'error',
    issues,
    visual_cues: visualCues,
    joint_angles: jointAngles,
    pose_name: temporal?.movement_id ?? '',
    dynamic: Boolean(temporal && temporal.state !== 'IDLE'),
    current_phase: phaseId,
    phase_index: state.phase_index[phaseId] ?? 0,
    phase_changed: temporal?.phase_changed ?? false,
    phase_scores: phaseScores,
    rep_count: state.rep_count,
    rep_completed: temporal?.completed ?? false,
    fluidity_score: 0,
    kinetic_chain: { score: 0, order_expected: [], order_actual: [] },
    total_phases: phaseOrder.length,
    is_cyclical: true,
    trajectory_similarity: null,
    aqa_grade: null,
    brain: {
      recognition_state: temporal?.state ?? null,
      quality_ok: tick.quality.ok,
      quality_reasons: tick.quality.reasons,
      criteria,
      coverage: assessment?.coverage.ratio ?? null,
      suppressed_reason: tick.suppressed_reason,
      provisional,
    },
  };
}
