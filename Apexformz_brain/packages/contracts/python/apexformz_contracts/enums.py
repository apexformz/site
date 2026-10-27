"""Enumerations mirroring packages/contracts/src/enums.ts and common.schema.json $defs.

Nothing in this file may name a sport. Parity is enforced by tests/test_parity.py.
"""
from __future__ import annotations

from typing import Literal, get_args

COORDINATE_SYSTEMS = ("image_normalized", "image_pixel", "estimated_world", "calibrated_world", "body_relative")
CoordinateSystem = Literal["image_normalized", "image_pixel", "estimated_world", "calibrated_world", "body_relative"]

UNITS = (
    "deg", "rad", "deg_per_s", "rad_per_s", "deg_per_s2",
    "normalized", "normalized_per_s", "normalized_per_s2", "normalized_per_s3",
    "ratio", "ms", "s", "px", "m", "m_per_s", "count", "score", "probability", "none",
)
Unit = Literal[
    "deg", "rad", "deg_per_s", "rad_per_s", "deg_per_s2",
    "normalized", "normalized_per_s", "normalized_per_s2", "normalized_per_s3",
    "ratio", "ms", "s", "px", "m", "m_per_s", "count", "score", "probability", "none",
]

VIEW_LABELS = ("front", "back", "left", "right", "front_left", "front_right", "back_left", "back_right", "top", "unknown")
ViewLabel = Literal["front", "back", "left", "right", "front_left", "front_right", "back_left", "back_right", "top", "unknown"]

MISSING_REASONS = (
    "MISSING_JOINT", "LOW_CONFIDENCE", "DEGENERATE_GEOMETRY", "VIEW_INVALID", "TIME_GAP",
    "INSUFFICIENT_HISTORY", "AMBIGUOUS_SUBJECT", "FRAMING_INVALID", "SCALE_UNKNOWN",
    "EQUIPMENT_UNOBSERVED", "CONTACT_UNOBSERVED", "TRACK_CHANGED", "STALE_FRAME",
    "RUBRIC_UNVALIDATED", "RUBRIC_DISABLED", "MODEL_UNAVAILABLE", "NOT_APPLICABLE",
    "OUTLIER_REJECTED", "PREDICTED_SAMPLE", "NORMALIZATION_INVALID", "DEPENDENCY_INVALID",
    "UNKNOWN_FEATURE", "CAPABILITY_MISSING", "PHASE_NOT_ACTIVE", "MOVEMENT_NOT_CONFIRMED",
    "CONTRADICTORY_EVIDENCE", "COVERAGE_INSUFFICIENT", "HANDEDNESS_UNKNOWN", "WITHIN_NORMAL_VARIANCE",
)
MissingReason = Literal[
    "MISSING_JOINT", "LOW_CONFIDENCE", "DEGENERATE_GEOMETRY", "VIEW_INVALID", "TIME_GAP",
    "INSUFFICIENT_HISTORY", "AMBIGUOUS_SUBJECT", "FRAMING_INVALID", "SCALE_UNKNOWN",
    "EQUIPMENT_UNOBSERVED", "CONTACT_UNOBSERVED", "TRACK_CHANGED", "STALE_FRAME",
    "RUBRIC_UNVALIDATED", "RUBRIC_DISABLED", "MODEL_UNAVAILABLE", "NOT_APPLICABLE",
    "OUTLIER_REJECTED", "PREDICTED_SAMPLE", "NORMALIZATION_INVALID", "DEPENDENCY_INVALID",
    "UNKNOWN_FEATURE", "CAPABILITY_MISSING", "PHASE_NOT_ACTIVE", "MOVEMENT_NOT_CONFIRMED",
    "CONTRADICTORY_EVIDENCE", "COVERAGE_INSUFFICIENT", "HANDEDNESS_UNKNOWN", "WITHIN_NORMAL_VARIANCE",
]

ERROR_CODES = (
    "CONTRACT_VERSION_INCOMPATIBLE", "SCHEMA_INVALID", "UNKNOWN_MODEL_ID", "UNKNOWN_SPORT_PACK",
    "PACK_INCOMPATIBLE", "ASSET_HASH_MISMATCH", "SIGNATURE_INVALID", "PACK_ACTIVATION_LOCKED",
    "PACK_VALIDATION_FAILED", "TIMESTAMP_REGRESSION", "DUPLICATE_FRAME", "TIME_GAP",
    "WORKER_TIMEOUT", "CAMERA_LOST", "INVALID_TRANSITION", "DEGRADED_INPUT",
    "AMBIGUOUS_SUBJECT", "CROSS_SPORT_ACCESS", "INTERNAL",
)
ErrorCode = Literal[
    "CONTRACT_VERSION_INCOMPATIBLE", "SCHEMA_INVALID", "UNKNOWN_MODEL_ID", "UNKNOWN_SPORT_PACK",
    "PACK_INCOMPATIBLE", "ASSET_HASH_MISMATCH", "SIGNATURE_INVALID", "PACK_ACTIVATION_LOCKED",
    "PACK_VALIDATION_FAILED", "TIMESTAMP_REGRESSION", "DUPLICATE_FRAME", "TIME_GAP",
    "WORKER_TIMEOUT", "CAMERA_LOST", "INVALID_TRANSITION", "DEGRADED_INPUT",
    "AMBIGUOUS_SUBJECT", "CROSS_SPORT_ACCESS", "INTERNAL",
]

VALIDATION_STATUSES = ("approved", "provisional", "disabled")
ValidationStatus = Literal["approved", "provisional", "disabled"]

PLATFORMS = ("web", "android", "ios", "desktop")
Platform = Literal["web", "android", "ios", "desktop"]

