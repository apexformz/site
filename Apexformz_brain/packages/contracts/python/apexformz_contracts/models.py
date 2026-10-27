"""Pydantic v2 mirrors of packages/contracts/src/types.ts (snake_case wire format)."""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Tuple, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .enums import (
    Aggregate, AthleteContext, Capability, ConditionOp, ContactEvidence, CoordinateSystem, CriterionState,
    ErrorCode, EvaluatorKind, EventType, FeatureKind, FeedbackKind, FeedbackPriority, Handedness, LandmarkSet,
    MissingReason, Orientation, PhaseKind, Platform, RecognitionState, SessionState, Severity, Unit,
    ValidationStatus, ViewLabel,
)

ViewApplicability = Union[Literal["any"], List[ViewLabel]]


class Contract(BaseModel):
    """Base: unknown fields are allowed (schemas are additive unless additionalProperties=false)."""

    model_config = ConfigDict(extra="allow")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Envelope
# ---------------------------------------------------------------------------
class EventEnvelope(Contract):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    session_id: str = Field(min_length=1, max_length=128)
    event_id: str = Field(min_length=1, max_length=128)
    monotonic_ms: float = Field(ge=0)
    wall_clock_iso: Optional[str] = None
    sport_pack_id: str
    sport_pack_version: str
    producer: str = Field(min_length=1)
    event_type: EventType
    payload: Dict[str, Any]
    sequence: Optional[int] = Field(default=None, ge=0)


# ---------------------------------------------------------------------------
# Camera / pose
# ---------------------------------------------------------------------------
class FramePacket(Contract):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    session_id: str
    frame_id: int = Field(ge=0)
    timestamp_ms: float = Field(ge=0)
    camera_id: str
    image_size: Tuple[int, int]
    mirror: bool
    orientation: Orientation
    nominal_fps: Optional[float] = Field(default=None, ge=0)
    dropped_since_last: Optional[int] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _size_positive(self):
        if any(v < 1 for v in self.image_size):
            raise ValueError("image_size entries must be >= 1")
        return self


class PoseLandmark(Contract):
    id: int = Field(ge=0)
    x: float
    y: float
    z: Optional[float] = None
    visibility: Optional[float] = Field(default=None, ge=0, le=1)
    presence: Optional[float] = Field(default=None, ge=0, le=1)


class WorldLandmark(Contract):
    id: int = Field(ge=0)
    x: float
    y: float
    z: float
    confidence: Optional[float] = Field(default=None, ge=0, le=1)


class PoseQuality(Contract):
    framing_ok: bool
    ambiguous_people: bool
    missing_joints: List[int]
    motion_blur: Optional[float] = None
    person_count: Optional[int] = Field(default=None, ge=0)
    detection_confidence: Optional[float] = None
    track_changed: Optional[bool] = None
    identity_method: Optional[Literal["tracker", "face", "face_track", "clothing", "size", "none", "pinned", "reacquired", "appearance", "sam2"]] = None
    identity_score: Optional[float] = None


class ModelProvenance(Contract):
    model_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    delegate: Optional[str] = None
    digest: Optional[str] = None


class PoseFrame(Contract):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    session_id: str = Field(min_length=1, max_length=128)
    frame_id: int = Field(ge=0)
    timestamp_ms: float = Field(ge=0)
    camera_id: str = Field(min_length=1)
    image_size: Tuple[int, int]
    mirror: bool
    orientation: Orientation
    landmark_set: LandmarkSet
    normalized_landmarks: List[PoseLandmark]
    world_landmarks: Optional[List[WorldLandmark]] = None
    tracked_subject_id: Optional[str] = None
    quality: PoseQuality
    provenance: ModelProvenance

    @model_validator(mode="after")
    def _size_positive(self):
        if any(v < 1 for v in self.image_size):
            raise ValueError("image_size entries must be >= 1")
        return self


