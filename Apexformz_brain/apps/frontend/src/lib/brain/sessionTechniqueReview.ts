import { SESSION_REVIEW_MAX_CRITERIA, SESSION_REVIEW_MAX_PHASES, type AssessmentSet, type CriterionEvidence, type SessionTechniqueReview, type TechniqueReviewObservation } from '@apexformz/contracts';
import { criterionFeedbackCorrection, criterionFeedbackLabel, criterionVisualCue, isDynamicReferenceCriterion, type VisualFeedbackContext } from '@apexformz/brain-client';
import { criterionExplanation } from './criterionPresentation';

export interface TechniqueReviewAccumulator { review: SessionTechniqueReview; seen: Set<string>; criterionSeen: Map<string, { timestamp: number; keys: Set<string> }> }
export function createTechniqueReview(sessionId: string, movementId: string, plannedChecks: NonNullable<SessionTechniqueReview['planned_checks']> = []): TechniqueReviewAccumulator {
  return { review: { version: 1, session_id: sessionId, movement_id: movementId, assessments_observed: 0, nonempty_assessments: 0, phases: [], criteria: [], planned_checks: plannedChecks.slice(0, SESSION_REVIEW_MAX_CRITERIA) }, seen: new Set(), criterionSeen: new Map() };
}

export function observationForReview(c: CriterionEvidence, context: VisualFeedbackContext = {}): TechniqueReviewObservation {
  const areas = criterionVisualCue(c, context).affected_joints.map(joint => /nose|eye|ear|mouth/.test(joint) ? 'Head' : joint.replace(/_/g, ' '));
  return {
    timestamp_ms: c.timestamp_ms, state: c.state, value: c.measurement.value, unit: c.measurement.unit, reason: c.measurement.reason ?? null,
    correction: c.state === 'IMPROVE' ? criterionFeedbackCorrection(c)?.slice(0, 1000) ?? null : null,
    rationale: c.state === 'IMPROVE' ? c.feedback?.rationale?.slice(0, 1000) ?? null
      : isDynamicReferenceCriterion(c) ? criterionExplanation(c)?.slice(0, 1000) ?? null : null,
    body_areas: [...new Set(areas)].slice(0, 12), provisional: c.provenance.provisional === true || c.provenance.validation_status !== 'approved',
    source: c.retrospective ? 'retrospective' : ['guided_attempt_completed', 'dynamic_reference_completed'].includes((c as CriterionEvidence & { meta?: { assessment_source?: string } }).meta?.assessment_source ?? '') ? 'attempt_review' : 'live',
  };
}

/** Consume the worker event stream, not render cadence. No frames or landmarks are retained. */
export function recordTechniqueAssessment(accumulator: TechniqueReviewAccumulator, assessment: AssessmentSet | null, context: VisualFeedbackContext = {}): void {
  if (!assessment || assessment.session_id !== accumulator.review.session_id || assessment.movement_id !== accumulator.review.movement_id) return;
  const key = `${assessment.event_id}/${assessment.timestamp_ms}/${assessment.phase_id ?? ''}`;
  if (accumulator.seen.has(key)) return;
  accumulator.seen.add(key);
  if (accumulator.seen.size > 512) accumulator.seen.delete(accumulator.seen.values().next().value!);
  const review = accumulator.review;
  review.assessments_observed++;
  if (assessment.criteria.length) review.nonempty_assessments++;
  for (const c of assessment.criteria) {
    if (c.movement_id !== review.movement_id || c.state === 'NOT_APPLICABLE') continue;
    const phase = c.phase_id ?? assessment.phase_id ?? null;
    const criterionKey = `${c.criterion_id}/${phase ?? ''}`;
    const seen = accumulator.criterionSeen.get(criterionKey);
    // Full execution results can repeat criteria already published at a phase end.
    // Timestamps are monotonic; old evidence cannot become a new observation.
    const evidenceKey = `${c.timestamp_ms}/${c.evidence.frame_ids.join(',')}`;
    if (seen && (c.timestamp_ms < seen.timestamp || seen.keys.has(evidenceKey))) continue;
    if (phase && !review.phases.includes(phase) && review.phases.length < SESSION_REVIEW_MAX_PHASES) review.phases.push(phase);
    let entry = review.criteria.find(item => item.criterion_id === c.criterion_id && item.phase_id === phase);
    if (!entry) {
      if (review.criteria.length >= SESSION_REVIEW_MAX_CRITERIA) continue;
      entry = { criterion_id: c.criterion_id, name: criterionFeedbackLabel(c).slice(0, 200), phase_id: phase, observations: 0, state_counts: {}, first_measured: null, latest_measured: null, latest_correction: null, latest_unassessed: null };
      review.criteria.push(entry);
    }
    const evidence = seen && seen.timestamp === c.timestamp_ms ? seen : { timestamp: c.timestamp_ms, keys: new Set<string>() };
    if (evidence.keys.size >= 32) continue;
    evidence.keys.add(evidenceKey);
    accumulator.criterionSeen.set(criterionKey, evidence);
    const observation = observationForReview(c, context);
    entry.observations++;
    entry.state_counts[c.state] = (entry.state_counts[c.state] ?? 0) + 1;
    if (c.state === 'PASS' || c.state === 'IMPROVE') {
      if (!entry.first_measured || observation.timestamp_ms < entry.first_measured.timestamp_ms) entry.first_measured = observation;
      if (!entry.latest_measured || observation.timestamp_ms >= entry.latest_measured.timestamp_ms) entry.latest_measured = observation;
      if (c.state === 'IMPROVE' && (!entry.latest_correction || observation.timestamp_ms >= entry.latest_correction.timestamp_ms)) entry.latest_correction = observation;
    } else if (!entry.latest_unassessed || observation.timestamp_ms >= entry.latest_unassessed.timestamp_ms) entry.latest_unassessed = observation;
  }
}

