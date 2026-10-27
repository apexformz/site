import type { AssessmentSet, FeedbackAction } from '@apexformz/contracts';
import { criterionFeedbackCorrection, isDynamicReferenceCriterion } from '@apexformz/brain-client';
import { criterionExplanation } from './criterionPresentation';

export interface TechniqueSummary {
  state: 'waiting' | 'adjust' | 'in_range' | 'unassessed';
  title: string;
  detail: string;
  passed: number;
  corrections: number;
  unassessed: number;
  provisional: boolean;
}

/** Draft reference cues use the same current correction in the card and voice channel. */
export function projectDraftReferenceFeedback(feedback: FeedbackAction | null, assessment: AssessmentSet | null): FeedbackAction | null {
  if (!feedback || !assessment || feedback.kind !== 'technique_cue' || feedback.provenance.review_status !== 'draft'
    || feedback.movement_id !== assessment.movement_id || !feedback.criterion_id) return feedback;
  const criterion = assessment.criteria.find(c => c.criterion_id === feedback.criterion_id && c.state === 'IMPROVE'
    && ['reference_nearest', 'dynamic_reference'].includes(c.provenance.evaluator) && c.timestamp_ms === assessment.timestamp_ms
    && c.timestamp_ms >= feedback.timestamp_ms);
  const text = criterion ? criterionFeedbackCorrection(criterion) : null;
  return text && text !== feedback.text ? { ...feedback, text } : feedback;
}

/** Summarize actual selected-target measurements. Classifier identity is never an input. */
export function summarizeTechnique(assessment: AssessmentSet | null, waiting: { title: string; description: string }, movementType: 'static' | 'dynamic' = 'static'): TechniqueSummary {
  const base = { passed: 0, corrections: 0, unassessed: 0, provisional: false };
  if (!assessment || !assessment.criteria.length) return { ...base, state: 'waiting', title: waiting.title, detail: waiting.description };
  const criteria = assessment.criteria.filter(c => c.state !== 'NOT_APPLICABLE');
  const rank = { safety: 4, high: 3, medium: 2, low: 1 };
  const corrections = criteria.filter(c => c.state === 'IMPROVE').sort((a, b) => (rank[b.severity ?? 'low'] ?? 0) - (rank[a.severity ?? 'low'] ?? 0));
  const passed = criteria.filter(c => c.state === 'PASS').length;
  const unassessed = criteria.length - passed - corrections.length;
  const counts = { passed, corrections: corrections.length, unassessed, provisional: criteria.some(c => c.provenance.provisional || c.provenance.validation_status !== 'approved') };
  if (corrections.length) return {
    ...counts, state: 'adjust', title: corrections.length === 1 ? '1 correction to make' : `${corrections.length} corrections to make`,
    detail: corrections.map(criterionFeedbackCorrection).find(Boolean) ?? 'Adjust the highlighted body position. See the measured checks for details.',
  };
  const referencePasses = criteria.some(c => c.state === 'PASS' && isDynamicReferenceCriterion(c));
  if (passed) return {
    ...counts, state: 'in_range', title: `${passed} ${passed === 1 ? 'check' : 'checks'} in range`,
    detail: unassessed ? `${unassessed} ${unassessed === 1 ? 'check still needs' : 'checks still need'} clearer evidence. ${movementType === 'dynamic' ? 'Keep your full body visible through the movement.' : 'Keep the selected position in view.'}`
      : referencePasses ? 'The measured parts of this attempt are within the preview limits of the selected recording. This does not confirm ball contact or every technique check.'
      : counts.provisional ? movementType === 'dynamic' ? 'The observed checks meet the draft limits for this part of your attempt.' : 'The observed checks meet the draft target. Keep holding the position; these criteria still need coach validation.'
        : 'The observed checks meet the reviewed target. Keep following the selected drill.',
  };
  const reason = criteria.find(c => c.measurement.reason);
  return {
    ...counts, state: 'unassessed', title: reason?.measurement.reason === 'RUBRIC_UNVALIDATED' ? 'Reviewed criteria unavailable' : 'Measurements need clearer evidence',
    detail: reason ? criterionExplanation(reason) ?? 'Keep the relevant joints visible for the selected drill.' : 'The current measurements cannot yet establish a technique verdict.',
  };
}
