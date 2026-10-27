import type { AssessmentSet } from '@apexformz/contracts';
import { GUIDED_REVIEW_MAX_AGE_MS, type BrainTick } from '@apexformz/runtime';

interface ReviewContext { live: boolean; sessionId: string | null; movementId: string | null }

function validReview(review: AssessmentSet | null, tick: BrainTick | null, context: ReviewContext, nowMs: number): boolean {
  return Boolean(review && tick && context.live && context.sessionId && context.movementId
    && review.session_id === context.sessionId && review.movement_id === context.movementId
    && tick.quality.ok && !tick.signal.track_changed && !tick.signal.time_gap && !tick.signal.dropped
    && !tick.quality.reasons.some(r => r === 'AMBIGUOUS_SUBJECT' || r === 'TRACK_CHANGED')
    && nowMs >= review.timestamp_ms && nowMs - review.timestamp_ms < GUIDED_REVIEW_MAX_AGE_MS);
}

/** Remember a finished attempt for reading only; never feed this into body colors or audio. */
export function updateLastAttemptReview(previous: AssessmentSet | null, tick: BrainTick | null, context: ReviewContext, nowMs: number): AssessmentSet | null {
  const candidate = tick?.assessment;
  const completedGuidance = Boolean(candidate?.criteria.length && tick?.guided_completion
    && candidate.phase_id === tick.guided_completion.phase_id && candidate.timestamp_ms >= tick.guided_completion.ended_ms
    && candidate.criteria.some(c => (c as typeof c & { meta?: { assessment_source?: string } }).meta?.assessment_source === 'guided_attempt_completed'));
  const recognizedCompletion = Boolean(tick?.temporal?.completed && candidate?.criteria.length);
  const referenceReview = Boolean(candidate?.criteria.some(c => (c as typeof c & { meta?: { assessment_source?: string } }).meta?.assessment_source === 'dynamic_reference_completed'));
  if (candidate && !candidate.retrospective && (completedGuidance || recognizedCompletion || referenceReview) && validReview(candidate, tick, context, nowMs)) return candidate;
  return validReview(previous, tick, context, nowMs) ? previous : null;
}

/** The live card already owns its current assessment; do not show the same review twice. */
export function visibleLastAttemptReview(review: AssessmentSet | null, current: AssessmentSet | null, tick: BrainTick | null, context: ReviewContext, nowMs: number): AssessmentSet | null {
  const alreadyLive = review && current && review.session_id === current.session_id && review.event_id === current.event_id
    && review.timestamp_ms === current.timestamp_ms && review.phase_id === current.phase_id;
  if (!validReview(review, tick, context, nowMs) || alreadyLive) return null;
  return review;
}
