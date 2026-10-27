import type { ModelProvenance } from '@apexformz/contracts';

/** Portable deployment metadata emitted beside an ONNX movement model. Class labels are capture labels. */
export interface MovementModelConfig {
  schema_version: '1.0.0';
  sport_id: string;
  model_task?: 'static_pose' | 'dynamic_movement';
  model: ModelProvenance & { digest: string };
  classes: string[];
  /** Human source names keyed by the exact class IDs; does not change class identity. */
  class_names?: Record<string, string>;
  /** False for research artifacts whose training identity policy cannot be reproduced safely live. */
  live_compatible?: boolean;
  input: {
    landmark_set: 'mediapipe_pose_33';
    window_frames: number;
    hz: number;
    max_hold_ms: number;
    min_visibility: number;
    /** Fraction of observed joints across the complete window, including masked frames. Default 0.6. */
    min_observed_fraction?: number;
    /**
     * Frame-level quality gate used in training. 'strict' (default, older models) drops a frame on any framing or
     * missing-joint flag; 'identity_only' drops it only when the subject's identity is unsafe, masking missing
     * joints per landmark. Inference must apply the same gate.
     */
    frame_gate?: 'strict' | 'identity_only';
    /** Only legacy strict/image models may omit this (tracker); geometric research artifacts never load live. */
    subject_continuity?: 'tracker' | 'tracker_root_v1' | 'geometric';
    /** Dominant hand of every training athlete, when known and uniform. Inference mirrors other-handed athletes into it. */
    canonical_handedness?: 'left' | 'right';
    /** body_relative_v1: 2D image landmarks (view-dependent). world_bodyframe_v1: 3D world landmarks in a camera-yaw-invariant body frame (needs a pose model that outputs world landmarks). */
    normalization: 'body_relative_v1' | 'world_bodyframe_v1';
    smoothing: 'none';
  };
  calibration: {
    temperature: number;
    margin: number;
    thresholds: Record<string, number>;
    status: 'provisional' | 'validated';
  };
  /** Optional, explicitly reviewed mapping. No fuzzy alias/name matching is performed. */
  movement_ids?: Record<string, string>;
}

export type MovementDetectionReason = 'UNKNOWN_CLASS' | 'BELOW_THRESHOLD' | 'AMBIGUOUS_TOP2'
  | 'INSUFFICIENT_HISTORY' | 'POSE_QUALITY' | 'SPORT_MISMATCH' | 'LANDMARK_SET_MISMATCH'
  | 'CALIBRATION_UNVALIDATED' | 'MODEL_UNAVAILABLE';

/** Recognition is a separate observation; it is never a technique score or a coaching authorization. */
export interface MovementDetection {
  schema_version: '1.0.0';
  session_id: string;
  frame_id: number;
  timestamp_ms: number;
  sport_id: string;
  model_task: 'static_pose' | 'dynamic_movement';
  capture_label: string | null;
  capture_name?: string | null;
  movement_id: string | null;
  selected_coaching_movement_id: string;
  unknown: boolean;
  reason: MovementDetectionReason | null;
  probability: number | null;
  probabilities: Record<string, number>;
  unknown_probability: number | null;
  observed_fraction: number;
  calibration_status: 'provisional' | 'validated';
  model: ModelProvenance;
  /**
   * Most specific taxonomy level the evidence supports (family -> group -> movement), when the sport pack
   * declares a taxonomy. `movement` means the fine decision was accepted; `group`/`family` mean only the broader
   * level cleared its gate; null means nothing did.
   */
  level?: 'movement' | 'group' | 'family' | null;
  group_id?: string | null;
  group_name?: string | null;
  group_probability?: number | null;
  family_id?: string | null;
  family_name?: string | null;
  family_probability?: number | null;
  /** Approximate model match inside a supported group/family. Never an accepted exact movement or a score. */
  closest_match?: {
    capture_label: string;
    capture_name: string;
    movement_id: string;
    probability: number;
  } | null;
}

