import { assertValid, CONTRACT_VERSION, VIEW_LABELS, type ContactMeasurementEvidence, type EquipmentMeasurement, type EquipmentMeasurementFrame, type ModelProvenance, type PoseFrame, type TrackSet, type ViewLabel } from '@apexformz/contracts';
import { validateEquipmentFrame } from './equipment';

export type Point2 = [number, number];
export interface EquipmentCameraContext {
  session_id: string;
  camera_id: string;
  view: ViewLabel;
  image_size: [number, number];
  mirror: boolean;
  orientation: PoseFrame['orientation'];
}
export interface TrackMeasurementBinding {
  track_id: string;
  /** Explicit association, never an automatic nearest-player assignment. */
  subject_id: string;
  equipment_id: string;
  measurement_id: string;
  quantity: 'x_image' | 'y_image' | 'height_above_hip_torso';
  min_pose_confidence?: number;
}

function frameContext(pose: PoseFrame, context: EquipmentCameraContext): void {
  if (context.session_id !== pose.session_id || context.camera_id !== pose.camera_id || context.view === 'unknown' || context.orientation === 'unknown' || context.orientation !== pose.orientation || context.mirror !== pose.mirror || context.image_size.some((v, i) => v !== pose.image_size[i])) throw new Error('equipment camera context does not match the decoded pose frame');
  if (!pose.tracked_subject_id) throw new Error('equipment requires an explicit tracked subject');
}
function measurementFrame(pose: PoseFrame, view: ViewLabel, retrospective: boolean, measurements: EquipmentMeasurement[]): EquipmentMeasurementFrame {
  const frame = { schema_version: CONTRACT_VERSION, session_id: pose.session_id, camera_id: pose.camera_id, tracked_subject_id: pose.tracked_subject_id!, view, frame_id: pose.frame_id, timestamp_ms: pose.timestamp_ms, image_size: pose.image_size, mirror: pose.mirror, orientation: pose.orientation, retrospective, measurements };
  validateEquipmentFrame(frame);
  return frame;
}

/** Connects existing CoTracker/TAPIR/SAM TrackSet outputs to the same runtime used by live sessions. */
export class TrackSetEquipmentAdapter {
  constructor(private readonly tracks: TrackSet, private readonly context: EquipmentCameraContext, private readonly bindings: TrackMeasurementBinding[]) {
    assertValid('trackSet', tracks, 'equipment TrackSet');
    if (tracks.session_id && tracks.session_id !== context.session_id) throw new Error('TrackSet session mismatch');
    if (tracks.image_size && tracks.image_size.some((v, i) => v !== context.image_size[i])) throw new Error('TrackSet image size mismatch');
    if (tracks.coordinate_system === 'image_pixel' && !tracks.image_size) throw new Error('pixel TrackSet requires image_size');
    if (new Set(tracks.tracks.map((t) => t.track_id)).size !== tracks.tracks.length) throw new Error('duplicate track IDs');
    if (new Set(bindings.map((b) => b.measurement_id)).size !== bindings.length) throw new Error('duplicate measurement bindings');
    for (const binding of bindings) {
      if (!binding.subject_id || !binding.measurement_id || !binding.equipment_id || !['x_image', 'y_image', 'height_above_hip_torso'].includes(binding.quantity)) throw new Error('invalid explicit track measurement binding');
      if (binding.min_pose_confidence !== undefined && (!Number.isFinite(binding.min_pose_confidence) || binding.min_pose_confidence < 0 || binding.min_pose_confidence > 1)) throw new Error('invalid minimum pose confidence');
      const track = tracks.tracks.find((t) => t.track_id === binding.track_id);
      if (!track) throw new Error(`unknown bound track ${binding.track_id}`);
      if (track.assigned_subject_id && track.assigned_subject_id !== binding.subject_id) throw new Error('binding contradicts track subject assignment');
      if (new Set(track.points.map((p) => p.frame_id)).size !== track.points.length) throw new Error('duplicate frame in equipment track');
    }
  }

  measure(pose: PoseFrame, contact?: ContactMeasurementEvidence): EquipmentMeasurementFrame {
    frameContext(pose, this.context);
    const measurements: EquipmentMeasurement[] = [];
    for (const binding of this.bindings) {
      if (binding.subject_id !== pose.tracked_subject_id) continue;
      const track = this.tracks.tracks.find((t) => t.track_id === binding.track_id)!;
      const point = track.points.find((p) => p.frame_id === pose.frame_id);
      // Missing timestamps/visibility are missing evidence; frame indices alone do not establish clock alignment.
      if (!point?.visible || point.timestamp_ms !== pose.timestamp_ms || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const x = point.x / (this.tracks.coordinate_system === 'image_pixel' ? this.context.image_size[0] : 1);
      const y = point.y / (this.tracks.coordinate_system === 'image_pixel' ? this.context.image_size[1] : 1);
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      let value = binding.quantity === 'x_image' ? x : y;
      let confidence = point.confidence ?? 0;
      if (binding.quantity === 'height_above_hip_torso') {
        const roots = [11, 12, 23, 24].map((id) => pose.normalized_landmarks.find((p) => p.id === id));
        const minConfidence = binding.min_pose_confidence ?? 0.5;
        if (roots.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.visibility ?? 0) < minConfidence)) continue;
        const [ls, rs, lh, rh] = roots.map((p) => p!);
        const hipY = (lh.y + rh.y) / 2;
        const torso = Math.hypot(((ls.x + rs.x - lh.x - rh.x) / 2) * pose.image_size[0] / pose.image_size[1], (ls.y + rs.y) / 2 - hipY);
        if (torso <= 1e-9) continue;
        value = (hipY - y) / torso;
        confidence = Math.min(confidence, ...roots.map((p) => p!.visibility ?? 0));
      }
      measurements.push({ measurement_id: binding.measurement_id, equipment_id: binding.equipment_id, quantity: binding.quantity, value, unit: 'normalized', confidence, source: this.tracks.source, validation_status: 'provisional', ...(contact ? { contact } : {}) });
    }
    return measurementFrame(pose, this.context.view, this.tracks.retrospective || contact?.kind === 'reviewed_annotation', measurements);
  }
}