CAPABILITIES = ("body_pose", "hands", "optional_implement", "optional_projectile", "optional_target_system", "optional_sensor", "calibrated_scale", "multi_view",)
Capability = Literal["body_pose", "hands", "optional_implement", "optional_projectile", "optional_target_system", "optional_sensor", "calibrated_scale", "multi_view"]

SEVERITIES = ("low", "medium", "high", "safety")
Severity = Literal["low", "medium", "high", "safety"]

SESSION_STATES = (
    "IDLE", "PERMISSIONS", "CALIBRATING", "READY", "ACTIVE", "PAUSED", "DEGRADED",
    "COMPLETING", "LOCAL_COMMITTED", "SYNC_PENDING", "SYNCED", "FAILED",
)
SessionState = Literal[
    "IDLE", "PERMISSIONS", "CALIBRATING", "READY", "ACTIVE", "PAUSED", "DEGRADED",
    "COMPLETING", "LOCAL_COMMITTED", "SYNC_PENDING", "SYNCED", "FAILED",
]

RECOGNITION_STATES = ("IDLE", "CANDIDATE", "CONFIRMED", "EXECUTING", "COMPLETE", "ABORTED", "UNKNOWN")
RecognitionState = Literal["IDLE", "CANDIDATE", "CONFIRMED", "EXECUTING", "COMPLETE", "ABORTED", "UNKNOWN"]

CRITERION_STATES = ("PASS", "IMPROVE", "UNCERTAIN", "NOT_ASSESSABLE", "NOT_APPLICABLE")
CriterionState = Literal["PASS", "IMPROVE", "UNCERTAIN", "NOT_ASSESSABLE", "NOT_APPLICABLE"]

CONTACT_EVIDENCE = ("none", "unobserved", "estimated_contact", "sensed_contact")
ContactEvidence = Literal["none", "unobserved", "estimated_contact", "sensed_contact"]

FEEDBACK_KINDS = ("setup_instruction", "quality_instruction", "technique_cue", "positive_reinforcement", "phase_marker", "none")
FeedbackKind = Literal["setup_instruction", "quality_instruction", "technique_cue", "positive_reinforcement", "phase_marker", "none"]

FEEDBACK_PRIORITIES = ("safety", "setup", "primary", "secondary")
FeedbackPriority = Literal["safety", "setup", "primary", "secondary"]

EVENT_TYPES = (
    "session.transition", "pose.quality", "movement.event", "assessment.set",
    "feedback.action", "telemetry.sample", "error", "pack.activation", "calibration",
)
EventType = Literal[
    "session.transition", "pose.quality", "movement.event", "assessment.set",
    "feedback.action", "telemetry.sample", "error", "pack.activation", "calibration",
]

FEATURE_KINDS = (
    "angle_at", "line_inclination", "segment_orientation", "interjoint_distance_ratio",
    "center_of_keypoints", "landmark_coordinate", "landmark_offset", "time_derivative",
    "angular_velocity", "relative_phase_timing", "stability_variability", "path_smoothness",
    "window_min", "window_max", "window_mean", "min_of", "max_of",
)
FeatureKind = Literal[
    "angle_at", "line_inclination", "segment_orientation", "interjoint_distance_ratio",
    "center_of_keypoints", "landmark_coordinate", "landmark_offset", "time_derivative",
    "angular_velocity", "relative_phase_timing", "stability_variability", "path_smoothness",
    "window_min", "window_max", "window_mean", "min_of", "max_of",
]

Orientation = Literal["landscape", "portrait", "landscape_flipped", "portrait_flipped", "unknown"]
Handedness = Literal["left", "right", "unknown"]
AthleteContext = Literal["novice", "intermediate", "advanced", "unknown"]
LandmarkSet = Literal["mediapipe_pose_33", "coco_17", "halpe_26", "coco_wholebody_133", "custom"]
EvaluatorKind = Literal["range", "max_abs", "min_value", "max_value", "phase_duration", "ordering", "reference_nearest", "dynamic_reference", "stability", "equipment_dependent"]
Aggregate = Literal["latest", "window_mean", "window_min", "window_max", "phase_mean", "phase_min", "phase_max", "phase_end"]
PhaseKind = Literal["rest", "preparation", "loading", "action", "contact", "follow_through", "recovery", "hold"]
ConditionOp = Literal["lt", "gt", "lte", "gte", "between", "abs_gt", "abs_lt"]

MEDIAPIPE_POSE_33 = (
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye", "right_eye_outer",
    "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder", "right_shoulder", "left_elbow",
    "right_elbow", "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index", "right_index",
    "left_thumb", "right_thumb", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
    "left_heel", "right_heel", "left_foot_index", "right_foot_index",
)
LANDMARK_INDEX = {name: i for i, name in enumerate(MEDIAPIPE_POSE_33)}

MIRROR_PAIRS = tuple(
    (LANDMARK_INDEX[n], LANDMARK_INDEX[n.replace("left_", "right_")])
    for n in MEDIAPIPE_POSE_33 if n.startswith("left_")
) + ((LANDMARK_INDEX["mouth_left"], LANDMARK_INDEX["mouth_right"]),)

CORE_BODY_LANDMARKS = ("left_shoulder", "right_shoulder", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle")

ENUM_SETS = {
    "coordinate_system": set(COORDINATE_SYSTEMS),
    "unit": set(UNITS),
    "view_label": set(VIEW_LABELS),
    "missing_reason": set(MISSING_REASONS),
    "error_code": set(ERROR_CODES),
    "validation_status": set(VALIDATION_STATUSES),
    "platform": set(PLATFORMS),
    "capability": set(CAPABILITIES),
    "severity": set(SEVERITIES),
}


def literal_values(lit) -> set:
    return set(get_args(lit))


__all__ = [n for n in dir() if not n.startswith("_")]
