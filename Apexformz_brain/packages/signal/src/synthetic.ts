/**
 * Synthetic landmark fixtures for deterministic tests (TRD 00: unit tests use
 * synthetic geometric fixtures). Not for production use.
 *
 * Skeleton is authored in a "body plane" with units of metres, origin at hip
 * midpoint, +x to the athlete's image-right, +y down. It is projected into an
 * image of the requested size at a chosen scale so image_normalized coordinates
 * stay inside [0,1].
 */
import { CONTRACT_VERSION, LANDMARK_INDEX, MEDIAPIPE_POSE_33, type PoseFrame, type PoseLandmark } from '@apexformz/contracts';

export interface SyntheticPoseOptions {
  /** Knee flexion in degrees (0 = straight) for each leg. */
  left_knee_flexion?: number;
  right_knee_flexion?: number;
  /** Elbow flexion in degrees (0 = straight arm hanging). */
  left_elbow_flexion?: number;
  right_elbow_flexion?: number;
  /** Shoulder abduction (arm raise) in degrees: 0 = arm down, 90 = horizontal. */
  left_arm_raise?: number;
  right_arm_raise?: number;
  /** Trunk lean in degrees, positive = shoulders shift to +x (image right). */
  trunk_lean?: number;
  /** Stance width in metres between ankles. */
  stance_width?: number;
  /** Horizontal shift of the whole body in image fraction. */
  offset_x?: number;
  offset_y?: number;
  /** Depth (z) for all landmarks. */
  z?: number;
  /** Visibility assigned to all landmarks unless overridden. */
  visibility?: number;
  /** Per-landmark visibility overrides by name. */
  visibility_overrides?: Partial<Record<string, number>>;
  /** Shift of knee x relative to ankle (metres) to simulate knee valgus; applies to the named side. */
  knee_offset_x?: { side: 'left' | 'right'; metres: number };
  /** Lift one foot (metres above the floor). */
  foot_lift?: { side: 'left' | 'right'; metres: number };
  image_size?: [number, number];
  /** Scale: metres to image-height fraction. */
  scale?: number;
}

const DEG = Math.PI / 180;

