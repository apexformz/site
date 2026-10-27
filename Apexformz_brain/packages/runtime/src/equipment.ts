import { assertValid, BrainError, type EquipmentMeasurementFrame, type MissingReason, type PoseFrame, type ViewLabel } from '@apexformz/contracts';

export function validateEquipmentFrame(frame: EquipmentMeasurementFrame): void {
  assertValid('equipmentMeasurementFrame', frame, 'equipment measurement');
  const ids = new Set<string>();
  for (const measurement of frame.measurements) {
    if (ids.has(measurement.measurement_id)) throw new BrainError('SCHEMA_INVALID', 'duplicate equipment measurement_id', { recoverable: false });
    ids.add(measurement.measurement_id);
    if (measurement.quantity === 'footprint_signed_boundary_clearance_m' && (!measurement.ground_contact || !measurement.calibration_id || measurement.unit !== 'm')) {
      throw new BrainError('SCHEMA_INVALID', 'court footprint requires a calibration, metres and independent ground-contact evidence', { recoverable: false });
    }
    for (const [contact, event] of [[measurement.contact, 'implement_projectile'], [measurement.ground_contact, 'foot_ground']] as const) {
      if (contact && (contact.event !== event || contact.frame_id !== frame.frame_id || contact.timestamp_ms !== frame.timestamp_ms || (contact.kind === 'reviewed_annotation' && !frame.retrospective))) {
        throw new BrainError('SCHEMA_INVALID', 'contact evidence must match its event and frame; reviewed annotations must be retrospective', { recoverable: false });
      }
    }
  }
}

/** No temporal interpolation or nearest-camera/subject guessing is permitted for equipment evidence. */
export function equipmentFrameMismatch(frame: EquipmentMeasurementFrame, pose: PoseFrame, view: ViewLabel): MissingReason | null {
  if (frame.session_id !== pose.session_id || !pose.tracked_subject_id || frame.tracked_subject_id !== pose.tracked_subject_id) return 'AMBIGUOUS_SUBJECT';
  if (frame.camera_id !== pose.camera_id || frame.view !== view || view === 'unknown' || frame.orientation !== pose.orientation || pose.orientation === 'unknown' || frame.mirror !== pose.mirror || frame.image_size.some((v, i) => v !== pose.image_size[i])) return 'VIEW_INVALID';
  if (frame.frame_id !== pose.frame_id || frame.timestamp_ms !== pose.timestamp_ms) return 'STALE_FRAME';
  if (pose.quality.track_changed) return 'TRACK_CHANGED';
  return null;
}
