/**
 * Enumerations shared by every Brain module. These mirror the `$defs` in
 * schemas/common.schema.json and are validated for parity by tests/contracts.
 *
 * Nothing in this file may name a sport. Landmark names are a generic human
 * body model (MediaPipe Pose 33) and are not sport knowledge.
 */

export const COORDINATE_SYSTEMS = [
  'image_normalized',
  'image_pixel',
  'estimated_world',
  'calibrated_world',
  'body_relative',
] as const;
export type CoordinateSystem = (typeof COORDINATE_SYSTEMS)[number];

export const UNITS = [
  'deg', 'rad', 'deg_per_s', 'rad_per_s', 'deg_per_s2',
  'normalized', 'normalized_per_s', 'normalized_per_s2', 'normalized_per_s3',
  'ratio', 'ms', 's', 'px', 'm', 'm_per_s', 'count', 'score', 'probability', 'none',
] as const;
export type Unit = (typeof UNITS)[number];

export const VIEW_LABELS = [
  'front', 'back', 'left', 'right', 'front_left', 'front_right', 'back_left', 'back_right', 'top', 'unknown',
] as const;
export type ViewLabel = (typeof VIEW_LABELS)[number];
export type ViewApplicability = 'any' | ViewLabel[];

export const MISSING_REASONS = [
  'MISSING_JOINT', 'LOW_CONFIDENCE', 'DEGENERATE_GEOMETRY', 'VIEW_INVALID', 'TIME_GAP',
  'INSUFFICIENT_HISTORY', 'AMBIGUOUS_SUBJECT', 'FRAMING_INVALID', 'SCALE_UNKNOWN',
  'EQUIPMENT_UNOBSERVED', 'CONTACT_UNOBSERVED', 'TRACK_CHANGED', 'STALE_FRAME',
  'RUBRIC_UNVALIDATED', 'RUBRIC_DISABLED', 'MODEL_UNAVAILABLE', 'NOT_APPLICABLE',
  'OUTLIER_REJECTED', 'PREDICTED_SAMPLE', 'NORMALIZATION_INVALID', 'DEPENDENCY_INVALID',
  'UNKNOWN_FEATURE', 'CAPABILITY_MISSING', 'PHASE_NOT_ACTIVE', 'MOVEMENT_NOT_CONFIRMED',
  'CONTRADICTORY_EVIDENCE', 'COVERAGE_INSUFFICIENT', 'HANDEDNESS_UNKNOWN', 'WITHIN_NORMAL_VARIANCE',
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];

export const ERROR_CODES = [
  'CONTRACT_VERSION_INCOMPATIBLE', 'SCHEMA_INVALID', 'UNKNOWN_MODEL_ID', 'UNKNOWN_SPORT_PACK',
  'PACK_INCOMPATIBLE', 'ASSET_HASH_MISMATCH', 'SIGNATURE_INVALID', 'PACK_ACTIVATION_LOCKED',
  'PACK_VALIDATION_FAILED', 'TIMESTAMP_REGRESSION', 'DUPLICATE_FRAME', 'TIME_GAP',
  'WORKER_TIMEOUT', 'CAMERA_LOST', 'INVALID_TRANSITION', 'DEGRADED_INPUT',
  'AMBIGUOUS_SUBJECT', 'CROSS_SPORT_ACCESS', 'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const VALIDATION_STATUSES = ['approved', 'provisional', 'disabled'] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const PLATFORMS = ['web', 'android', 'ios', 'desktop'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const CAPABILITIES = [
  // Equipment capabilities are generic adapter classes; packs map their own equipment ids onto them.
  'body_pose', 'hands', 'optional_implement', 'optional_projectile', 'optional_target_system',
  'optional_sensor', 'calibrated_scale', 'multi_view',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'safety'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SESSION_STATES = [
  'IDLE', 'PERMISSIONS', 'CALIBRATING', 'READY', 'ACTIVE', 'PAUSED', 'DEGRADED',
  'COMPLETING', 'LOCAL_COMMITTED', 'SYNC_PENDING', 'SYNCED', 'FAILED',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const RECOGNITION_STATES = ['IDLE', 'CANDIDATE', 'CONFIRMED', 'EXECUTING', 'COMPLETE', 'ABORTED', 'UNKNOWN'] as const;
export type RecognitionState = (typeof RECOGNITION_STATES)[number];

export const CRITERION_STATES = ['PASS', 'IMPROVE', 'UNCERTAIN', 'NOT_ASSESSABLE', 'NOT_APPLICABLE'] as const;
export type CriterionState = (typeof CRITERION_STATES)[number];

export const CONTACT_EVIDENCE = ['none', 'unobserved', 'estimated_contact', 'sensed_contact'] as const;
export type ContactEvidence = (typeof CONTACT_EVIDENCE)[number];

export const FEEDBACK_KINDS = ['setup_instruction', 'quality_instruction', 'technique_cue', 'positive_reinforcement', 'phase_marker', 'none'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_PRIORITIES = ['safety', 'setup', 'primary', 'secondary'] as const;
export type FeedbackPriority = (typeof FEEDBACK_PRIORITIES)[number];

export const EVENT_TYPES = [
  'session.transition', 'pose.quality', 'movement.event', 'assessment.set',
  'feedback.action', 'telemetry.sample', 'error', 'pack.activation', 'calibration',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const FEATURE_KINDS = [
  'angle_at', 'line_inclination', 'segment_orientation', 'interjoint_distance_ratio',
  'center_of_keypoints', 'landmark_coordinate', 'landmark_offset', 'time_derivative',
  'angular_velocity', 'relative_phase_timing', 'stability_variability', 'path_smoothness',
  'window_min', 'window_max', 'window_mean', 'min_of', 'max_of',
] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

export type Orientation = 'landscape' | 'portrait' | 'landscape_flipped' | 'portrait_flipped' | 'unknown';
export type Handedness = 'left' | 'right' | 'unknown';
export type AthleteContext = 'novice' | 'intermediate' | 'advanced' | 'unknown';

/**
 * MediaPipe Pose Landmarker 33-point model. Index = landmark id.
 * Generic human body model; shared core may reference these by name.
 */
export const MEDIAPIPE_POSE_33 = [
  'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder', 'left_elbow',
  'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index',
  'left_thumb', 'right_thumb', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
  'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index',
] as const;
export type LandmarkName = (typeof MEDIAPIPE_POSE_33)[number];

export const LANDMARK_INDEX: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(MEDIAPIPE_POSE_33.map((n, i) => [n, i])),
);

/** Pairs of (left, right) landmark ids used when un-mirroring a frame. */
export const MIRROR_PAIRS: ReadonlyArray<readonly [number, number]> = Object.freeze(
  MEDIAPIPE_POSE_33.flatMap((name, idx) => {
    if (!name.startsWith('left_')) return [];
    const right = LANDMARK_INDEX[name.replace('left_', 'right_')];
    return right === undefined ? [] : [[idx, right] as const];
  }).concat([[LANDMARK_INDEX['mouth_left'], LANDMARK_INDEX['mouth_right']] as const]),
);

/** Core joints whose presence defines "full body framing". */
export const CORE_BODY_LANDMARKS: readonly LandmarkName[] = [
  'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];
