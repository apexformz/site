import type { FeatureSpec } from './types';
import type { Handedness, Unit, ViewLabel } from './enums';
import { FEATURE_KINDS, UNITS } from './enums';

/** Recorded motion geometry, not an approved technique rubric or contact detector. */
export interface DynamicReferenceFeature {
  id: string;
  unit: Unit;
  /** Provisional engineering allowance in comparison units, never a fitted clinical cutoff. */
  tolerance: number;
  weight: number;
  body_joints: string[];
  /** Compare displacement from each sequence's first observation. */
  relative_to_start?: boolean;
  /** Divide displacement by this feature's absolute initial value (e.g. torso height). */
  scale_feature_id?: string;
}

export interface DynamicReferenceSample { t_ms: number; values: Array<number | null> }

export interface DynamicReferenceSequence {
  id: string;
  view: ViewLabel;
  handedness: Handedness;
  source_execution_id: string;
  source_pose_sha256: string;
  source_media_sha256: string;
  /** Rotation applied to immutable encoded source poses, without anatomical side relabelling. */
  recorded_source_transform?: { rotation_degrees: 0 | 180; anatomical_labels_preserved: true; review_evidence_sha256?: string };
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  samples: DynamicReferenceSample[];
  boundary_method: 'observed_motion';
  /** False if any capture discontinuity or quality rejection occurred. Never implies a reviewed repetition. */
  complete_capture: boolean;
}

export interface DynamicReferenceModel {
  kind: 'dynamic_reference';
  schema_version: '1.0.0';
  movement_id: string;
  validation_status: 'provisional';
  feature_specs: FeatureSpec[];
  features: DynamicReferenceFeature[];
  references: DynamicReferenceSequence[];
  unsupported_reasons: string[];
  provenance: {
    dataset_sha256: string;
    extraction_version: string;
    phase_labels_reviewed: false;
    tolerances_reviewed: false;
    orientation_review_sha256?: string;
    tolerance_method?: string;
    notes?: string[];
  };
}

const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const views = new Set(['front', 'back', 'left', 'right', 'front_left', 'front_right', 'back_left', 'back_right', 'top']);

/** Resource bounds and semantic checks before a pack-supplied series enters the real-time comparator. */
export function validateDynamicReferenceModel(value: unknown): asserts value is DynamicReferenceModel {
  const m = value as DynamicReferenceModel;
  const fail = (s: string): never => { throw new Error(`Invalid dynamic reference: ${s}`); };
  if (!m || m.kind !== 'dynamic_reference' || m.schema_version !== '1.0.0' || typeof m.movement_id !== 'string' || !m.movement_id || m.movement_id.length > 200 || m.validation_status !== 'provisional') fail('header');
  if (!Array.isArray(m.features) || !m.features.length || m.features.length > 64 || !Array.isArray(m.feature_specs) || m.feature_specs.length !== m.features.length) fail('features');
  const ids = new Set<string>();
  for (const f of m.features) {
    if (!f || typeof f.id !== 'string' || !f.id || f.id.length > 150 || ids.has(f.id) || !UNITS.includes(f.unit) || !finite(f.tolerance) || f.tolerance <= 0 || !finite(f.weight) || f.weight < 0 || f.weight > 20 || !Array.isArray(f.body_joints) || f.body_joints.length > 33 || f.body_joints.some(x => typeof x !== 'string' || x.length > 80)) fail('feature metadata');
    ids.add(f.id);
    const specs = m.feature_specs.filter(s => s?.id === f.id);
    if (specs.length !== 1 || !FEATURE_KINDS.includes(specs[0].kind) || !specs[0].params || typeof specs[0].params !== 'object' || typeof specs[0].version !== 'string' || !['body_relative', 'image_pixel', 'image_normalized'].includes(specs[0].coordinate_system)) fail('feature specification');
  }
  if (m.features.every(f => f.weight === 0)) fail('zero comparison weights');
  for (const f of m.features) if (f.scale_feature_id && (!f.relative_to_start || !ids.has(f.scale_feature_id) || f.scale_feature_id === f.id)) fail('scale feature');
  if (!Array.isArray(m.references) || m.references.length > 128) fail('reference count');
  const sequenceIds = new Set<string>();
  for (const r of m.references) {
    if (!r || typeof r.id !== 'string' || !r.id || sequenceIds.has(r.id) || !views.has(r.view) || !['left', 'right'].includes(r.handedness) || typeof r.source_execution_id !== 'string' || !hash(r.source_pose_sha256) || !hash(r.source_media_sha256) || r.boundary_method !== 'observed_motion' || typeof r.complete_capture !== 'boolean') fail('reference provenance');
    sequenceIds.add(r.id);
    if (r.recorded_source_transform && (![0, 180].includes(r.recorded_source_transform.rotation_degrees) || r.recorded_source_transform.anatomical_labels_preserved !== true || (r.recorded_source_transform.rotation_degrees === 180 && !hash(r.recorded_source_transform.review_evidence_sha256)))) fail('source orientation');
    if (!finite(r.start_ms) || r.start_ms < 0 || !finite(r.end_ms) || !finite(r.duration_ms) || r.duration_ms < 250 || r.duration_ms > 30000 || Math.abs(r.end_ms - r.start_ms - r.duration_ms) > 1) fail('reference timing');
    if (!Array.isArray(r.samples) || r.samples.length < 5 || r.samples.length > 180) fail('sample count');
    let previous = -1;
    for (const s of r.samples) {
      if (!s || !finite(s.t_ms) || s.t_ms < 0 || s.t_ms <= previous || s.t_ms > r.duration_ms + 1 || !Array.isArray(s.values) || s.values.length !== m.features.length || s.values.some(v => v !== null && (!finite(v) || Math.abs(v) > 1e7))) fail('sample');
      previous = s.t_ms;
    }
    if (r.samples[0].t_ms !== 0 || Math.abs(r.samples.at(-1)!.t_ms - r.duration_ms) > 1) fail('sample endpoints');
  }
  if (!Array.isArray(m.unsupported_reasons) || m.unsupported_reasons.length > 50 || m.unsupported_reasons.some(x => typeof x !== 'string' || x.length > 1000)) fail('support reasons');
  if (!m.provenance || !hash(m.provenance.dataset_sha256) || typeof m.provenance.extraction_version !== 'string' || m.provenance.phase_labels_reviewed !== false || m.provenance.tolerances_reviewed !== false) fail('model provenance');
  if (m.provenance.orientation_review_sha256 !== undefined && !hash(m.provenance.orientation_review_sha256)) fail('orientation review hash');
}
