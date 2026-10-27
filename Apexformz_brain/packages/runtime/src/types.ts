import type { HumanVarianceOverrides } from '@apexformz/scoring';
import type { OutboxSink } from './outbox';
import type { PackTrustMode, PackTrustRegistry } from '@apexformz/sport-runtime';
import type {
  AssessmentSet, Capability, FeatureValue, FeedbackAction, MissingReason, Platform, SessionState, TelemetrySample,
} from '@apexformz/contracts';
import type { FilteredLandmark, SignalConfig } from '@apexformz/signal';
import type { RepetitionEstimate, TemporalUpdate } from '@apexformz/analysis';

/** Endpoint review is retained only during a continuously safe post-attempt interval. */
export const GUIDED_REVIEW_MAX_AGE_MS = 8000;

export interface BrainRuntimeConfig {
  platform: Platform;
  /** Provisional rubrics abstain (UNCERTAIN) when true. Production default. */
  strict_rubrics: boolean;
  /** Attach unreviewed cue text to IMPROVE results and allow issuing it. Development only. */
  allow_draft_feedback: boolean;
  /** Assess visible attempts of the selected drill, without requiring a correct pose to enter coaching. */
  guided_coaching?: boolean;
  /** Runtime overrides for the human variance model; the pack rubric profile sits between these and the (inert) core defaults. */
  human_variance?: HumanVarianceOverrides;
  signal?: Partial<SignalConfig>;
  capabilities_available: Capability[];
  telemetry_interval_ms: number;
  outbox_quota: number;
  /**
   * Recognition-gated coaching. When enabled, technique cues pause while a recent, confident recognition places the
   * athlete in a different taxonomy family from the selected drill. Off by default; with require_validated (default)
   * provisional recognizers never gate coaching.
   */
  recognition_gating?: { enabled: boolean; min_probability?: number; max_age_ms?: number; require_validated?: boolean };
  /** Optional durable store behind the event outbox (IndexedDB in the browser worker). */
  outbox_sink?: OutboxSink;
  /** Continuous bad quality before ACTIVE -> DEGRADED. */
  degraded_after_ms: number;
  /** Consecutive good-quality frames required to leave DEGRADED. */
  revalidate_frames: number;
  /** No frames for this long (via heartbeat) => CAMERA_LOST degraded. */
  camera_lost_ms: number;
  /** Signing secrets for pack verification keyed by key_id. */
  hmac_keys?: Record<string, string>;
  pack_trust_mode?: PackTrustMode;
  pack_trust_registry?: PackTrustRegistry;
  allow_unsigned_packs?: boolean;
  producer: string;
  /** Include body-relative landmarks in each tick (for overlays/debug). */
  emit_landmarks: boolean;
  locale?: string;
}

export const DEFAULT_RUNTIME_CONFIG: BrainRuntimeConfig = {
  platform: 'web',
  strict_rubrics: true,
  allow_draft_feedback: false,
  capabilities_available: ['body_pose'],
  telemetry_interval_ms: 1000,
  outbox_quota: 5000,
  degraded_after_ms: 1500,
  revalidate_frames: 10,
  camera_lost_ms: 2000,
  producer: 'apexformz-brain-runtime',
  emit_landmarks: false,
};

export interface BrainTick {
  tick_id: number;
  frame_id: number;
  timestamp_ms: number;
  session_state: SessionState;
  quality: { ok: boolean; reasons: MissingReason[] };
  signal: { dropped: boolean; drop_reason?: string; time_gap: boolean; track_changed: boolean; normalization_valid: boolean; mirror_applied: boolean };
  features: FeatureValue[];
  temporal: TemporalUpdate | null;
  /** Class-agnostic periodicity / repetition estimate over the pack's features (RepNet-style). */
  repetition: RepetitionEstimate | null;
  assessment: AssessmentSet | null;
  /** Fresh reference alignment state; independent of recognized repetitions. */
  dynamic_reference?: {
    status: 'waiting' | 'active' | 'complete' | 'incomplete' | 'unavailable';
    progress: number; reference_id: string | null; attempt_id: string | null;
    cue_allowed: boolean; current: boolean; reason: MissingReason | null; complete_capture: boolean;
  } | null;
  /** A quality-checked observation of the intended setup/hold; does not assert recognized execution. */
  guided_attempt?: { phase_id: string; since_ms: number; cue_allowed: boolean; source?: 'motion_bout' } | null;
  /** Endpoint evidence for an attempted phase; not a recognized/completed repetition. */
  guided_completion?: { phase_id: string; since_ms: number; ended_ms: number; cue_allowed: boolean; source?: 'motion_bout' } | null;
  feedback: FeedbackAction | null;
  suppressed_reason: string | null;
  executed_pack: { id: string; version: string };
  telemetry: TelemetrySample | null;
  body_landmarks?: FilteredLandmark[];
}

export interface SessionSummary {
  session_id: string;
  sport_pack_id: string;
  sport_pack_version: string;
  movement_id: string;
  frames_processed: number;
  frames_discarded: number;
  executions_completed: number;
  executions_aborted: number;
  assessments: number;
  feedback_issued: number;
  last_score: number | null;
  criterion_state_counts: Record<string, number>;
  abstention_reasons: Record<string, number>;
  outbox_pending: number;
  transitions: number;
}

/** Latest movement recognition reported by the host (worker) for recognition-gated coaching. */
export interface RecognitionContext {
  timestamp_ms: number;
  level: 'movement' | 'group' | 'family' | null;
  family_id: string | null;
  group_id: string | null;
  movement_id: string | null;
  probability: number | null;
  validated: boolean;
}
