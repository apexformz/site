import type { CriterionEvidence } from '@apexformz/contracts';

const REASONS: Record<string, string> = {
  RUBRIC_UNVALIDATED: 'This criterion needs coach validation. Reviewed coaching withholds its verdict.',
  RUBRIC_DISABLED: 'This criterion is currently disabled.',
  VIEW_INVALID: 'This criterion cannot be measured from the selected camera view. Change the view in setup.',
  MISSING_JOINT: 'Keep the relevant joints in view so this criterion can be measured.',
  LOW_CONFIDENCE: 'The relevant landmarks are not clear enough for a reliable correction.',
  FRAMING_INVALID: 'Move so your full body is visible in the camera.',
  AMBIGUOUS_SUBJECT: 'Keep one athlete in view or select the athlete to track.',
  INSUFFICIENT_HISTORY: 'More clear frames are needed to measure this criterion.',
  PHASE_NOT_ACTIVE: 'This criterion waits for its movement phase. Setup posture can still be checked.',
  MOVEMENT_NOT_CONFIRMED: 'There is not enough movement evidence to assess this part of the drill.',
  CONTACT_UNOBSERVED: 'Ball or racket contact is not visible to the body-pose model.',
  EQUIPMENT_UNOBSERVED: 'The required equipment measurement is unavailable.',
  CAPABILITY_MISSING: 'The sensor needed for this criterion is unavailable.',
  SCALE_UNKNOWN: 'A calibrated distance reference is needed for this measurement.',
  HANDEDNESS_UNKNOWN: 'Choose your dominant hand in setup for this criterion.',
  WITHIN_NORMAL_VARIANCE: 'The difference is too small or variable to justify a correction.',
  COVERAGE_INSUFFICIENT: 'Too little reliable evidence is available for a verdict.',
  TRACK_CHANGED: 'The athlete track changed. Waiting for fresh evidence.',
  TIME_GAP: 'Tracking was interrupted. Waiting for fresh evidence.',
  STALE_FRAME: 'The measurement is old. Waiting for a fresh pose.',
  MODEL_UNAVAILABLE: 'The model needed for this criterion is unavailable.',
  NOT_APPLICABLE: 'This criterion does not apply to the current attempt.',
  CONTRADICTORY_EVIDENCE: 'Measurements disagree, so no correction is issued.',
};

export function criterionExplanation(criterion: Pick<CriterionEvidence, 'measurement' | 'state'> & Partial<Pick<CriterionEvidence, 'provenance'>>): string | null {
  const reason = criterion.measurement.reason;
  if (criterion.provenance?.evaluator === 'dynamic_reference') {
    const reference = (criterion as CriterionEvidence & { meta?: { dynamic_reference?: { status?: string; complete_capture?: boolean } } }).meta?.dynamic_reference;
    if (reason === 'MODEL_UNAVAILABLE') return 'There is no usable recorded movement reference for this drill. Tracking remains available, but this comparison has no verdict.';
    if (reason === 'VIEW_INVALID') return 'No usable movement reference matches this camera view. Check the available recorded views in setup and match the camera’s actual placement.';
    if (reason === 'HANDEDNESS_UNKNOWN') return 'The movement reference must match your actual dominant hand. Check handedness and available references in setup.';
    if (reason === 'COVERAGE_INSUFFICIENT' && reference?.complete_capture === false && reference.status === 'incomplete') return criterion.measurement.feature_id
      ? 'This body measurement was unavailable in the recorded or observed portion. It has no verdict for this attempt.'
      : 'Only a recorded segment is available. The unrecorded remainder cannot receive a verdict from this reference.';
    if (reason === 'INSUFFICIENT_HISTORY') return 'This check did not reach a measured verdict during the observed movement. It is not counted as correct or incorrect.';
    if (reason === 'COVERAGE_INSUFFICIENT') return 'Too few reliable body measurements were available for this comparison. Keep the relevant joints visible and use the matching recorded camera view.';
    if (reason === 'MOVEMENT_NOT_CONFIRMED' || reason === 'CONTRADICTORY_EVIDENCE') return 'The movement cannot yet be aligned reliably with the selected recording. Begin from its starting position; this is not counted as correct.';
  }
  if (reason) return REASONS[reason] ?? 'This measurement is not reliable enough for a technique verdict.';
  if (criterion.state === 'UNCERTAIN' || criterion.state === 'NOT_ASSESSABLE') return 'There is not enough reliable evidence for a technique verdict.';
  return null;
}