# ---------------------------------------------------------------------------
# Features
# ---------------------------------------------------------------------------
class FeatureSpec(Strict):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    kind: FeatureKind
    params: Dict[str, Any]
    version: str = Field(pattern=r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")
    coordinate_system: CoordinateSystem
    view_applicability: ViewApplicability
    description: Optional[str] = None
    unit: Optional[Unit] = None


class FeatureValue(Contract):
    spec_id: str
    name: str
    value: Optional[float]
    unit: Unit
    valid: bool
    reason: Optional[MissingReason] = None
    evidence_frame_ids: List[int]
    confidence: Optional[float]
    view_applicability: ViewApplicability
    coordinate_system: CoordinateSystem
    timestamp_ms: float = Field(ge=0)
    derived_from: Optional[List[str]] = None
    retrospective: Optional[bool] = None
    meta: Optional[Dict[str, Any]] = None

    @model_validator(mode="after")
    def _missingness(self):
        if not self.valid and self.reason is None:
            raise ValueError("invalid feature requires a typed reason")
        if self.value is None and self.valid:
            raise ValueError("null value cannot be valid")
        return self


# ---------------------------------------------------------------------------
# Temporal
# ---------------------------------------------------------------------------
class MovementEvent(Contract):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    session_id: str
    event_id: str
    execution_id: Optional[str] = None
    movement_id: Optional[str]
    phase_id: Optional[str]
    start_ms: float = Field(ge=0)
    end_ms: Optional[float] = None
    confidence: float = Field(ge=0, le=1)
    evidence_frames: List[int]
    state: RecognitionState
    model_version: str
    unknown_reason: Optional[str] = None
    contact_evidence: Optional[ContactEvidence] = None
    retrospective: bool
    sport_pack_id: str
    sport_pack_version: str


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------
class NullableMeasurement(Strict):
    value: Optional[float]
    unit: Unit
    reason: Optional[MissingReason] = None
    feature_id: Optional[str] = None
    coordinate_system: Optional[CoordinateSystem] = None

    @model_validator(mode="after")
    def _reason_required(self):
        if self.value is None and self.reason is None:
            raise ValueError("null measurement requires a typed reason")
        return self


class CriterionFeedback(Contract):
    error_id: str
    cue: str
    rationale: Optional[str] = None


class CriterionConfidence(Contract):
    movement: Optional[float]
    assessment: Optional[float]
    evidence_quality: Optional[float] = None


class CriterionEvidenceRef(Contract):
    frame_ids: List[int]
    view: ViewLabel
    feature_ids: Optional[List[str]] = None
    selected_feature_id: Optional[str] = None


class CriterionProvenance(Contract):
    sport_pack: str
    rubric: str
    validation_status: ValidationStatus
    evaluator: str
    provisional: Optional[bool] = None


class CriterionEvidence(Contract):
    criterion_id: str
    movement_id: str
    phase_id: Optional[str] = None
    state: CriterionState
    score: Optional[float] = Field(default=None, ge=0, le=1)
    measurement: NullableMeasurement
    confidence: CriterionConfidence
    evidence: CriterionEvidenceRef
    feedback: Optional[CriterionFeedback]
    provenance: CriterionProvenance
    severity: Optional[Severity] = None
    timestamp_ms: float = Field(ge=0)
    retrospective: Optional[bool] = None

    @model_validator(mode="after")
    def _abstention_has_no_verdict(self):
        if self.state in ("UNCERTAIN", "NOT_ASSESSABLE", "NOT_APPLICABLE"):
            if self.feedback is not None:
                raise ValueError(f"{self.state} criterion must not carry feedback")
            if self.score is not None:
                raise ValueError(f"{self.state} criterion must not carry a score")
        return self


class OmittedCriterion(Contract):
    criterion_id: str
    reason: str


class Coverage(Contract):
    evaluated: int = Field(ge=0)
    required: int = Field(ge=0)
    ratio: float = Field(ge=0, le=1)
    minimum: float = Field(ge=0, le=1)
    omitted: List[OmittedCriterion]


class AssessmentSet(Contract):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    session_id: str
    event_id: str
    execution_id: Optional[str] = None
    timestamp_ms: float = Field(ge=0)
    movement_id: str
    phase_id: Optional[str] = None
    criteria: List[CriterionEvidence]
    score: Optional[float] = Field(default=None, ge=0, le=1)
    coverage: Coverage
    method: str
    weights: Dict[str, float]
    uncertainty: Optional[float] = None
    rubric_version: str
    sport_pack_id: str
    sport_pack_version: str
    retrospective: bool


# ---------------------------------------------------------------------------
# Coaching
# ---------------------------------------------------------------------------
class FeedbackProvenance(Contract):
    feedback_catalog_version: str
    sport_pack: str
    review_status: Optional[Literal["approved", "draft"]] = None


class FeedbackAction(Contract):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    session_id: str
    event_id: str
    timestamp_ms: float = Field(ge=0)
    kind: FeedbackKind
    priority: FeedbackPriority
    error_id: Optional[str] = None
    criterion_id: Optional[str] = None
    movement_id: Optional[str] = None
    text: str
    rationale: Optional[str] = None
    modality: List[Literal["visual", "audio", "haptic"]]
    cooldown_ms: float = Field(ge=0)
    expires_ms: float = Field(ge=0)
    evidence_frame_ids: List[int]
    provenance: FeedbackProvenance
    suppressed_reason: Optional[str] = None
    queued_secondary: Optional[List[str]] = None


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------
class SessionTransition(Contract):
    from_: SessionState = Field(alias="from")
    to: SessionState
    monotonic_ms: float = Field(ge=0)
    reason: str
    error_code: Optional[ErrorCode] = None

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class Calibration(Contract):
    full_body_framing: bool
    camera_tilt_deg: Optional[float]
    nominal_view: ViewLabel
    handedness: Handedness
    handedness_assumed: Optional[bool] = None
    floor_orientation_available: Optional[bool] = None
    scale_known: bool
    scale_marker_m: Optional[float] = None
    athlete_context: Optional[AthleteContext] = None


class SessionStartRequest(Contract):
    session_id: str
    athlete_id: Optional[str] = None
    sport_pack_id: str
    sport_pack_version: str
    movement_id: str
    calibration: Calibration
    pinned_models: Optional[List[ModelProvenance]] = None


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------
class TelemetrySample(Contract):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    session_id: str
    monotonic_ms: float = Field(ge=0)
    stage_durations_ms: Dict[str, float]
    queue_age_ms: float = Field(ge=0)
    discarded_frames: int = Field(ge=0)
    dropped_inferences: int = Field(ge=0)
    timeouts: int = Field(ge=0)
    memory_mb: Optional[float] = None
    observed_fps: Optional[float] = None
    abstention_reasons: Dict[str, int]
    unknown_movement_rate: Optional[float] = None
    criteria_coverage: Optional[float] = None
    executed_packs: Optional[List[str]] = None
    thermal_state: Optional[str] = None


# ---------------------------------------------------------------------------
# Sport pack manifest and assets
# ---------------------------------------------------------------------------
class SportPackModelRef(Contract):
    role: Literal["movement_classifier", "phase_segmenter", "reference_set", "criterion_model", "equipment_detector"]
    path: str
    version: str
    format: Literal["onnx", "json", "tflite"]
    digest: Optional[str] = None
    required: Optional[bool] = None


class PackSignature(Contract):
    algorithm: Literal["none", "hmac-sha256", "ed25519"]
    key_id: Optional[str] = None
    value: Optional[str] = None
    signed_fields: Optional[List[str]] = None


class PackDisplay(Contract):
    name: str
    description: Optional[str] = None
    color: Optional[str] = None
    status: Optional[Literal["seed", "pilot", "validated", "legacy_migrated"]] = None


class PackDependency(Contract):
    id: str
    version: str


class SportPackManifest(Strict):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    version: str
    minimum_core_version: str
    supported_platforms: List[Platform] = Field(min_length=1)
    capabilities: List[Capability] = Field(min_length=1)
    dependencies: List[PackDependency]
    game_rules: str
    court_geometry: str
    equipment_catalog: str
    movements: str
    phase_graphs: str
    technique_rubrics: str
    feedback_templates: str
    provenance: str
    models: List[SportPackModelRef]
    asset_hashes: Dict[str, str]
    signature: PackSignature
    display: PackDisplay

    @model_validator(mode="after")
    def _hashes_hex(self):
        import re

        for p, h in self.asset_hashes.items():
            if not re.fullmatch(r"[a-f0-9]{64}", h):
                raise ValueError(f"asset hash for {p} is not sha256 hex")
        return self


class SourceRef(Contract):
    source: str
    ref: Optional[str] = None
    edition: Optional[str] = None
    effective_date: Optional[str] = None
    url: Optional[str] = None
    status: ValidationStatus


class Condition(Strict):
    feature: str
    op: ConditionOp
    value: Union[float, Tuple[float, float]]
    hold_ms: Optional[float] = Field(default=None, ge=0)
    validation_status: Optional[ValidationStatus] = None


class CoordinateFrame(Contract):
    id: str
    origin: str
    axes: str
    units: Literal["m"]


class NamedLandmark(Contract):
    id: str
    description: str
    value_m: Optional[float]
    applies_to: Optional[List[str]] = None
    validation_status: ValidationStatus
    note: Optional[str] = None


class CourtGeometry(Contract):
    schema_version: str
    sport_id: str
    coordinate_frame: CoordinateFrame
    formats: Optional[List[str]] = None
    named_landmarks: List[NamedLandmark]
    polygons: Optional[List[Dict[str, Any]]] = None
    validation_status: ValidationStatus
    provenance: SourceRef
    notes: Optional[List[str]] = None


class CompetitionRule(Contract):
    id: str
    kind: Literal["official", "coaching_heuristic", "training_modified", "safety"]
    text: str
    value: Any = None
    adjudicable_from_pose: Optional[bool] = None
    validation_status: ValidationStatus
    note: Optional[str] = None


class RuleSet(Contract):
    id: str
    authority: str
    source: Optional[SourceRef] = None
    edition: Optional[str] = None
    effective_date: Optional[str] = None
    discipline: str
    format: str
    locale: Optional[str] = None
    validation_status: ValidationStatus
    rules: List[CompetitionRule]


class CompetitionRules(Contract):
    schema_version: str
    sport_id: str
    rule_sets: List[RuleSet]


class EquipmentItem(Contract):
    id: str
    object_class: str
    description: str
    tracking: Literal["none", "optional_adapter", "offline_only"]
    adapter_capability: Optional[Capability] = None
    dimensions: Optional[Dict[str, Any]] = None
    validation_status: ValidationStatus
    note: Optional[str] = None


class EquipmentCatalog(Contract):
    schema_version: str
    sport_id: str
    items: List[EquipmentItem]


class MovementAlias(Contract):
    name: str
    locale: str
    status: Literal["approved", "proposed"]


class SimilarEdge(Contract):
    movement_id: str
    relation: str
    hard_negative: bool


class MovementDefinition(Contract):
    uuid: str = Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.-]*$")
    canonical_name: str
    aliases: List[MovementAlias]
    type: Literal["static", "dynamic"]
    permitted_views: List[ViewLabel] = Field(min_length=1)
    phase_graph_id: str
    required_capabilities: List[Capability]
    criteria: List[str]
    similar: List[SimilarEdge]
    review_status: Literal["approved", "coach_review_required", "proposed"]
    description: Optional[str] = None
    difficulty: Optional[Literal["beginner", "intermediate", "advanced"]] = None
    family_id: Optional[str] = None
    group_id: Optional[str] = None
    data_status: Optional[Literal["captured", "no_training_data", "no_capture_data"]] = None
    source: Optional[Dict[str, Any]] = None


