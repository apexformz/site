/**
 * TypeScript mirrors of the JSON Schemas in ../schemas. Keep in sync; the
 * contracts test project validates fixtures against both the schema and
 * these types (via structural usage in the runtime).
 */
import type {
  AthleteContext, Capability, ContactEvidence, CoordinateSystem, CriterionState, ErrorCode, EventType,
  FeatureKind, FeedbackKind, FeedbackPriority, Handedness, MissingReason, Orientation, Platform,
  RecognitionState, SessionState, Severity, Unit, ValidationStatus, ViewApplicability, ViewLabel,
} from './enums';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------
export interface EventEnvelopeBase {
  schema_version: string;
  session_id: string;
  event_id: string;
  monotonic_ms: number;
  wall_clock_iso?: string;
  sport_pack_id: string;
  sport_pack_version: string;
  producer: string;
}

export interface EventEnvelope<T = Record<string, unknown>> extends EventEnvelopeBase {
  event_type: EventType;
  payload: T;
  sequence?: number;
}

// ---------------------------------------------------------------------------
// Camera / pose
// ---------------------------------------------------------------------------
export interface FramePacket {
  schema_version: string;
  session_id: string;
  frame_id: number;
  timestamp_ms: number;
  camera_id: string;
  image_size: [number, number];
  mirror: boolean;
  orientation: Orientation;
  nominal_fps?: number;
  dropped_since_last?: number;
}

export interface PoseLandmark {
  id: number;
  x: number;
  y: number;
  z?: number;
  visibility?: number;
  presence?: number;
}

export interface WorldLandmark {
  id: number;
  x: number;
  y: number;
  z: number;
  confidence?: number;
}

export interface PoseQuality {
  framing_ok: boolean;
  ambiguous_people: boolean;
  missing_joints: number[];
  motion_blur?: number | null;
  person_count?: number;
  detection_confidence?: number | null;
  track_changed?: boolean;
  /** How the athlete was identified (identity-resolved extraction); absent for tracker-only extraction. */
  identity_method?: 'tracker' | 'face' | 'face_track' | 'clothing' | 'size' | 'none' | 'pinned' | 'reacquired' | 'appearance' | 'sam2' | null;
  identity_score?: number | null;
}

export interface ModelProvenance {
  model_id: string;
  version: string;
  delegate?: string;
  digest?: string;
}

