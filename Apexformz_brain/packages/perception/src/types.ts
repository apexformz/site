import type { ModelProvenance, Orientation, PoseLandmark, WorldLandmark } from '@apexformz/contracts';

/** Structural shape of a MediaPipe Tasks `PoseLandmarkerResult` (no package dependency). */
export interface PoseLandmarkerLikeResult {
  landmarks: Array<Array<{ x: number; y: number; z: number; visibility?: number; presence?: number }>>;
  worldLandmarks?: Array<Array<{ x: number; y: number; z: number; visibility?: number }>>;
}

/** Legacy ApexFormz keypoint (pixel coordinates, named joints). */
export interface LegacyKeypoint {
  x: number;
  y: number;
  z?: number;
  score: number;
  name: string;
}

export interface FrameMeta {
  session_id: string;
  frame_id: number;
  timestamp_ms: number;
  camera_id: string;
  image_size: [number, number];
  mirror: boolean;
  orientation: Orientation;
  provenance: ModelProvenance;
}

export interface Candidate {
  normalized: PoseLandmark[];
  world?: WorldLandmark[];
  bbox: { x0: number; y0: number; x1: number; y1: number; area: number; cx: number; cy: number };
  confidence: number;
}

export interface SubjectSelection {
  index: number | null;
  track_id: string | null;
  ambiguous: boolean;
  track_changed: boolean;
  person_count: number;
  /** How the subject was identified (pinned tracking); absent for the plain size/track policy. */
  identity_method?: 'pinned' | 'reacquired' | 'appearance';
  identity_score?: number | null;
}

export interface EquipmentObservation {
  object_class: string;
  assigned_subject_id: string | null;
  coordinate_system: 'image_normalized' | 'image_pixel';
  frame_id: number;
  timestamp_ms: number;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  keypoints?: Array<{ id: number; x: number; y: number; confidence?: number }>;
  provenance: ModelProvenance;
}

/**
 * Optional per-sport equipment adapter loaded by manifest capability (TRD 02).
 * Independently versioned; failures degrade only equipment-dependent criteria.
 */
export interface EquipmentAdapter {
  readonly capability: string;
  readonly provenance: ModelProvenance;
  observe(frameId: number, timestampMs: number): EquipmentObservation[] | null;
}

export class NullEquipmentAdapter implements EquipmentAdapter {
  readonly capability = 'none';
  readonly provenance = { model_id: 'none', version: '0.0.0' };
  observe(): null {
    return null;
  }
}
