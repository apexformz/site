import type { MissingReason, PoseQuality, ViewLabel } from '@apexformz/contracts';

/**
 * A landmark after validation, canonicalization and filtering.
 * Coordinates are in the frame named by the containing collection.
 */
export interface FilteredLandmark {
  id: number;
  x: number;
  y: number;
  z: number | null;
  valid: boolean;
  confidence: number;
  predicted: boolean;
  reason?: MissingReason;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number | null;
}

/**
 * Output of the signal pipeline for one frame.
 *
 * `image`  : canonical image_normalized coordinates (mirror reflected exactly once, L/R ids swapped
 *            when the frame was mirrored), unfiltered. Origin top-left, +x right, +y down.
 * `body`   : body_relative coordinates: aspect-corrected, origin at hip midpoint, divided by torso
 *            length (shoulder-mid to hip-mid, in pixels). +x image-right, +y down, z keeps the pose
 *            model's depth convention scaled by image width / torso length. Filtered with One-Euro.
 */
export interface FilteredPoseFrame {
  session_id: string;
  frame_id: number;
  timestamp_ms: number;
  dt_ms: number | null;
  image: FilteredLandmark[];
  body: FilteredLandmark[];
  root_image: Vec3 | null;
  scale_px: number | null;
  normalization_valid: boolean;
  normalization_reason?: MissingReason;
  mirror_applied: boolean;
  view: ViewLabel;
  quality: PoseQuality;
  track_id: string | null;
  time_gap: boolean;
  image_size: [number, number];
}

export interface TimeGuardResult {
  accepted: boolean;
  dt_ms: number | null;
  gap: boolean;
  regression: boolean;
  duplicate: boolean;
}

export interface SignalConfig {
  /** Gap above which temporal continuity is invalidated (TIME_GAP). Provisional engineering target. */
  max_gap_ms: number;
  /** History retained by the pose window. */
  window_ms: number;
  /** Minimum landmark visibility to treat an observation as valid. Candidate value, not validated. */
  min_visibility: number;
  /**
   * One-Euro parameters: candidates, tuned later on held-out recordings.
   * Coordinates are in torso lengths (not pixels), so speeds are O(1-10)/s; beta must be
   * much larger than the legacy pixel-space value (0.01) for fast movements to pass.
   */
  one_euro: { min_cutoff: number; beta: number; d_cutoff: number };
  /** Max plausible landmark speed in torso lengths per second before an observation is rejected. Candidate. */
  outlier_max_speed: number;
  /** Allow one-frame linear prediction over a rejected or missing sample. */
  allow_short_gap_prediction: boolean;
  /** Nominal athlete view supplied by calibration. */
  view: ViewLabel;
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  max_gap_ms: 400,
  window_ms: 3000,
  min_visibility: 0.5,
  one_euro: { min_cutoff: 1.7, beta: 0.6, d_cutoff: 1.0 },
  outlier_max_speed: 30,
  allow_short_gap_prediction: true,
  view: 'unknown',
};