export interface PoseFrame {
  schema_version: string;
  session_id: string;
  frame_id: number;
  timestamp_ms: number;
  camera_id: string;
  image_size: [number, number];
  mirror: boolean;
  orientation: Orientation;
  landmark_set: 'mediapipe_pose_33' | 'coco_17' | 'halpe_26' | 'coco_wholebody_133' | 'custom';
  normalized_landmarks: PoseLandmark[];
  world_landmarks?: WorldLandmark[];
  tracked_subject_id?: string | null;
  quality: PoseQuality;
  provenance: ModelProvenance;
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------
export interface FeatureSpec {
  id: string;
  kind: FeatureKind;
  params: Record<string, unknown>;
  version: string;
  coordinate_system: CoordinateSystem;
  view_applicability: ViewApplicability;
  description?: string;
  unit?: Unit;
}

export interface FeatureValue {
  spec_id: string;
  name: string;
  value: number | null;
  unit: Unit;
  valid: boolean;
  reason?: MissingReason | null;
  evidence_frame_ids: number[];
  confidence: number | null;
  view_applicability: ViewApplicability;
  coordinate_system: CoordinateSystem;
  timestamp_ms: number;
  derived_from?: string[];
  retrospective?: boolean;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Temporal
// ---------------------------------------------------------------------------
export interface MovementEvent {
  schema_version: string;
  session_id: string;
  event_id: string;
  execution_id?: string | null;
  movement_id: string | null;
  phase_id: string | null;
  start_ms: number;
  end_ms?: number | null;
  confidence: number;
  evidence_frames: number[];
  state: RecognitionState;
  model_version: string;
  unknown_reason?: string | null;
  contact_evidence?: ContactEvidence;
  retrospective: boolean;
  sport_pack_id: string;
  sport_pack_version: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
export interface NullableMeasurement {
  value: number | null;
  unit: Unit;
  reason?: MissingReason | null;
  feature_id?: string;
  coordinate_system?: CoordinateSystem;
}

export interface CriterionFeedback {
  error_id: string;
  cue: string;
  rationale?: string;
}

export interface CriterionEvidence {
  criterion_id: string;
  movement_id: string;
  phase_id?: string | null;
  state: CriterionState;
  score: number | null;
  measurement: NullableMeasurement;
  confidence: { movement: number | null; assessment: number | null; evidence_quality?: number | null };
  evidence: { frame_ids: number[]; view: ViewLabel; feature_ids?: string[]; selected_feature_id?: string | null };
  feedback: CriterionFeedback | null;
  provenance: {
    sport_pack: string;
    rubric: string;
    validation_status: ValidationStatus;
    evaluator: string;
    provisional?: boolean;
  };
  severity?: Severity;
  timestamp_ms: number;
  retrospective?: boolean;
}

export interface Coverage {
  evaluated: number;
  required: number;
  ratio: number;
  minimum: number;
  omitted: Array<{ criterion_id: string; reason: string }>;
}

export interface AssessmentSet {
  schema_version: string;
  session_id: string;
  event_id: string;
  execution_id?: string | null;
  timestamp_ms: number;
  movement_id: string;
  phase_id?: string | null;
  criteria: CriterionEvidence[];
  score: number | null;
  coverage: Coverage;
  method: string;
  weights: Record<string, number>;
  uncertainty?: number | null;
  rubric_version: string;
  sport_pack_id: string;
  sport_pack_version: string;
  retrospective: boolean;
}

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------
export interface FeedbackAction {
  schema_version: string;
  session_id: string;
  event_id: string;
  timestamp_ms: number;
  kind: FeedbackKind;
  priority: FeedbackPriority;
  error_id?: string | null;
  criterion_id?: string | null;
  movement_id?: string | null;
  text: string;
  rationale?: string | null;
  modality: Array<'visual' | 'audio' | 'haptic'>;
  cooldown_ms: number;
  expires_ms: number;
  evidence_frame_ids: number[];
  provenance: { feedback_catalog_version: string; sport_pack: string; review_status?: 'approved' | 'draft' };
  suppressed_reason?: string | null;
  queued_secondary?: string[];
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
export interface SessionTransition {
  from: SessionState;
  to: SessionState;
  monotonic_ms: number;
  reason: string;
  error_code?: ErrorCode | null;
}

export interface Calibration {
  full_body_framing: boolean;
  camera_tilt_deg: number | null;
  nominal_view: ViewLabel;
  handedness: Handedness;
  handedness_assumed?: boolean;
  floor_orientation_available?: boolean;
  scale_known: boolean;
  scale_marker_m?: number | null;
  athlete_context?: AthleteContext;
}

export interface SessionStartRequest {
  session_id: string;
  athlete_id?: string;
  sport_pack_id: string;
  sport_pack_version: string;
  movement_id: string;
  calibration: Calibration;
  pinned_models?: ModelProvenance[];
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
export interface TelemetrySample {
  schema_version: string;
  session_id: string;
  monotonic_ms: number;
  stage_durations_ms: Record<string, number>;
  queue_age_ms: number;
  discarded_frames: number;
  dropped_inferences: number;
  timeouts: number;
  memory_mb?: number | null;
  observed_fps?: number | null;
  abstention_reasons: Record<string, number>;
  unknown_movement_rate?: number | null;
  criteria_coverage?: number | null;
  executed_packs?: string[];
  thermal_state?: string | null;
}

// ---------------------------------------------------------------------------
// Tracking (point / object / pose trackers)
// ---------------------------------------------------------------------------
export interface TrackPoint {
  frame_id: number;
  timestamp_ms?: number | null;
  x: number;
  y: number;
  visible: boolean;
  confidence?: number | null;
  bbox?: [number, number, number, number] | null;
}

export interface Track {
  track_id: string;
  label?: string | null;
  assigned_subject_id?: string | null;
  query?: { frame_id: number; x: number; y: number } | null;
  points: TrackPoint[];
}

export interface TrackSet {
  schema_version: string;
  session_id?: string | null;
  video_ref?: string | null;
  source: ModelProvenance;
  kind: 'point' | 'object' | 'pose';
  coordinate_system: 'image_normalized' | 'image_pixel';
  image_size?: [number, number];
  frame_count: number;
  fps?: number | null;
  tracks: Track[];
  retrospective: boolean;
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Sport pack manifest and assets
// ---------------------------------------------------------------------------
export interface SportPackModelRef {
  role: 'movement_classifier' | 'phase_segmenter' | 'reference_set' | 'criterion_model' | 'equipment_detector';
  path: string;
  version: string;
  format: 'onnx' | 'json' | 'tflite';
  digest?: string;
  required?: boolean;
}

export interface SportPackManifest {
  schema_version: string;
  id: string;
  version: string;
  minimum_core_version: string;
  supported_platforms: Platform[];
  capabilities: Capability[];
  dependencies: Array<{ id: string; version: string }>;
  game_rules: string;
  court_geometry: string;
  equipment_catalog: string;
  movements: string;
  phase_graphs: string;
  technique_rubrics: string;
  feedback_templates: string;
  provenance: string;
  models: SportPackModelRef[];
  asset_hashes: Record<string, string>;
  signature: { algorithm: 'none' | 'hmac-sha256' | 'ed25519'; key_id?: string; value?: string; signed_fields?: string[] };
  display: { name: string; description?: string; color?: string; status?: 'seed' | 'pilot' | 'validated' | 'legacy_migrated' };
}

export interface SourceRef {
  source: string;
  ref?: string;
  edition?: string;
  effective_date?: string;
  url?: string;
  status: ValidationStatus;
}

export interface Condition {
  feature: string;
  op: 'lt' | 'gt' | 'lte' | 'gte' | 'between' | 'abs_gt' | 'abs_lt';
  value: number | [number, number];
  hold_ms?: number;
  validation_status?: ValidationStatus;
}

export interface CourtGeometry {
  schema_version: string;
  sport_id: string;
  coordinate_frame: { id: string; origin: string; axes: string; units: 'm' };
  formats?: string[];
  named_landmarks: Array<{ id: string; description: string; value_m: number | null; applies_to?: string[]; validation_status: ValidationStatus; note?: string }>;
  polygons?: Array<Record<string, unknown>>;
  validation_status: ValidationStatus;
  provenance: SourceRef;
  notes?: string[];
}

export interface CompetitionRule {
  id: string;
  kind: 'official' | 'coaching_heuristic' | 'training_modified' | 'safety';
  text: string;
  value?: unknown;
  adjudicable_from_pose?: boolean;
  validation_status: ValidationStatus;
  note?: string;
}

export interface CompetitionRules {
  schema_version: string;
  sport_id: string;
  rule_sets: Array<{
    id: string;
    authority: string;
    source?: SourceRef;
    edition?: string | null;
    effective_date?: string | null;
    discipline: string;
    format: string;
    locale?: string;
    validation_status: ValidationStatus;
    rules: CompetitionRule[];
  }>;
}

export interface EquipmentCatalog {
  schema_version: string;
  sport_id: string;
  items: Array<{
    id: string;
    object_class: string;
    description: string;
    tracking: 'none' | 'optional_adapter' | 'offline_only';
    adapter_capability?: Capability | null;
    dimensions?: Record<string, unknown>;
    validation_status: ValidationStatus;
    note?: string;
  }>;
}

export interface MovementDefinition {
  uuid: string;
  id: string;
  canonical_name: string;
  aliases: Array<{ name: string; locale: string; status: 'approved' | 'proposed' }>;
  type: 'static' | 'dynamic';
  permitted_views: ViewLabel[];
  phase_graph_id: string;
  required_capabilities: Capability[];
  criteria: string[];
  similar: Array<{ movement_id: string; relation: string; hard_negative: boolean }>;
  review_status: 'approved' | 'coach_review_required' | 'proposed';
  description?: string;
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  /** Level-1 family in the pack taxonomy. */
  family_id?: string;
  /** Level-2 branch of near-identical movements inside the family. */
  group_id?: string;
  data_status?: 'captured' | 'no_training_data' | 'no_capture_data';
  source?: { catalog_id?: string; catalog_version?: string; category?: string; instruction?: string; captures?: number; views?: ViewLabel[] };
}

export interface MovementTaxonomyGroup {
  id: string;
  name: string;
  members: string[];
  evidence?: Record<string, unknown>;
}

export interface MovementTaxonomyFamily {
  id: string;
  name: string;
  type: 'static' | 'dynamic';
  description?: string | null;
  groups: MovementTaxonomyGroup[];
  evidence?: Record<string, unknown>;
}

/** Hierarchical movement taxonomy: family -> group -> movement (owned by the sport pack). */
export interface MovementTaxonomy {
  version: string;
  levels: ['family', 'group', 'movement'];
  validation_status: ValidationStatus;
  method?: Record<string, unknown>;
  /** Gates for reporting a group or family when the fine movement is not accepted. */
  recognition?: { group_threshold?: number; family_threshold?: number; margin?: number; validation_status?: ValidationStatus };
  families: MovementTaxonomyFamily[];
}

export interface MovementCatalog {
  schema_version: string;
  sport_id: string;
  movements: MovementDefinition[];
  taxonomy?: MovementTaxonomy;
}

export type PhaseKind = 'rest' | 'preparation' | 'loading' | 'action' | 'contact' | 'follow_through' | 'recovery' | 'hold';

export interface PhaseDefinition {
  id: string;
  name: string;
  kind: PhaseKind;
  contact_evidence: ContactEvidence;
  min_duration_ms: number;
  max_duration_ms?: number | null;
  enter: Condition[];
  hold_ms?: number;
  cue_allowed?: boolean;
}

export interface PhaseGraph {
  id: string;
  movement_id: string;
  kind: 'static_hold' | 'dynamic_sequence';
  window_ms?: number;
  abort_timeout_ms?: number;
  confirm_hold_ms?: number;
  phases: PhaseDefinition[];
  edges: Array<{ from: string; to: string }>;
  initial: string;
  terminal: string[];
  allow_skip?: boolean;
  validation_status: ValidationStatus;
  note?: string;
}

export interface PhaseGraphs {
  schema_version: string;
  sport_id: string;
  graphs: PhaseGraph[];
}

export type EvaluatorKind = 'range' | 'max_abs' | 'min_value' | 'max_value' | 'phase_duration' | 'ordering' | 'reference_nearest' | 'dynamic_reference' | 'stability' | 'equipment_dependent';
export type Aggregate = 'latest' | 'window_mean' | 'window_min' | 'window_max' | 'phase_mean' | 'phase_min' | 'phase_max' | 'phase_end';

export interface CriterionDefinition {
  criterion_id: string;
  movement_id: string;
  phase_ids: string[] | null;
  required_features: string[];
  feature_selector?: { mode: 'min' | 'max' | 'first_valid' | 'key_min' | 'key_max'; candidates: string[]; keys?: string[] };
  evaluator: {
    kind: EvaluatorKind;
    aggregate?: Aggregate;
    range?: [number, number] | null;
    limit?: number | null;
    tolerance?: number;
    expected_order?: string[];
    model_reference?: string | null;
    min_confidence?: number;
    /** Per-criterion relative allowance for natural human variability (0.05 = 5% of the reference magnitude). */
    human_variance_relative?: number;
    params?: Record<string, unknown>;
  };
  technique_variant?: string | null;
  view_constraints: ViewApplicability;
  missing_data_policy: 'not_assessable' | 'uncertain';
  severity: Severity;
  weight: number;
  expert_citation: SourceRef;
  athlete_context: 'any' | string[];
  requires_capabilities: Capability[];
  validation_status: ValidationStatus;
  validation_version: string;
  error_id: string;
  description?: string;
  note?: string;
}

export interface TechniqueCriteria {
  schema_version: string;
  sport_id: string;
  rubric_version: string;
  features: FeatureSpec[];
  aggregation: { method: string; minimum_coverage: number; human_variance?: HumanVarianceProfile };
  criteria: CriterionDefinition[];
}

/** Sport-specific human variance profile declared by a pack rubric (see packages/scoring/src/variance.ts). */
export interface HumanVarianceProfile {
  relative?: number;
  measurement_floor?: Partial<Record<Unit, number>>;
  context_scale?: Partial<Record<AthleteContext, number>>;
  consistency?: { enabled?: boolean; window?: number; min_reps?: number; k_sd?: number; fail_fraction?: number };
  validation_status?: ValidationStatus;
  note?: string;
}

export interface FeedbackEntry {
  error_id: string;
  cue: Record<string, string> & { en: string };
  rationale: Record<string, string>;
  demonstration_ref?: string | null;
  review_status: 'approved' | 'draft';
  cooldown_ms: number;
  persistence_count: number;
  severity: Severity;
  positive_cue?: Record<string, string>;
}

export interface FeedbackTemplates {
  schema_version: string;
  sport_id: string;
  catalog_version: string;
  default_locale: string;
  entries: FeedbackEntry[];
  generic: Record<string, Record<string, string>>;
  policy?: {
    global_min_interval_ms?: number;
    positive_reinforcement_interval_ms?: number;
    max_secondary_queue?: number;
  };
}

export interface PackProvenance {
  schema_version: string;
  pack_id: string;
  version: string;
  created_at: string;
  authors: string[];
  sources: Array<{ id: string; type: 'official_rules' | 'coach_review' | 'dataset' | 'literature' | 'legacy_data' | 'internal'; citation: string; url?: string; accessed?: string; status: ValidationStatus }>;
  validation_summary: { approved: number; provisional: number; disabled: number };
  open_items: string[];
}

/** Fully loaded, validated sport pack. */
export interface SportPackBundle {
  manifest: SportPackManifest;
  court_geometry: CourtGeometry;
  competition_rules: CompetitionRules;
  equipment_catalog: EquipmentCatalog;
  movement_catalog: MovementCatalog;
  phase_graphs: PhaseGraphs;
  technique_criteria: TechniqueCriteria;
  feedback_templates: FeedbackTemplates;
  provenance: PackProvenance;
  /** Optional model artifacts keyed by manifest model path (parsed JSON for json format). */
  models?: Record<string, unknown>;
}