class MovementTaxonomyGroup(Contract):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.-]*$")
    name: str = Field(min_length=1)
    members: List[str] = Field(min_length=1)
    evidence: Optional[Dict[str, Any]] = None


class MovementTaxonomyFamily(Contract):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.-]*$")
    name: str = Field(min_length=1)
    type: Literal["static", "dynamic"]
    description: Optional[str] = None
    groups: List[MovementTaxonomyGroup] = Field(min_length=1)
    evidence: Optional[Dict[str, Any]] = None


class MovementTaxonomy(Contract):
    version: str
    levels: List[Literal["family", "group", "movement"]] = Field(min_length=3, max_length=3)
    validation_status: ValidationStatus
    method: Optional[Dict[str, Any]] = None
    recognition: Optional[Dict[str, Any]] = None
    families: List[MovementTaxonomyFamily] = Field(min_length=1)


class MovementCatalog(Contract):
    schema_version: str
    sport_id: str
    movements: List[MovementDefinition]
    taxonomy: Optional[MovementTaxonomy] = None


class PhaseDefinition(Contract):
    id: str
    name: str
    kind: PhaseKind
    contact_evidence: ContactEvidence
    min_duration_ms: float = Field(ge=0)
    max_duration_ms: Optional[float] = None
    enter: List[Condition]
    hold_ms: Optional[float] = Field(default=None, ge=0)
    cue_allowed: Optional[bool] = None