/** Returns body-plane points keyed by landmark name (metres). */
export function buildSkeleton(o: SyntheticPoseOptions = {}): Record<string, { x: number; y: number }> {
  const torso = 0.5; // hip mid -> shoulder mid
  const thigh = 0.45;
  const shank = 0.45;
  const upperArm = 0.3;
  const foreArm = 0.28;
  const hipHalf = 0.16;
  const shoulderHalf = 0.2;
  const stance = (o.stance_width ?? 0.32) / 2;
  const lean = (o.trunk_lean ?? 0) * DEG;

  const P: Record<string, { x: number; y: number }> = {};
  P.left_hip = { x: hipHalf, y: 0 };
  P.right_hip = { x: -hipHalf, y: 0 };
  const shoulderMid = { x: Math.sin(lean) * torso, y: -Math.cos(lean) * torso };
  P.left_shoulder = { x: shoulderMid.x + shoulderHalf, y: shoulderMid.y };
  P.right_shoulder = { x: shoulderMid.x - shoulderHalf, y: shoulderMid.y };
  const headY = shoulderMid.y - 0.22;
  P.nose = { x: shoulderMid.x, y: headY };
  for (const n of ['left_eye_inner', 'left_eye', 'left_eye_outer']) P[n] = { x: shoulderMid.x + 0.03, y: headY - 0.03 };
  for (const n of ['right_eye_inner', 'right_eye', 'right_eye_outer']) P[n] = { x: shoulderMid.x - 0.03, y: headY - 0.03 };
  P.left_ear = { x: shoulderMid.x + 0.08, y: headY - 0.02 };
  P.right_ear = { x: shoulderMid.x - 0.08, y: headY - 0.02 };
  P.mouth_left = { x: shoulderMid.x + 0.02, y: headY + 0.04 };
  P.mouth_right = { x: shoulderMid.x - 0.02, y: headY + 0.04 };

  const leg = (side: 'left' | 'right') => {
    const sign = side === 'left' ? 1 : -1;
    const hip = P[`${side}_hip`];
    const flex = (side === 'left' ? o.left_knee_flexion : o.right_knee_flexion) ?? 0;
    const lift = o.foot_lift?.side === side ? o.foot_lift.metres : 0;
    // Place ankle at stance position; knee flexes forward in the plane (toward +x for left? use sign so legs bend "outward" symmetrically).
    // Exact interior knee angle = 180 - flex. Thigh rotates forward (+x) by flex/2, shank back by flex/2.
    // A lateral stance offset is split equally between knee and ankle; because thigh == shank this keeps
    // the interior angle exact while placing the ankle at the requested stance width.
    const half = flex * DEG * 0.5;
    const thighDir = { x: Math.sin(half), y: Math.cos(half) };
    const shankDir = { x: -Math.sin(half), y: Math.cos(half) };
    const off = sign * stance - hip.x;
    const knee = { x: hip.x + thighDir.x * thigh + off / 2, y: hip.y + thighDir.y * thigh };
    const ankle = { x: knee.x + shankDir.x * shank + off / 2, y: knee.y + shankDir.y * shank - lift };
    if (o.knee_offset_x?.side === side) knee.x += o.knee_offset_x.metres;
    P[`${side}_knee`] = knee;
    P[`${side}_ankle`] = ankle;
    const ankleX = ankle.x;
    const ankleY = ankle.y;
    P[`${side}_heel`] = { x: ankleX - 0.04 * sign, y: ankleY + 0.04 };
    P[`${side}_foot_index`] = { x: ankleX + 0.1 * sign, y: ankleY + 0.05 };
  };
  leg('left');
  leg('right');

  const arm = (side: 'left' | 'right') => {
    const sign = side === 'left' ? 1 : -1;
    const sh = P[`${side}_shoulder`];
    const raise = ((side === 'left' ? o.left_arm_raise : o.right_arm_raise) ?? 0) * DEG;
    const flex = ((side === 'left' ? o.left_elbow_flexion : o.right_elbow_flexion) ?? 0) * DEG;
    // upper arm direction: hanging down rotated outward by raise
    const ux = Math.sin(raise) * sign;
    const uy = Math.cos(raise);
    const elbow = { x: sh.x + ux * upperArm, y: sh.y + uy * upperArm };
    // forearm continues the upper-arm direction rotated by flexion (toward the front: +x for both to keep in-plane)
    const ang = Math.atan2(uy, ux) - flex * sign;
    const wrist = { x: elbow.x + Math.cos(ang) * foreArm, y: elbow.y + Math.sin(ang) * foreArm };
    P[`${side}_elbow`] = elbow;
    P[`${side}_wrist`] = wrist;
    P[`${side}_pinky`] = { x: wrist.x + 0.05 * Math.cos(ang), y: wrist.y + 0.05 * Math.sin(ang) };
    P[`${side}_index`] = { x: wrist.x + 0.06 * Math.cos(ang), y: wrist.y + 0.06 * Math.sin(ang) };
    P[`${side}_thumb`] = { x: wrist.x + 0.04 * Math.cos(ang), y: wrist.y + 0.04 * Math.sin(ang) };
  };
  arm('left');
  arm('right');
  return P;
}

export function syntheticPoseFrame(
  frameId: number,
  timestampMs: number,
  o: SyntheticPoseOptions = {},
  meta: Partial<Pick<PoseFrame, 'session_id' | 'mirror' | 'tracked_subject_id' | 'quality' | 'camera_id'>> = {},
): PoseFrame {
  const [W, H] = o.image_size ?? [1280, 720];
  const scale = o.scale ?? 0.38; // metres -> fraction of image height
  const ox = 0.5 + (o.offset_x ?? 0);
  const oy = 0.42 + (o.offset_y ?? 0);
  const P = buildSkeleton(o);
  const vis = o.visibility ?? 0.95;
  const landmarks: PoseLandmark[] = MEDIAPIPE_POSE_33.map((name, id) => {
    const p = P[name] ?? { x: 0, y: 0 };
    const v = o.visibility_overrides?.[name] ?? vis;
    return {
      id,
      x: ox + (p.x * scale * H) / W,
      y: oy + p.y * scale,
      z: o.z ?? 0,
      visibility: v,
      presence: v,
    };
  });
  const missing = landmarks.filter((l) => (l.visibility ?? 1) < 0.5).map((l) => l.id);
  return {
    schema_version: CONTRACT_VERSION,
    session_id: meta.session_id ?? 'synthetic-session',
    frame_id: frameId,
    timestamp_ms: timestampMs,
    camera_id: meta.camera_id ?? 'synthetic-cam',
    image_size: [W, H],
    mirror: meta.mirror ?? false,
    orientation: 'landscape',
    landmark_set: 'mediapipe_pose_33',
    normalized_landmarks: landmarks,
    tracked_subject_id: meta.tracked_subject_id ?? 'subject-1',
    quality: meta.quality ?? { framing_ok: true, ambiguous_people: false, missing_joints: missing, person_count: 1, detection_confidence: 0.95 },
    provenance: { model_id: 'synthetic', version: '1.0.0' },
  };
}

/** Convenience: id for a landmark name. */
export const lm = (name: string): number => LANDMARK_INDEX[name];
