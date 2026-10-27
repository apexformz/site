import type { MissingReason, MovementEvent, RecognitionState } from '@apexformz/contracts';

export interface TemporalSessionContext {
  session_id: string;
  sport_pack_id: string;
  sport_pack_version: string;
  movement_id: string;
  model_version: string;
}

export interface PhaseSpan {
  phase_id: string;
  start_ms: number;
  end_ms: number | null;
  start_frame: number;
  end_frame: number | null;
}

export interface TemporalUpdate {
  frame_id: number;
  timestamp_ms: number;
  state: RecognitionState;
  previous_state: RecognitionState;
  movement_id: string;
  phase_id: string | null;
  previous_phase_id: string | null;
  phase_changed: boolean;
  phase_entered_ms: number | null;
  phase_duration_ms: number | null;
  /** Phase that just ended (when phase_changed or completion). */
  ended_phase: PhaseSpan | null;
  execution_id: string | null;
  execution_started_ms: number | null;
  completed: boolean;
  aborted_reason: string | null;
  unknown_reason: string | null;
  confidence: number;
  evidence_frames: number[];
  /** Phase spans of the current (or just completed) execution. */
  execution_phases: PhaseSpan[];
  /** Whether verbal cues are allowed in the current phase. */
  cue_allowed: boolean;
  contact_evidence: 'none' | 'unobserved' | 'estimated_contact' | 'sensed_contact';
  /** MovementEvents emitted by this update (transitions only). */
  events: MovementEvent[];
  /** Reasons conditions could not be evaluated this frame. */
  blocked_reasons: MissingReason[];
}