class PhaseEdge(Contract):
    from_: str = Field(alias="from")
    to: str

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class PhaseGraph(Contract):
    id: str
    movement_id: str
    kind: Literal["static_hold", "dynamic_sequence"]
    window_ms: Optional[float] = Field(default=None, ge=100)
    abort_timeout_ms: Optional[float] = Field(default=None, ge=0)
    confirm_hold_ms: Optional[float] = Field(default=None, ge=0)
    phases: List[PhaseDefinition] = Field(min_length=1)
    edges: List[PhaseEdge]
    initial: str
    terminal: List[str]
    allow_skip: Optional[bool] = None
    validation_status: ValidationStatus
    note: Optional[str] = None


class PhaseGraphs(Contract):
    schema_version: str
    sport_id: str
    graphs: List[PhaseGraph]


class FeatureSelector(Contract):
    mode: Literal["min", "max", "first_valid", "key_min", "key_max"]
    candidates: List[str] = Field(min_length=1)
    keys: Optional[List[str]] = None


class Evaluator(Contract):
    kind: EvaluatorKind
    aggregate: Optional[Aggregate] = None
    range: Optional[Tuple[float, float]] = None
    limit: Optional[float] = None
    tolerance: Optional[float] = Field(default=None, ge=0)
    expected_order: Optional[List[str]] = None
    model_reference: Optional[str] = None
    min_confidence: Optional[float] = Field(default=None, ge=0, le=1)
    human_variance_relative: Optional[float] = Field(default=None, ge=0, le=0.5)
    params: Optional[Dict[str, Any]] = None


