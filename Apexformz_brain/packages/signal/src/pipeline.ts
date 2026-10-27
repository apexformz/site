import { BrainError, type PoseFrame } from '@apexformz/contracts';
import { canonicalizeMirror, normalizeBodyRelative, toFilteredImageLandmarks } from './coordinates';
import { LandmarkSmoother } from './one_euro';
import { OutlierGate } from './outlier_gate';
import { PoseWindow } from './pose_window';
import { TimeGuard } from './time_guard';
import { DEFAULT_SIGNAL_CONFIG, type FilteredPoseFrame, type SignalConfig } from './types';

export interface SignalResult {
  frame: FilteredPoseFrame | null;
  dropped: boolean;
  drop_reason?: 'TIMESTAMP_REGRESSION' | 'DUPLICATE_FRAME';
  time_gap: boolean;
  track_changed: boolean;
  error?: BrainError;
}

/**
 * RAW POSE -> COORDINATE VALIDATION -> MIRROR/ORIENTATION -> ROOT+SCALE NORMALIZATION
 * -> OUTLIER DETECTOR -> CAUSAL FILTER -> TIME WINDOW (TRD 03 data flow).
 */
export class SignalPipeline {
  readonly config: SignalConfig;
  readonly window: PoseWindow;
  private readonly guard: TimeGuard;
  private readonly smoother: LandmarkSmoother;
  private readonly gate: OutlierGate;
  private lastTrackId: string | null | undefined = undefined;
  private resets = 0;

  constructor(config: Partial<SignalConfig> = {}) {
    this.config = { ...DEFAULT_SIGNAL_CONFIG, ...config, one_euro: { ...DEFAULT_SIGNAL_CONFIG.one_euro, ...(config.one_euro ?? {}) } };
    this.window = new PoseWindow(this.config.window_ms);
    this.guard = new TimeGuard(this.config.max_gap_ms);
    this.smoother = new LandmarkSmoother(this.config.one_euro);
    this.gate = new OutlierGate(this.config.outlier_max_speed, this.config.allow_short_gap_prediction);
  }

  get stats() {
    return { ...this.guard.stats, ...this.gate.stats, resets: this.resets, window_size: this.window.size };
  }

  /** Reset temporal state (after suspend/resume, track change or time gap). History is dropped, not bridged. */
  reset(): void {
    this.resets++;
    this.window.clear();
    this.smoother.reset();
    this.gate.reset();
    this.guard.reset();
  }

  process(frame: PoseFrame): SignalResult {
    const tg = this.guard.check(frame.timestamp_ms, frame.frame_id);
    if (!tg.accepted) {
      const code = tg.duplicate ? 'DUPLICATE_FRAME' : 'TIMESTAMP_REGRESSION';
      return {
        frame: null,
        dropped: true,
        drop_reason: code,
        time_gap: false,
        track_changed: false,
        error: new BrainError(code, `frame ${frame.frame_id} rejected by time guard`, { recoverable: true, details: { ...tg } }),
      };
    }

    const trackId = frame.tracked_subject_id ?? null;
    const trackChanged = this.lastTrackId !== undefined && this.lastTrackId !== trackId || Boolean(frame.quality.track_changed);
    this.lastTrackId = trackId;

    if (tg.gap || trackChanged) {
      // Continuity invalidated: drop filters and history rather than bridging the gap.
      this.window.clear();
      this.smoother.reset();
      this.gate.reset();
    }

    const { landmarks, applied } = canonicalizeMirror(frame);
    const image = toFilteredImageLandmarks(landmarks, this.config.min_visibility);
    const norm = normalizeBodyRelative(image, frame.image_size);
    const dtMs = tg.gap || trackChanged ? null : tg.dt_ms;

    let body = norm.body;
    if (norm.valid) {
      body = this.gate.apply(body, frame.timestamp_ms, dtMs);
      const t = frame.timestamp_ms / 1000;
      body = body.map((l) => {
        if (!l.valid) {
          this.smoother.resetLandmark(l.id);
          return l;
        }
        return {
          ...l,
          x: this.smoother.smooth(l.id, 'x', l.x, t),
          y: this.smoother.smooth(l.id, 'y', l.y, t),
          z: l.z === null ? null : this.smoother.smooth(l.id, 'z', l.z, t),
        };
      });
    }

    const filtered: FilteredPoseFrame = {
      session_id: frame.session_id,
      frame_id: frame.frame_id,
      timestamp_ms: frame.timestamp_ms,
      dt_ms: dtMs,
      image,
      body,
      root_image: norm.root_image,
      scale_px: norm.scale_px,
      normalization_valid: norm.valid,
      normalization_reason: norm.valid ? undefined : norm.reason === 'MISSING_JOINT' ? 'MISSING_JOINT' : 'NORMALIZATION_INVALID',
      mirror_applied: applied,
      view: this.config.view,
      quality: frame.quality,
      track_id: trackId,
      time_gap: tg.gap,
      image_size: frame.image_size,
    };
    this.window.push(filtered);
    return { frame: filtered, dropped: false, time_gap: tg.gap, track_changed: trackChanged };
  }
}
