import type { Orientation, Unit, ValidationStatus, ViewLabel } from './enums';
import type { ModelProvenance } from './types';

/** Contact is supplied by an independent sensor or reviewed annotation, never inferred from pose proximity. */
export interface ContactMeasurementEvidence {
  kind: 'sensor' | 'reviewed_annotation';
  event: 'implement_projectile' | 'foot_ground';
  source_id: string;
  version: string;
  frame_id: number;
  timestamp_ms: number;
  confidence: number;
}

export interface EquipmentMeasurement {
  measurement_id: string;
  equipment_id: string;
  quantity: string;
  value: number;
  unit: Unit;
  confidence: number;
  source: ModelProvenance;
  validation_status: ValidationStatus;
  contact?: ContactMeasurementEvidence;
  ground_contact?: ContactMeasurementEvidence;
  calibration_id?: string;
}

/** Coordinates and timestamps refer to exactly the same decoded frame as the associated PoseFrame. */
export interface EquipmentMeasurementFrame {
  schema_version: string;
  session_id: string;
  camera_id: string;
  tracked_subject_id: string;
  view: ViewLabel;
  frame_id: number;
  timestamp_ms: number;
  image_size: [number, number];
  mirror: boolean;
  orientation: Orientation;
  retrospective: boolean;
  measurements: EquipmentMeasurement[];
}
