import { CONTRACT_VERSION, LANDMARK_INDEX, MEDIAPIPE_POSE_33, type PoseFrame, type PoseLandmark, type WorldLandmark } from '@apexformz/contracts';
import { checkFraming } from './framing';
import { SubjectTracker, candidateFromLandmarks } from './subject_tracker';
import type { FrameMeta, LegacyKeypoint, PoseLandmarkerLikeResult } from './types';
import type { SubjectSelector } from './byte_subject_tracker';
import { toMediaPipe33, type GenericKeypoint, type KeypointSetId } from './keypoint_sets';

export interface AdapterOptions {
  min_visibility?: number;
  /** Subject selection policy: SubjectTracker (centroid heuristic) or ByteSubjectTracker (Kalman/IoU). */
  tracker?: SubjectSelector;
}

function emptyFrame(meta: FrameMeta, personCount: number, trackId: string | null): PoseFrame {
  return {
    schema_version: CONTRACT_VERSION,
    session_id: meta.session_id,
    frame_id: meta.frame_id,
    timestamp_ms: meta.timestamp_ms,
    camera_id: meta.camera_id,
    image_size: meta.image_size,
    mirror: meta.mirror,
    orientation: meta.orientation,
    landmark_set: 'mediapipe_pose_33',
    normalized_landmarks: [],
    tracked_subject_id: trackId,
    quality: {
      framing_ok: false,
      ambiguous_people: false,
      missing_joints: MEDIAPIPE_POSE_33.map((_, i) => i),
      person_count: personCount,
      detection_confidence: 0,
      track_changed: false,
    },
    provenance: meta.provenance,
  };
}

/**
 * Build a PoseFrame from a MediaPipe Pose Landmarker result (structural type,
 * works with @mediapipe/tasks-vision without importing it here).
 */
export function fromPoseLandmarkerResult(result: PoseLandmarkerLikeResult, meta: FrameMeta, opts: AdapterOptions = {}): PoseFrame {
  const minVis = opts.min_visibility ?? 0.5;
  const tracker: SubjectSelector = opts.tracker ?? new SubjectTracker();
  const candidates = result.landmarks.map((lms, i) => {
    const normalized: PoseLandmark[] = lms.map((l, id) => ({ id, x: l.x, y: l.y, z: l.z, visibility: l.visibility, presence: l.presence }));
    const world: WorldLandmark[] | undefined = result.worldLandmarks?.[i]?.map((l, id) => ({ id, x: l.x, y: l.y, z: l.z, confidence: l.visibility }));
    return candidateFromLandmarks(normalized, world, minVis);
  });
  const sel = tracker.select(candidates);
  if (sel.index === null) {
    const frame = emptyFrame(meta, sel.person_count, sel.track_id);
    frame.quality.ambiguous_people = sel.ambiguous;
    frame.quality.track_changed = sel.track_changed;
    return frame;
  }
  const chosen = candidates[sel.index];
  const framing = checkFraming(chosen.normalized, minVis);
  return {
    schema_version: CONTRACT_VERSION,
    session_id: meta.session_id,
    frame_id: meta.frame_id,
    timestamp_ms: meta.timestamp_ms,
    camera_id: meta.camera_id,
    image_size: meta.image_size,
    mirror: meta.mirror,
    orientation: meta.orientation,
    landmark_set: 'mediapipe_pose_33',
    normalized_landmarks: chosen.normalized,
    world_landmarks: chosen.world,
    tracked_subject_id: sel.track_id,
    quality: {
      framing_ok: framing.framing_ok,
      ambiguous_people: sel.ambiguous,
      missing_joints: framing.missing_joints,
      person_count: sel.person_count,
      detection_confidence: chosen.confidence,
      track_changed: sel.track_changed,
      ...(sel.identity_method ? { identity_method: sel.identity_method, identity_score: sel.identity_score ?? null } : {}),
    },
    provenance: meta.provenance,
  };
}

/**
 * Adapter for the existing ApexFormz frontend hook output (pixel keypoints with
 * names, from MediaPipe Holistic). Lets the legacy capture path feed the Brain.
 */
export function fromLegacyKeypoints(keypoints: LegacyKeypoint[], meta: FrameMeta, opts: AdapterOptions = {}): PoseFrame {
  const [W, H] = meta.image_size;
  const normalized: PoseLandmark[] = MEDIAPIPE_POSE_33.map((name, id) => ({ id, x: 0, y: 0, z: 0, visibility: 0, presence: 0 }));
  for (const kp of keypoints) {
    const id = LANDMARK_INDEX[kp.name];
    if (id === undefined) continue;
    normalized[id] = {
      id,
      x: kp.x / W,
      y: kp.y / H,
      z: kp.z !== undefined ? kp.z / W : undefined,
      visibility: kp.score,
      presence: kp.score,
    };
  }
  return fromPoseLandmarkerResult({ landmarks: [normalized.map((l) => ({ x: l.x, y: l.y, z: l.z ?? 0, visibility: l.visibility, presence: l.presence }))] }, meta, opts);
}

/**
 * Build a PoseFrame from any keypoint-set backend output (one array per person,
 * normalized 0..1 coordinates in the set's canonical order). Landmarks the set
 * cannot provide are marked missing. Used by ONNX backends (RTMPose/RTMO/
 * ViTPose COCO-17, RTMW/DWPose 133) in the worker and by server-side extractors.
 */
export function fromKeypointSet(set: KeypointSetId, persons: GenericKeypoint[][], meta: FrameMeta, opts: AdapterOptions = {}): PoseFrame {
  const converted = persons.map((kps) => toMediaPipe33(set, kps));
  const frame = fromPoseLandmarkerResult(
    { landmarks: converted.map((c) => c.landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z ?? 0, visibility: l.visibility, presence: l.presence }))) },
    meta,
    opts,
  );
  frame.landmark_set = set;
  if (converted.length && frame.normalized_landmarks.length) {
    // Landmarks the backend never produces are not "missing joints" for framing purposes; keep framing based on core joints only.
    const unsupported = new Set(converted[0].unsupported_ids);
    frame.quality.missing_joints = frame.quality.missing_joints.filter((id) => !unsupported.has(id) || CORE_IDS.has(id));
  }
  return frame;
}

const CORE_IDS = new Set(['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'].map((n) => LANDMARK_INDEX[n]));