export function reviewMissingExplanation(observation: TechniqueReviewObservation): string {
  if (['UNCERTAIN', 'NOT_ASSESSABLE'].includes(observation.state) && observation.rationale) return observation.rationale;
  return criterionExplanation({ state: observation.state, measurement: { value: observation.value, unit: observation.unit, reason: observation.reason } }) ?? 'This part of the movement needs clearer evidence.';
}

/** Present each received check once as measured or never measured. Keep all historical evidence in storage. */
export function sessionReviewPresentation(review: SessionTechniqueReview | null) {
  const criteria = review?.criteria ?? [];
  const hasMeasurement = (entry: typeof criteria[number]) => Boolean(entry.first_measured || entry.latest_measured || (entry.state_counts.PASS ?? 0) + (entry.state_counts.IMPROVE ?? 0) > 0);
  const withheld = (entry: typeof criteria[number]) => (entry.state_counts.UNCERTAIN ?? 0) + (entry.state_counts.NOT_ASSESSABLE ?? 0);
  // Older saved reviews included the generic catalogue alongside the active
  // reference engine. Hide only its unobserved planned checks, never evidence.
  const isReference = (id: string) => id.includes('.dynamic_reference.');
  const referenceSelected = [...criteria, ...(review?.planned_checks ?? [])].some(entry => isReference(entry.criterion_id));
  const measured = criteria.filter(hasMeasurement);
  const withheldMeasured = measured.filter(entry => withheld(entry) > 0);
  return {
    corrections: criteria.filter(entry => entry.latest_correction),
    passed: criteria.filter(entry => (entry.state_counts.PASS ?? 0) > 0),
    missing: criteria.filter(entry => !hasMeasurement(entry) && entry.latest_unassessed),
    unobserved: review?.planned_checks?.filter(check => (!referenceSelected || isReference(check.criterion_id)) && !criteria.some(entry => entry.criterion_id === check.criterion_id)) ?? [],
    receivedCount: criteria.length, measuredCount: measured.length,
    withheldMeasuredChecks: withheldMeasured.length,
    withheldMeasuredObservations: withheldMeasured.reduce((sum, entry) => sum + withheld(entry), 0),
  };
}

/** Older saved sessions remain readable, with their explicitly limited final snapshot. */
export function reviewFromLastAssessment(assessment: AssessmentSet | null): SessionTechniqueReview | null {
  if (!assessment) return null;
  const accumulator = createTechniqueReview(assessment.session_id, assessment.movement_id);
  recordTechniqueAssessment(accumulator, assessment);
  return accumulator.review;
}
