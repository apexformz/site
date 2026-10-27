import type { AssessmentSet, FeedbackAction, MovementCatalog, MovementDefinition } from '@apexformz/contracts';
import { hasCurrentObservationAssessment, isDynamicReferenceCriterion, LIVE_ASSESSMENT_MAX_AGE_MS, type MovementDetection } from '@apexformz/brain-client';
import { GUIDED_REVIEW_MAX_AGE_MS, type BrainTick } from '@apexformz/runtime';

export function trackingBoundary(tick: BrainTick): boolean {
  return tick.signal.time_gap || tick.signal.track_changed
    || tick.quality.reasons.some((r) => r === 'AMBIGUOUS_SUBJECT' || r === 'TRACK_CHANGED');
}

/** Same identity contract as the runtime: exact ids/UUIDs and approved aliases only. */
export function selectedMovement(catalog: MovementCatalog, id: string | null): MovementDefinition | null {
  if (!id) return null;
  return catalog.movements.find((m) => m.id === id || m.uuid === id)
    ?? catalog.movements.find((m) => m.aliases.some((a) => a.status === 'approved' && a.name.toLowerCase() === id.trim().toLowerCase()))
    ?? null;
}

/** Recognition is live evidence; a paused camera or another session cannot retain a label. */
export function currentDetections(
  detections: Partial<Record<'static_pose' | 'dynamic_movement', MovementDetection>>,
  live: boolean, sessionId: string | null, nowMs: number, sinceMs: number, maxAgeMs = 1000,
): typeof detections {
  if (!live || !sessionId) return {};
  return Object.fromEntries(Object.entries(detections).filter(([, d]) => d && d.session_id === sessionId
    && d.timestamp_ms >= sinceMs && nowMs >= d.timestamp_ms && nowMs - d.timestamp_ms <= maxAgeMs));
}

/** Keep the last phase assessment within one execution, but never carry it over a tracking reset. */
export function currentAssessment(assessment: AssessmentSet | null, tick: BrainTick | null, sinceMs: number): AssessmentSet | null {
  if (!assessment || !tick || !tick.quality.ok || tick.signal.dropped
    || (trackingBoundary(tick) && !hasCurrentObservationAssessment(tick, assessment)) || assessment.timestamp_ms < sinceMs) return null;
  const temporal = tick.temporal;
  // The recorded trajectory has its own alignment, independent of the
  // heuristic stroke-phase graph. It never inherits that graph's execution ID.
  if (assessment.criteria.some(isDynamicReferenceCriterion)) {
    if (temporal && assessment.movement_id !== temporal.movement_id) return null;
    const reference = tick.dynamic_reference;
    const attempt = assessment.criteria.find(isDynamicReferenceCriterion) as typeof assessment.criteria[number] & { meta?: { dynamic_reference?: { attempt_id?: string } } };
    if (reference?.status === 'active' && reference.attempt_id && attempt.meta?.dynamic_reference?.attempt_id && reference.attempt_id !== attempt.meta.dynamic_reference.attempt_id) return null;
    return tick.timestamp_ms >= assessment.timestamp_ms && tick.timestamp_ms - assessment.timestamp_ms <= LIVE_ASSESSMENT_MAX_AGE_MS ? assessment : null;
  }
  if (temporal && (assessment.movement_id !== temporal.movement_id
    || (assessment.execution_id && temporal.execution_id && assessment.execution_id !== temporal.execution_id))) return null;
  const completed = assessment.criteria.some(c => (c as typeof c & { meta?: { assessment_source?: string } }).meta?.assessment_source === 'guided_attempt_completed');
  if (completed) {
    const endpoint = tick.guided_completion;
    if (!endpoint || assessment.phase_id !== endpoint.phase_id || assessment.timestamp_ms < endpoint.ended_ms
      || tick.timestamp_ms < endpoint.ended_ms || tick.timestamp_ms - endpoint.ended_ms > GUIDED_REVIEW_MAX_AGE_MS
      || tick.guided_attempt?.cue_allowed === false) return null;
    return assessment;
  }
  if (tick.timestamp_ms < assessment.timestamp_ms || tick.timestamp_ms - assessment.timestamp_ms > LIVE_ASSESSMENT_MAX_AGE_MS) return null;
  if (tick.guided_attempt && (assessment.phase_id !== tick.guided_attempt.phase_id || assessment.timestamp_ms < tick.guided_attempt.since_ms)) return null;
  const guided = assessment.criteria.some(c => (c as typeof c & { meta?: { assessment_source?: string } }).meta?.assessment_source === 'guided_attempt');
  if (guided && (!tick.guided_attempt || assessment.phase_id !== tick.guided_attempt.phase_id || assessment.timestamp_ms < tick.guided_attempt.since_ms)) return null;
  return assessment;
}

/** Respect the policy's expiry and phase permissions between sparse feedback events. */
export function currentFeedback(feedback: FeedbackAction | null, tick: BrainTick | null, live: boolean, nowMs: number): FeedbackAction | null {
  if (!live || !feedback || !tick || feedback.expires_ms <= nowMs || feedback.timestamp_ms > nowMs) return null;
  if (feedback.kind === 'setup_instruction' || feedback.kind === 'quality_instruction') return tick.quality.ok ? null : feedback;
  const currentObservation = hasCurrentObservationAssessment(tick);
  const stillSupported = Boolean(currentObservation && feedback.kind === 'technique_cue' && feedback.criterion_id
    && feedback.movement_id === tick.assessment?.movement_id
    && tick.assessment?.criteria.some(c => c.criterion_id === feedback.criterion_id && c.state === 'IMPROVE'));
  if (currentObservation && feedback.kind === 'technique_cue' && feedback.criterion_id && !stillSupported) return null;
  if (!tick.quality.ok || tick.signal.dropped || tick.signal.track_changed
    || tick.quality.reasons.some(r => r === 'AMBIGUOUS_SUBJECT' || r === 'TRACK_CHANGED')
    || tick.signal.time_gap && !stillSupported && (!currentObservation || feedback.timestamp_ms !== tick.timestamp_ms)) return null;
  // The runtime has observed current stillness before releasing a reference
  // correction, including deferred evidence whose action phase has ended.
  if (tick.dynamic_reference) return feedback.priority === 'safety' || tick.dynamic_reference.cue_allowed
    && feedback.movement_id === tick.temporal?.movement_id ? feedback : null;
  const guidedCue = tick.guided_attempt?.cue_allowed && (stillSupported || feedback.timestamp_ms >= tick.guided_attempt.since_ms
    && feedback.movement_id === tick.temporal?.movement_id);
  const completionCue = tick.guided_completion?.cue_allowed && nowMs - tick.guided_completion.ended_ms <= GUIDED_REVIEW_MAX_AGE_MS
    && feedback.timestamp_ms >= tick.guided_completion.ended_ms && feedback.movement_id === tick.temporal?.movement_id;
  const cueAllowed = tick.guided_attempt ? tick.guided_attempt.cue_allowed && (guidedCue || completionCue)
    : tick.guided_completion ? completionCue : tick.temporal?.cue_allowed;
  if (feedback.priority !== 'safety' && !cueAllowed) return null;
  return feedback;
}