export interface CourtCalibrationInput extends EquipmentCameraContext {
  calibration_id: string;
  source: ModelProvenance;
  valid_from_ms: number;
  valid_until_ms: number;
  confidence: number;
  /** Explicit geometry tolerance supplied by the calibration workflow, not a technique cutoff. */
  max_reprojection_error_m: number;
  correspondences: Array<{ image: Point2; court_m: Point2 }>;
}
export interface CourtCalibration extends CourtCalibrationInput {
  image_to_court: number[];
  reprojection_error_m: number;
}
function finitePoint(point: Point2): boolean { return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite); }
function solve(matrix: number[][], rhs: number[]): number[] {
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let i = 0; i < rhs.length; i++) {
    let pivot = i;
    for (let r = i + 1; r < rhs.length; r++) if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) pivot = r;
    if (Math.abs(a[pivot][i]) < 1e-10) throw new Error('degenerate court correspondences');
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const scale = a[i][i];
    for (let c = i; c <= rhs.length; c++) a[i][c] /= scale;
    for (let r = 0; r < rhs.length; r++) if (r !== i) {
      const factor = a[r][i];
      for (let c = i; c <= rhs.length; c++) a[r][c] -= factor * a[i][c];
    }
  }
  return a.map((row) => row[rhs.length]);
}
export function projectCourtPoint(calibration: CourtCalibration, image: Point2): Point2 {
  if (!finitePoint(image)) throw new Error('invalid image point');
  const h = calibration.image_to_court;
  const denominator = h[6] * image[0] + h[7] * image[1] + 1;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-10) throw new Error('point projects to the court horizon');
  const reference = calibration.correspondences[0]?.image;
  if (!reference || Math.sign(denominator) !== Math.sign(h[6] * reference[0] + h[7] * reference[1] + 1)) throw new Error('point crosses the calibrated court horizon');
  const result: Point2 = [(h[0] * image[0] + h[1] * image[1] + h[2]) / denominator, (h[3] * image[0] + h[4] * image[1] + h[5]) / denominator];
  if (!finitePoint(result)) throw new Error('nonfinite court projection');
  return result;
}

/** Fits a floor-plane homography only. It cannot recover an airborne object's height in metres. */
export function calibrateCourt(input: CourtCalibrationInput): CourtCalibration {
  if (!input.calibration_id || !input.source?.model_id || !input.source.version || !input.session_id || !input.camera_id || !VIEW_LABELS.includes(input.view) || input.view === 'unknown' || !['portrait', 'portrait_flipped', 'landscape', 'landscape_flipped'].includes(input.orientation) || typeof input.mirror !== 'boolean' || !Array.isArray(input.image_size) || input.image_size.length !== 2 || input.image_size.some((v) => !Number.isInteger(v) || v <= 0)) throw new Error('incomplete court camera/source context');
  if (![input.valid_from_ms, input.valid_until_ms, input.confidence, input.max_reprojection_error_m].every(Number.isFinite) || input.valid_from_ms < 0 || input.valid_until_ms < input.valid_from_ms || input.confidence < 0 || input.confidence > 1 || input.max_reprojection_error_m < 0) throw new Error('invalid court calibration validity/quality');
  if (!Array.isArray(input.correspondences) || input.correspondences.length < 4 || input.correspondences.some((p) => !finitePoint(p.image) || !finitePoint(p.court_m) || p.image.some((v) => v < 0 || v > 1))) throw new Error('four or more finite image/court correspondences required');
  const rows: number[][] = [];
  const targets: number[] = [];
  for (const { image: [u, v], court_m: [x, y] } of input.correspondences) {
    rows.push([u, v, 1, 0, 0, 0, -x * u, -x * v], [0, 0, 0, u, v, 1, -y * u, -y * v]);
    targets.push(x, y);
  }
  const normal = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => rows.reduce((sum, row) => sum + row[i] * row[j], 0)));
  const rhs = Array.from({ length: 8 }, (_, i) => rows.reduce((sum, row, k) => sum + row[i] * targets[k], 0));
  const calibration: CourtCalibration = { ...structuredClone(input), image_to_court: solve(normal, rhs), reprojection_error_m: 0 };
  const h = calibration.image_to_court;
  const determinant = h[0] * (h[4] - h[5] * h[7]) - h[1] * (h[3] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6]);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) throw new Error('degenerate court transform');
  const horizonSigns = input.correspondences.map(({ image: [u, v] }) => Math.sign(h[6] * u + h[7] * v + 1));
  if (horizonSigns.includes(0) || new Set(horizonSigns).size !== 1) throw new Error('court correspondences cross the projective horizon');
  calibration.reprojection_error_m = Math.max(...input.correspondences.map((p) => { const projected = projectCourtPoint(calibration, p.image); return Math.hypot(projected[0] - p.court_m[0], projected[1] - p.court_m[1]); }));
  if (calibration.reprojection_error_m > input.max_reprojection_error_m) throw new Error('court calibration exceeds declared reprojection error');
  return calibration;
}