class CriterionDefinition(Contract):
    criterion_id: str
    movement_id: str
    phase_ids: Optional[List[str]]
    required_features: List[str]
    feature_selector: Optional[FeatureSelector] = None
    evaluator: Evaluator
    technique_variant: Optional[str] = None
    view_constraints: ViewApplicability
    missing_data_policy: Literal["not_assessable", "uncertain"]
    severity: Severity
    weight: float = Field(ge=0)
    expert_citation: SourceRef
    athlete_context: Union[Literal["any"], List[str]]
    requires_capabilities: List[Capability]
    validation_status: ValidationStatus
    validation_version: str
    error_id: str
    description: Optional[str] = None
    note: Optional[str] = None


class HumanVarianceConsistency(Contract):
    enabled: Optional[bool] = None
    window: Optional[int] = Field(default=None, ge=2)
    min_reps: Optional[int] = Field(default=None, ge=2)
    k_sd: Optional[float] = Field(default=None, ge=0)
    fail_fraction: Optional[float] = Field(default=None, ge=0, le=1)


class HumanVarianceProfile(Contract):
    relative: Optional[float] = Field(default=None, ge=0, le=0.5)
    measurement_floor: Optional[Dict[str, float]] = None
    context_scale: Optional[Dict[str, float]] = None
    consistency: Optional[HumanVarianceConsistency] = None
    validation_status: Optional[ValidationStatus] = None
    note: Optional[str] = None


class Aggregation(Contract):
    method: str
    minimum_coverage: float = Field(ge=0, le=1)
    human_variance: Optional[HumanVarianceProfile] = None


class TechniqueCriteria(Contract):
    schema_version: str
    sport_id: str
    rubric_version: str
    features: List[FeatureSpec]
    aggregation: Aggregation
    criteria: List[CriterionDefinition]


class FeedbackEntry(Contract):
    error_id: str
    cue: Dict[str, str]
    rationale: Dict[str, str]
    demonstration_ref: Optional[str] = None
    review_status: Literal["approved", "draft"]
    cooldown_ms: float = Field(ge=0)
    persistence_count: int = Field(ge=1)
    severity: Severity
    positive_cue: Optional[Dict[str, str]] = None

    @model_validator(mode="after")
    def _english_cue(self):
        if "en" not in self.cue:
            raise ValueError("cue requires an 'en' entry")
        return self


class FeedbackPolicy(Contract):
    global_min_interval_ms: Optional[float] = Field(default=None, ge=0)
    positive_reinforcement_interval_ms: Optional[float] = Field(default=None, ge=0)
    max_secondary_queue: Optional[int] = Field(default=None, ge=0)


class FeedbackTemplates(Contract):
    schema_version: str
    sport_id: str
    catalog_version: str
    default_locale: str
    entries: List[FeedbackEntry]
    generic: Dict[str, Dict[str, str]]
    policy: Optional[FeedbackPolicy] = None


class ProvenanceSource(Contract):
    id: str
    type: Literal["official_rules", "coach_review", "dataset", "literature", "legacy_data", "internal"]
    citation: str
    url: Optional[str] = None
    accessed: Optional[str] = None
    status: ValidationStatus


class ValidationSummary(Contract):
    approved: int = Field(ge=0)
    provisional: int = Field(ge=0)
    disabled: int = Field(ge=0)


class PackProvenance(Contract):
    schema_version: str
    pack_id: str
    version: str
    created_at: str
    authors: List[str]
    sources: List[ProvenanceSource]
    validation_summary: ValidationSummary
    open_items: List[str]

    @model_validator(mode="after")
    def _todo_prefix(self):
        for item in self.open_items:
            if not item.startswith("TODO_REQUIRES_VALIDATION"):
                raise ValueError("open_items must start with TODO_REQUIRES_VALIDATION")
        return self


