import { LANDMARK_INDEX, MEDIAPIPE_POSE_33, type PoseLandmark } from '@apexformz/contracts';

/**
 * Keypoint-set adapters so any industry pose backend (COCO-17 models such as
 * RTMPose/RTMO/ViTPose/YOLO-pose, Halpe-26, COCO-WholeBody-133) can feed the
 * Brain, which reasons over the canonical 33-slot MediaPipe layout. Landmarks a
 * backend does not produce are marked missing (visibility 0), never invented.
 */
export const COCO_17 = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
] as const;

/** Halpe-26 = COCO-17 + head, neck, hip(centre), big toes, small toes, heels. */
export const HALPE_26 = [
  ...COCO_17, 'head', 'neck', 'hip', 'left_big_toe', 'right_big_toe', 'left_small_toe', 'right_small_toe', 'left_heel', 'right_heel',
] as const;

/** COCO-WholeBody-133: body 17, feet 6, face 68, left hand 21, right hand 21 (indices). */
export const WHOLEBODY_133 = {
  body: [0, 17],
  feet: [17, 23],
  face: [23, 91],
  left_hand: [91, 112],
  right_hand: [112, 133],
} as const;

const HALPE_TO_MP: Record<string, string> = {
  left_big_toe: 'left_foot_index', right_big_toe: 'right_foot_index', left_heel: 'left_heel', right_heel: 'right_heel',
};

/** Wholebody foot order (17..22): left big toe, left small toe, left heel, right big toe, right small toe, right heel. */
const WHOLEBODY_FEET_TO_MP = ['left_foot_index', null, 'left_heel', 'right_foot_index', null, 'right_heel'];

export type KeypointSetId = 'mediapipe_pose_33' | 'coco_17' | 'halpe_26' | 'coco_wholebody_133';

export interface GenericKeypoint {
  x: number;
  y: number;
  z?: number;
  score: number;
}

/**
 * Convert a backend keypoint array (normalized 0..1 image coordinates, in the
 * given set's canonical order) to 33 MediaPipe-slot landmarks. Returns the
 * landmarks and the ids that the backend cannot provide.
 */
export function toMediaPipe33(set: KeypointSetId, kps: GenericKeypoint[]): { landmarks: PoseLandmark[]; unsupported_ids: number[] } {
  const out: PoseLandmark[] = MEDIAPIPE_POSE_33.map((_, id) => ({ id, x: 0, y: 0, z: undefined, visibility: 0, presence: 0 }));
  const put = (name: string | null, kp: GenericKeypoint | undefined) => {
    if (!name || !kp) return;
    const id = LANDMARK_INDEX[name];
    if (id === undefined) return;
    out[id] = { id, x: kp.x, y: kp.y, z: kp.z, visibility: kp.score, presence: kp.score };
  };
  const supported = new Set<number>();
  const mark = (name: string | null) => {
    if (name && LANDMARK_INDEX[name] !== undefined) supported.add(LANDMARK_INDEX[name]);
  };
  switch (set) {
    case 'mediapipe_pose_33':
      kps.forEach((kp, i) => {
        put(MEDIAPIPE_POSE_33[i], kp);
        mark(MEDIAPIPE_POSE_33[i]);
      });
      break;
    case 'coco_17':
      COCO_17.forEach((n, i) => {
        put(n, kps[i]);
        mark(n);
      });
      break;
    case 'halpe_26':
      HALPE_26.forEach((n, i) => {
        const mp = HALPE_TO_MP[n] ?? n;
        put(mp, kps[i]);
        mark(mp);
      });
      break;
    case 'coco_wholebody_133':
      COCO_17.forEach((n, i) => {
        put(n, kps[i]);
        mark(n);
      });
      WHOLEBODY_FEET_TO_MP.forEach((n, i) => {
        put(n, kps[WHOLEBODY_133.feet[0] + i]);
        mark(n);
      });
      // Hand keypoint 0 = wrist, 4 = thumb tip, 8 = index tip, 20 = pinky tip.
      put('left_thumb', kps[WHOLEBODY_133.left_hand[0] + 4]);
      put('left_index', kps[WHOLEBODY_133.left_hand[0] + 8]);
      put('left_pinky', kps[WHOLEBODY_133.left_hand[0] + 20]);
      put('right_thumb', kps[WHOLEBODY_133.right_hand[0] + 4]);
      put('right_index', kps[WHOLEBODY_133.right_hand[0] + 8]);
      put('right_pinky', kps[WHOLEBODY_133.right_hand[0] + 20]);
      ['left_thumb', 'left_index', 'left_pinky', 'right_thumb', 'right_index', 'right_pinky'].forEach(mark);
      break;
  }
  const unsupported = MEDIAPIPE_POSE_33.map((_, id) => id).filter((id) => !supported.has(id));
  return { landmarks: out, unsupported_ids: unsupported };
}

/** Core joints are available in every supported set; features that need others abstain via MISSING_JOINT. */
export function setProvidesCoreBody(set: KeypointSetId): boolean {
  return set === 'mediapipe_pose_33' || set === 'coco_17' || set === 'halpe_26' || set === 'coco_wholebody_133';
}