export interface GroundFootprintObservation {
  subject_id: string;
  measurement_id: string;
  equipment_id: string;
  /** Observed footprint vertices, not an ankle keypoint assumed to be on the floor. */
  footprint_image: Point2[];
  region_court_m: Point2[];
  ground_contact: ContactMeasurementEvidence;
  ball_contact?: ContactMeasurementEvidence;
  confidence: number;
  source: ModelProvenance;
}
function clearance(point: Point2, polygon: Point2[]): number {
  let inside = false;
  let distance = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    distance = Math.min(distance, Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy));
  }
  return distance === 0 ? 0 : inside ? distance : -distance;
}
function assertConvex(polygon: Point2[]): void {
  if (polygon.length < 3 || polygon.some((p) => !finitePoint(p))) throw new Error('finite polygon with at least three vertices required');
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], c = polygon[(i + 2) % polygon.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-10 || (sign && Math.sign(cross) !== sign)) throw new Error('nondegenerate convex polygon required');
    sign = Math.sign(cross);
    if (polygon.some((point, index) => index !== i && index !== (i + 1) % polygon.length && ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])) * sign <= 0)) throw new Error('polygon vertices must be in convex boundary order');
  }
}

export function courtFootprintMeasurements(calibration: CourtCalibration, pose: PoseFrame, observations: GroundFootprintObservation[]): EquipmentMeasurementFrame {
  frameContext(pose, calibration);
  if (pose.timestamp_ms < calibration.valid_from_ms || pose.timestamp_ms > calibration.valid_until_ms) throw new Error('court calibration is outside its declared validity interval');
  const measurements = observations.map((observation): EquipmentMeasurement => {
    if (observation.subject_id !== pose.tracked_subject_id) throw new Error('footprint subject does not match the tracked athlete');
    assertConvex(observation.footprint_image);
    assertConvex(observation.region_court_m);
    if (observation.footprint_image.some((p) => p.some((v) => v < 0 || v > 1))) throw new Error('footprint must use normalized image coordinates');
    const ground = observation.ground_contact;
    if (!ground || ground.event !== 'foot_ground' || !['sensor', 'reviewed_annotation'].includes(ground.kind) || !ground.source_id || !ground.version || ground.frame_id !== pose.frame_id || ground.timestamp_ms !== pose.timestamp_ms || !Number.isFinite(ground.confidence) || ground.confidence < 0 || ground.confidence > 1) throw new Error('frame-aligned independent ground-contact evidence required');
    return { measurement_id: observation.measurement_id, equipment_id: observation.equipment_id, quantity: 'footprint_signed_boundary_clearance_m',
      value: Math.min(...observation.footprint_image.map((p) => clearance(projectCourtPoint(calibration, p), observation.region_court_m))), unit: 'm',
      confidence: Math.min(calibration.confidence, observation.confidence, ground.confidence), source: observation.source, calibration_id: calibration.calibration_id,
      validation_status: 'provisional', ground_contact: ground, ...(observation.ball_contact ? { contact: observation.ball_contact } : {}) };
  });
  return measurementFrame(pose, calibration.view, observations.some((o) => o.ground_contact.kind === 'reviewed_annotation' || o.ball_contact?.kind === 'reviewed_annotation'), measurements);
}

/** Merge adapters only when every binding agrees; duplicate measurement IDs are rejected. */
export function mergeEquipmentFrames(...frames: EquipmentMeasurementFrame[]): EquipmentMeasurementFrame {
  if (!frames.length) throw new Error('no equipment frames to merge');
  const { measurements: _, retrospective: __, ...context } = frames[0];
  for (const frame of frames) {
    validateEquipmentFrame(frame);
    const keys = ['schema_version', 'session_id', 'camera_id', 'tracked_subject_id', 'view', 'frame_id', 'timestamp_ms', 'mirror', 'orientation'] as const;
    if (keys.some((key) => frame[key] !== context[key]) || frame.image_size.some((value, i) => value !== context.image_size[i])) throw new Error('cannot merge equipment frames with different bindings');
  }
  const merged = { ...context, retrospective: frames.some((f) => f.retrospective), measurements: frames.flatMap((f) => f.measurements) };
  validateEquipmentFrame(merged);
  return merged;
}
