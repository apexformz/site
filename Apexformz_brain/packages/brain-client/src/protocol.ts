import type { Calibration, EquipmentMeasurementFrame, EventEnvelope, PoseFrame, SessionStartRequest, SessionState, SportPackManifest } from '@apexformz/contracts';
import type { BrainRuntimeConfig, BrainTick, SessionSummary } from '@apexformz/runtime';
import type { SportPackInput } from '@apexformz/sport-runtime';
import type { OnnxPoseOptions } from './onnx_pose_backend';
import type { MovementModelLoadOptions } from './movement_model_loader';
import type { MovementDetection } from '@apexformz/analysis';

/**
 * Main-thread <-> worker protocol. All messages are plain JSON-serialisable
 * objects (ImageBitmaps are transferred, never copied). The UI process only
 * renders and coordinates; all data-plane work happens in the worker (TRD 01).
 */
export interface PoseDetectorOptions {
  /** Which pose model runs in the worker: MediaPipe Pose Landmarker (default) or an ONNX model (RTMO / RTMPose family via onnxruntime-web). */
  backend?: 'mediapipe' | 'onnx';
  /** ONNX backend options (required when backend === 'onnx'). */
  onnx?: OnnxPoseOptions;
  /** Base URL for the tasks-vision WASM files (e.g. a CDN or /mediapipe/wasm). */
  wasm_base_url: string;
  /** URL of pose_landmarker.task. */
  model_asset_path: string;
  delegate?: 'GPU' | 'CPU';
  num_poses?: number;
  min_pose_detection_confidence?: number;
  min_tracking_confidence?: number;
  model_version_label?: string;
  /** Explicit normalized capture-space subject region; comparable people inside it still cause abstention. */
  subject_roi?: { x0: number; y0: number; x1: number; y1: number };
  /** Appearance re-identification for tap-to-pin (config JSON with the model URL and SHA-256); omit to disable. */
  reid_config_url?: string;
  /** onnxruntime-web WASM location for the re-id model. */
  reid_ort_wasm_base_url?: string;
}

export type MainToWorker =
  | { type: 'init'; id: number; config: Partial<BrainRuntimeConfig>; detector?: PoseDetectorOptions; /** Window time origin, so worker lifecycle times share the capture clock. */ host_time_origin_ms?: number; /** persist the outbox in IndexedDB (default true) */ persist_outbox?: boolean }
  | { type: 'install_packs'; id: number; packs: SportPackInput[] }
  | { type: 'load_movement_models'; id: number; models: MovementModelLoadOptions[] }
  | { type: 'calibrate'; id: number; calibration: Calibration }
  | { type: 'start'; id: number; request: SessionStartRequest }
  | { type: 'pause'; id: number }
  | { type: 'resume'; id: number }
  | { type: 'complete'; id: number }
  | { type: 'equipment_frame'; id: number; frame: EquipmentMeasurementFrame }
  | { type: 'pose_frame'; frame: PoseFrame; equipment?: EquipmentMeasurementFrame }
  | { type: 'image'; image_id: number; bitmap: ImageBitmap; frame_id: number; timestamp_ms: number; camera_id: string; mirror: boolean; orientation: PoseFrame['orientation']; session_id: string }
  | { type: 'pin_subject'; id: number; /** normalized raw-camera point (not mirrored); null unpins */ point: { x: number; y: number } | null }
  | { type: 'drain_outbox'; id: number; max?: number }
  | { type: 'recover_outbox'; id: number }
  | { type: 'ack_outbox'; event_ids: string[] }
  | { type: 'heartbeat'; now_ms: number }
  | { type: 'ack_feedback'; event_id: string }
  | { type: 'dispose' };

export type WorkerToMain =
  | { type: 'ready'; detector: boolean; core_version: string; pose_backend?: string | null }
  | { type: 'ok'; id: number; result?: unknown }
  | { type: 'error'; id?: number; code: string; message: string; recoverable: boolean }
  | { type: 'tick'; tick: BrainTick }
  | { type: 'movement_detection'; detection: MovementDetection }
  | { type: 'pose'; frame: PoseFrame; latency_ms: number }
  /** Releases exactly one transferred image, including images producing no pose. */
  | { type: 'image_done'; image_id: number; frame_id: number; session_id: string }
  | { type: 'state'; state: SessionState }
  | { type: 'outbox'; id: number; events: EventEnvelope[] }
  | { type: 'summary'; id: number; summary: SessionSummary };

export interface InstalledPackInfo {
  manifest: SportPackManifest;
}