class SportPackBundle(Contract):
    manifest: SportPackManifest
    court_geometry: CourtGeometry
    competition_rules: CompetitionRules
    equipment_catalog: EquipmentCatalog
    movement_catalog: MovementCatalog
    phase_graphs: PhaseGraphs
    technique_criteria: TechniqueCriteria
    feedback_templates: FeedbackTemplates
    provenance: PackProvenance
    models: Optional[Dict[str, Any]] = None


# Validator name -> pydantic model, mirroring the TS `validators` object.

class TrackPoint(Contract):
    frame_id: int = Field(ge=0)
    timestamp_ms: Optional[float] = None
    x: float
    y: float
    visible: bool
    confidence: Optional[float] = None
    bbox: Optional[List[float]] = None


class TrackQuery(Contract):
    frame_id: int
    x: float
    y: float


class Track(Contract):
    track_id: str
    label: Optional[str] = None
    assigned_subject_id: Optional[str] = None
    query: Optional[TrackQuery] = None
    points: List[TrackPoint]


class TrackSet(Contract):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    session_id: Optional[str] = None
    video_ref: Optional[str] = None
    source: ModelProvenance
    kind: Literal["point", "object", "pose"]
    coordinate_system: Literal["image_normalized", "image_pixel"]
    image_size: Optional[List[int]] = None
    frame_count: int = Field(ge=0)
    fps: Optional[float] = None
    tracks: List[Track]
    retrospective: bool
    notes: Optional[List[str]] = None


class ContactMeasurementEvidence(Strict):
    kind: Literal["sensor", "reviewed_annotation"]
    event: Literal["implement_projectile", "foot_ground"]
    source_id: str = Field(min_length=1)
    version: str = Field(min_length=1)
    frame_id: int = Field(ge=0)
    timestamp_ms: float = Field(ge=0, allow_inf_nan=False)
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)


class EquipmentMeasurement(Strict):
    measurement_id: str = Field(min_length=1)
    equipment_id: str = Field(min_length=1)
    quantity: str = Field(min_length=1)
    value: float = Field(allow_inf_nan=False)
    unit: Unit
    confidence: float = Field(ge=0, le=1, allow_inf_nan=False)
    source: ModelProvenance
    validation_status: ValidationStatus
    contact: Optional[ContactMeasurementEvidence] = None
    ground_contact: Optional[ContactMeasurementEvidence] = None
    calibration_id: Optional[str] = Field(default=None, min_length=1)


class EquipmentMeasurementFrame(Strict):
    schema_version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    session_id: str = Field(min_length=1)
    camera_id: str = Field(min_length=1)
    tracked_subject_id: str = Field(min_length=1)
    view: ViewLabel
    frame_id: int = Field(ge=0)
    timestamp_ms: float = Field(ge=0, allow_inf_nan=False)
    image_size: Tuple[int, int]
    mirror: bool
    orientation: Orientation
    retrospective: bool
    measurements: List[EquipmentMeasurement] = Field(max_length=256)

    @model_validator(mode="after")
    def _positive_image_size(self):
        if any(value < 1 for value in self.image_size):
            raise ValueError("image_size must be positive")
        return self


MODEL_BY_VALIDATOR = {
    "eventEnvelope": EventEnvelope,
    "framePacket": FramePacket,
    "poseFrame": PoseFrame,
    "featureSpec": FeatureSpec,
    "featureValue": FeatureValue,
    "movementEvent": MovementEvent,
    "criterionEvidence": CriterionEvidence,
    "assessmentSet": AssessmentSet,
    "feedbackAction": FeedbackAction,
    "sessionTransition": SessionTransition,
    "calibration": Calibration,
    "sessionStartRequest": SessionStartRequest,
    "telemetrySample": TelemetrySample,
    "trackSet": TrackSet,
    "equipmentMeasurementFrame": EquipmentMeasurementFrame,
    "sportPackManifest": SportPackManifest,
    "courtGeometry": CourtGeometry,
    "competitionRules": CompetitionRules,
    "equipmentCatalog": EquipmentCatalog,
    "movementCatalog": MovementCatalog,
    "phaseGraphs": PhaseGraphs,
    "techniqueCriteria": TechniqueCriteria,
    "feedbackTemplates": FeedbackTemplates,
    "packProvenance": PackProvenance,
}

__all__ = [n for n in dir() if n[:1].isupper() or n == "MODEL_BY_VALIDATOR"]
