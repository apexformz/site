import { CONTRACT_VERSION, type Orientation, type PoseFrame } from '@apexformz/contracts';
import { fromPoseLandmarkerResult, PinnedSubjectTracker, SubjectTracker, type AppearanceRequest, type PinStatus, type PoseLandmarkerLikeResult } from '@apexformz/perception';
import type { PoseDetectorOptions } from './protocol';

/**
 * Thin bridge around MediaPipe Tasks Vision PoseLandmarker. Loaded dynamically
 * so the Brain packages never hard-depend on the browser runtime. Works on the
 * main thread (HTMLVideoElement) or in a worker (ImageBitmap).
 */
interface LandmarkerLike {
  detectForVideo(image: ImageBitmap | HTMLVideoElement | HTMLCanvasElement, timestampMs: number): PoseLandmarkerLikeResult;
  close(): void;
}

export class PoseDetectorBridge {
  private landmarker: LandmarkerLike | null = null;
  private tracker: PinnedSubjectTracker;
  private lastTs = -1;
  readonly options: PoseDetectorOptions;

  constructor(options: PoseDetectorOptions) {
    this.options = options;
    this.tracker = new PinnedSubjectTracker(new SubjectTracker({ subject_roi: options.subject_roi }));
  }

  async init(): Promise<void> {
    const mod = (await import('@mediapipe/tasks-vision')) as unknown as {
      FilesetResolver: { forVisionTasks(base: string): Promise<unknown> };
      PoseLandmarker: { createFromOptions(vision: unknown, options: Record<string, unknown>): Promise<LandmarkerLike> };
    };
    const vision = await mod.FilesetResolver.forVisionTasks(this.options.wasm_base_url);
    const create = (delegate: 'GPU' | 'CPU') => mod.PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: this.options.model_asset_path, delegate },
      runningMode: 'VIDEO',
      numPoses: this.options.num_poses ?? 2,
      minPoseDetectionConfidence: this.options.min_pose_detection_confidence ?? 0.5,
      minTrackingConfidence: this.options.min_tracking_confidence ?? 0.5,
      outputSegmentationMasks: false,
    });
    try {
      this.landmarker = await create(this.options.delegate ?? 'GPU');
    } catch {
      // WebGPU/WebGL unavailable: CPU fallback (TRD 13 capability-based platform support).
      this.landmarker = await create('CPU');
      this.options.delegate = 'CPU';
    }
  }

  get ready(): boolean {
    return this.landmarker !== null;
  }

  resetTracking(): void {
    this.tracker.reset();
  }

  /** Tap-to-pin: follow the person under a normalized raw-camera point; null unpins. */
  pin(point: { x: number; y: number } | null): PinStatus {
    return this.tracker.pin(point);
  }

  get pinStatus(): PinStatus {
    return this.tracker.status;
  }

  /** Person crops the pinned tracker wants embedded for the frame just detected (appearance re-identification). */
  appearanceRequest(): AppearanceRequest | null {
    return this.tracker.appearanceRequest();
  }

  provideAppearance(request: AppearanceRequest, embeddings: Float32Array[]): void {
    this.tracker.provideAppearance(request, embeddings);
  }

  /**
   * Run detection and convert to a PoseFrame. Timestamps must be monotonic;
   * a non-increasing timestamp is nudged by 1 ms because the landmarker
   * rejects equal timestamps, and the frame keeps its true capture time.
   */
  detect(image: ImageBitmap | HTMLVideoElement | HTMLCanvasElement, meta: { session_id: string; frame_id: number; timestamp_ms: number; camera_id: string; image_size: [number, number]; mirror: boolean; orientation: Orientation }): PoseFrame | null {
    if (!this.landmarker) return null;
    let ts = Math.round(meta.timestamp_ms);
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    const result = this.landmarker.detectForVideo(image, ts);
    return fromPoseLandmarkerResult(result, {
      ...meta,
      provenance: { model_id: 'mediapipe_pose_landmarker', version: this.options.model_version_label ?? 'tasks-vision', delegate: this.options.delegate ?? 'GPU' },
    }, { tracker: this.tracker });
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

export const POSE_FRAME_CONTRACT = CONTRACT_VERSION;
