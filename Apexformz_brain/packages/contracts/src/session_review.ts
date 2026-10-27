import type { CriterionState, MissingReason, Unit } from './enums';

/** Bounded, pose-free presentation evidence; counts are observations, never repetitions. */
export interface TechniqueReviewObservation {
  timestamp_ms: number;
  state: CriterionState;
  value: number | null;
  unit: Unit;
  reason: MissingReason | null;
  correction: string | null;
  rationale: string | null;
  body_areas: string[];
  provisional: boolean;
  source: 'live' | 'attempt_review' | 'retrospective';
}

export interface SessionCriterionReview {
  criterion_id: string;
  name: string;
  phase_id: string | null;
  observations: number;
  state_counts: Partial<Record<CriterionState, number>>;
  first_measured: TechniqueReviewObservation | null;
  latest_measured: TechniqueReviewObservation | null;
  latest_correction: TechniqueReviewObservation | null;
  latest_unassessed: TechniqueReviewObservation | null;
}

export interface SessionTechniqueReview {
  version: 1;
  session_id: string;
  movement_id: string;
  assessments_observed: number;
  nonempty_assessments: number;
  phases: string[];
  planned_checks?: Array<{ criterion_id: string; name: string }>;
  criteria: SessionCriterionReview[];
}

export const SESSION_REVIEW_MAX_CRITERIA = 64;
export const SESSION_REVIEW_MAX_PHASES = 32;
