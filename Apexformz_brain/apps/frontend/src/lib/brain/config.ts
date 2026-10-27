import type { Calibration } from '@apexformz/contracts';
import type { BrainRuntimeConfig } from '@apexformz/runtime';
import { DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET, packTrustMode, validateTrustRegistry } from '@apexformz/sport-runtime';
import type { OnnxPoseOptions, PoseDetectorOptions } from '@apexformz/brain-client';
import runtimeAssets from './runtime-assets.generated.json';
import packTrust from './pack-trust.generated.json';

export const ORT_WASM_BASE_URL = runtimeAssets.onnxruntime.wasm_base_url;

export type CoachingMode = 'strict' | 'development';

/** Pose model that runs inside the Brain worker. */
export type PoseBackendChoice = 'mediapipe' | 'onnx_rtmo';

export const POSE_BACKENDS: Array<{ id: PoseBackendChoice; label: string; description: string }> = [
  {
    id: 'mediapipe',
    label: 'MediaPipe Pose Full (default)',
    description: '33 landmarks with estimated depth; WebGPU/WebGL with CPU fallback; Apache-2.0.',
  },
  {
    id: 'onnx_rtmo',
    label: 'RTMO ONNX (one-stage, COCO-17, WebGPU)',
    description: 'OpenMMLab RTMO-s via onnxruntime-web; multi-person in one pass; needs /models/rtmo-s_640.onnx; WASM fallback; Apache-2.0.',
  },
];

/** Setup choices carried from the setup page to the training page. */
export interface BrainSetup {
  movement_id: string;
  mode: CoachingMode;
  calibration: Calibration;
  pose_backend?: PoseBackendChoice;
}

export const BRAIN_SETUP_KEY = (sport: string) => `brain_setup_${sport}`;

export const DEFAULT_CALIBRATION: Calibration = {
  full_body_framing: true,
  camera_tilt_deg: null,
  nominal_view: 'front',
  handedness: 'right',
  handedness_assumed: false,
  floor_orientation_available: false,
  scale_known: false,
  scale_marker_m: null,
  athlete_context: 'unknown',
};

export function loadSetup(sport: string): BrainSetup | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(BRAIN_SETUP_KEY(sport));
    return raw ? (JSON.parse(raw) as BrainSetup) : null;
  } catch {
    return null;
  }
}

export function saveSetup(sport: string, setup: BrainSetup): void {
  try {
    localStorage.setItem(BRAIN_SETUP_KEY(sport), JSON.stringify(setup));
  } catch {
    // storage unavailable (private mode): the URL query still carries the movement id
  }
}

export function parsePoseBackend(v: string | null | undefined): PoseBackendChoice {
  return v === 'onnx_rtmo' ? 'onnx_rtmo' : 'mediapipe';
}

/** RTMO-s body7 640x640 exported by OpenMMLab (rtmlib model zoo). Fetch with `node scripts/fetch-onnx-models.mjs`. */
export const RTMO_ONNX_OPTIONS: OnnxPoseOptions = {
  model_url: '/models/rtmo-s_640.onnx',
  model_kind: 'rtmo',
  input_size: [640, 640],
  keypoint_set: 'coco_17',
  execution_providers: ['webgpu', 'wasm'],
  ort_wasm_base_url: ORT_WASM_BASE_URL,
  model_version_label: 'rtmo-s_8xb32-600e_body7-640x640',
};

/** Pose detector and matching installed WASM runtime are both served by this app. */
export const DETECTOR_OPTIONS: PoseDetectorOptions = {
  backend: 'mediapipe',
  wasm_base_url: runtimeAssets.mediapipe.wasm_base_url,
  model_asset_path: '/models/pose_landmarker_full.task',
  delegate: 'GPU',
  // 3 people: a pinned athlete must still be detected next to a coach and an opponent (tap-to-pin).
  num_poses: 3,
  // Appearance re-identification for tap-to-pin (crossings and re-finding). OSNet weights are development-only
  // until replaced or licensed (research-dataset training data; see docs/12). Set NEXT_PUBLIC_REID=off to disable.
  reid_config_url: process.env.NEXT_PUBLIC_REID === 'off' ? undefined : '/models/reid/reid.json',
  reid_ort_wasm_base_url: runtimeAssets.onnxruntime.wasm_base_url,
  min_pose_detection_confidence: 0.5,
  min_tracking_confidence: 0.5,
  model_version_label: `pose_landmarker_full/tasks-vision-${runtimeAssets.mediapipe.version}`,
};

/** Detector options for the chosen backend. The MediaPipe fields stay populated so the main-thread fallback can still use them. */
export function detectorOptions(backend: PoseBackendChoice): PoseDetectorOptions {
  if (backend === 'onnx_rtmo') return { ...DETECTOR_OPTIONS, backend: 'onnx', onnx: RTMO_ONNX_OPTIONS };
  return { ...DETECTOR_OPTIONS, backend: 'mediapipe' };
}

/**
 * Runtime configuration for a coaching mode.
 * strict      : provisional rubrics abstain (UNCERTAIN), unreviewed cues are never issued.
 * development : provisional rubrics evaluate, draft cues are shown and labelled PROVISIONAL.
 *
 * Trust policy is fixed by the generated build metadata, independently from coaching mode.
 * Production accepts only Ed25519 keys in that build's public registry.
 */
export function runtimeConfig(mode: CoachingMode): Partial<BrainRuntimeConfig> {
  const trustMode = packTrustMode(packTrust.mode);
  return {
    platform: 'web',
    guided_coaching: true,
    strict_rubrics: mode === 'strict',
    allow_draft_feedback: mode === 'development',
    capabilities_available: ['body_pose'],
    emit_landmarks: false,
    allow_unsigned_packs: false,
    pack_trust_mode: trustMode,
    pack_trust_registry: validateTrustRegistry(packTrust.registry),
    hmac_keys: trustMode === 'development' ? { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET } : undefined,
    producer: 'apexformz-frontend-worker',
  };
}

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