/** Reject incompatible preprocessing, missing thresholds and untrusted artifact identities before loading. */
export function validateMovementModelConfig(value: unknown): MovementModelConfig {
  const c = value as MovementModelConfig;
  const fail = (message: string): never => { throw new Error(`invalid movement model config: ${message}`); };
  if (!c || c.schema_version !== '1.0.0' || typeof c.sport_id !== 'string' || !c.sport_id.trim()) fail('schema or sport');
  if (!c.model || typeof c.model.model_id !== 'string' || !c.model.model_id || typeof c.model.version !== 'string' || !c.model.version || !/^sha256:[a-f0-9]{64}$/i.test(c.model.digest)) fail('model identity / sha256 digest');
  if (!Array.isArray(c.classes) || c.classes.length < 2 || c.classes.length > 1000 || c.classes.some((x) => typeof x !== 'string' || !x.trim()) || new Set(c.classes).size !== c.classes.length || c.classes.at(-1) !== 'UNKNOWN') fail('unique classes ending in UNKNOWN required');
  const i = c.input;
  if (!i || i.landmark_set !== 'mediapipe_pose_33' || (i.normalization !== 'body_relative_v1' && i.normalization !== 'world_bodyframe_v1') || i.smoothing !== 'none') fail('unsupported input normalization');
  if (!Number.isInteger(i.window_frames) || i.window_frames < 1 || i.window_frames > 300 || !Number.isFinite(i.hz) || i.hz < 1 || i.hz > 60 || i.window_frames / i.hz > 30) fail('input window budget');
  if (c.model_task && !['static_pose', 'dynamic_movement'].includes(c.model_task)) fail('model task');
  if (c.model_task === 'static_pose' && i.window_frames !== 1) fail('static model requires a single observed frame');
  if (!Number.isFinite(i.max_hold_ms) || i.max_hold_ms <= 0 || i.max_hold_ms > 400 || !Number.isFinite(i.min_visibility) || i.min_visibility < 0 || i.min_visibility > 1) fail('input quality settings');
  if (i.min_observed_fraction !== undefined && (!Number.isFinite(i.min_observed_fraction) || i.min_observed_fraction < 0 || i.min_observed_fraction > 1)) fail('minimum observed fraction');
  if (i.frame_gate !== undefined && i.frame_gate !== 'strict' && i.frame_gate !== 'identity_only') fail('frame gate');
  if (c.live_compatible === false || i.subject_continuity === 'geometric') fail('subject continuity is research-only and incompatible with live recognition; retrain with tracker_root_v1');
  if (i.subject_continuity === undefined && (i.frame_gate === 'identity_only' || i.normalization === 'world_bodyframe_v1')) fail('explicit subject continuity required for this preprocessing; legacy geometric artifacts cannot be assumed live-compatible');
  if (i.subject_continuity !== undefined && i.subject_continuity !== 'tracker' && i.subject_continuity !== 'tracker_root_v1') fail('subject continuity');
  if (i.canonical_handedness !== undefined && i.canonical_handedness !== 'left' && i.canonical_handedness !== 'right') fail('canonical handedness');
  const cal = c.calibration;
  if (!cal || !['provisional', 'validated'].includes(cal.status) || !Number.isFinite(cal.temperature) || cal.temperature <= 0 || !Number.isFinite(cal.margin) || cal.margin < 0 || cal.margin > 1 || !cal.thresholds || typeof cal.thresholds !== 'object') fail('calibration');
  for (const label of c.classes.filter((x) => x !== 'UNKNOWN')) {
    const threshold = cal.thresholds[label];
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) fail(`threshold missing/out of range for ${label}`);
  }
  if (c.movement_ids) for (const [label, movement] of Object.entries(c.movement_ids)) {
    if (label === 'UNKNOWN' || !c.classes.includes(label) || typeof movement !== 'string' || !movement.startsWith(`${c.sport_id}.`)) fail('movement mapping');
  }
  if (c.class_names) for (const [label, name] of Object.entries(c.class_names)) {
    if (!c.classes.includes(label) || typeof name !== 'string' || !name.trim()) fail('class display names');
  }
  // Own an immutable snapshot so caller mutations cannot change class order during a session.
  return JSON.parse(JSON.stringify(c)) as MovementModelConfig;
}
