import type { MovementTaxonomy, PoseFrame } from '@apexformz/contracts';
import { MIRROR_PAIRS } from '@apexformz/contracts';
import {
  buildMovementHierarchy, decideHierarchical, decideOpenSet, validateMovementModelConfig,
  type MovementDetection, type MovementDetectionReason, type MovementHierarchy, type MovementModelConfig, type RecognizerOutput,
} from '@apexformz/analysis';
import { canonicalizeMirror, normalizeBodyRelative, toFilteredImageLandmarks, type ResampledSeries } from '@apexformz/signal';
import type { BrainTick } from '@apexformz/runtime';

export interface AsyncMovementPredictor {
  predictAsync(series: ResampledSeries): Promise<RecognizerOutput>;
}

interface Sample {
  timestamp_ms: number;
  values: ResampledSeries['values'][number];
  mask: boolean[];
}

/** tracker_root_v1: same aspect-corrected image root/torso used by the Python dataset. */
export function continuityRoot(frame: PoseFrame, minVisibility: number): { x: number; y: number; torso: number; timestamp_ms: number } | null {
  const [w, h] = frame.image_size;
  const points = new Map(frame.normalized_landmarks.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)
    && (p.visibility ?? p.presence ?? 1) >= minVisibility).map((p) => [p.id, { x: p.x * w / h, y: p.y }]));
  const ls = points.get(11), rs = points.get(12), lh = points.get(23), rh = points.get(24);
  if (!ls || !rs || !lh || !rh) return null;
  const x = (lh.x + rh.x) / 2, y = (lh.y + rh.y) / 2;
  const torso = Math.hypot((ls.x + rs.x) / 2 - x, (ls.y + rs.y) / 2 - y);
  return Number.isFinite(torso) && torso > 1e-6 ? { x, y, torso, timestamp_ms: frame.timestamp_ms } : null;
}

/** Both the taxonomy membership and its probability gates need review before strict use. */
export function recognitionHierarchy(taxonomy: MovementTaxonomy | undefined): MovementHierarchy | null {
  const hierarchy = buildMovementHierarchy(taxonomy);
  if (!hierarchy || !taxonomy) return null;
  const gatesStatus = taxonomy.recognition?.validation_status ?? 'provisional';
  hierarchy.validation_status = hierarchy.validation_status === 'disabled' || gatesStatus === 'disabled'
    ? 'disabled' : hierarchy.validation_status === 'approved' && gatesStatus === 'approved' ? 'approved' : 'provisional';
  return hierarchy;
}

/**
 * Camera-independent body frame from 3D world landmarks (ml/datasets/jsonl_dataset.py::normalize_world_bodyframe):
 * hip-centred, rotated about the vertical axis so right-hip -> left-hip points along +x, scaled by 3D torso length.
 * Validity comes from the image landmarks' visibility; geometry from the world landmarks.
 */
export function worldBodyframeSample(frame: PoseFrame, minVisibility: number): Sample | null {
  if (frame.landmark_set !== 'mediapipe_pose_33' || !frame.world_landmarks?.length) return null;
  const valid: boolean[] = Array(33).fill(false);
  for (const p of frame.normalized_landmarks) if (p.id < 33) valid[p.id] = Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility ?? p.presence ?? 1) >= minVisibility;
  const w: Array<[number, number, number]> = Array.from({ length: 33 }, () => [0, 0, 0]);
  const have: boolean[] = Array(33).fill(false);
  for (const p of frame.world_landmarks) if (p.id < 33 && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z ?? 0)) { w[p.id] = [p.x, p.y, p.z ?? 0]; have[p.id] = true; }
  if (frame.mirror) {
    for (const v of w) v[0] = -v[0];
    for (const [l, r] of MIRROR_PAIRS) {
      [w[l], w[r]] = [w[r], w[l]];
      [have[l], have[r]] = [have[r], have[l]];
      [valid[l], valid[r]] = [valid[r], valid[l]];
    }
  }
  const ok = valid.map((v, i) => v && have[i]);
  const [ls, rs, lh, rh] = [11, 12, 23, 24];
  if (!(ok[ls] && ok[rs] && ok[lh] && ok[rh])) return null;
  const hp = [0, 1, 2].map((k) => (w[lh][k] + w[rh][k]) / 2);
  const sh = [0, 1, 2].map((k) => (w[ls][k] + w[rs][k]) / 2);
  const scale = Math.hypot(sh[0] - hp[0], sh[1] - hp[1], sh[2] - hp[2]);
  const yaw = Math.atan2(w[lh][2] - w[rh][2], w[lh][0] - w[rh][0]);
  if (!Number.isFinite(scale) || scale < 1e-6 || !Number.isFinite(yaw)) return null;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const values = w.map((p, i) => {
    if (!ok[i]) return null;
    const x = p[0] - hp[0], y = p[1] - hp[1], z = p[2] - hp[2];
    return { x: (c * x + s * z) / scale, y: y / scale, z: (-s * x + c * z) / scale };
  });
  return { timestamp_ms: frame.timestamp_ms, values, mask: ok };
}

/** Mirror a normalized sample across the body's sagittal plane: x -> -x and left/right landmarks swapped. */
export function mirrorSample(s: Sample): Sample {
  const values = s.values.map((v) => (v ? { ...v, x: -v.x } : null));
  const mask = [...s.mask];
  for (const [l, r] of MIRROR_PAIRS) {
    [values[l], values[r]] = [values[r], values[l]];
    [mask[l], mask[r]] = [mask[r], mask[l]];
  }
  return { timestamp_ms: s.timestamp_ms, values, mask };
}

/** Same unfiltered, aspect-corrected normalization as ml/datasets/jsonl_dataset.py. */
export function movementSample(frame: PoseFrame, minVisibility: number, normalization: 'body_relative_v1' | 'world_bodyframe_v1' = 'body_relative_v1'): Sample | null {
  if (normalization === 'world_bodyframe_v1') return worldBodyframeSample(frame, minVisibility);
  if (frame.landmark_set !== 'mediapipe_pose_33') return null;
  const byId = new Map(frame.normalized_landmarks.map((p) => [p.id, p]));
  const dense = Array.from({ length: 33 }, (_, id) => {
    const p = byId.get(id);
    return p ? { ...p, z: p.z ?? 0 } : { id, x: 0, y: 0, z: 0, visibility: 0 };
  });
  const canonical = canonicalizeMirror({ ...frame, normalized_landmarks: dense });
  const image = toFilteredImageLandmarks(canonical.landmarks, minVisibility);
  const norm = normalizeBodyRelative(image, frame.image_size);
  if (!norm.valid) return null;
  return {
    timestamp_ms: frame.timestamp_ms,
    values: norm.body.map((p) => p.valid ? { x: p.x, y: p.y, z: p.z } : null),
    mask: norm.body.map((p) => p.valid),
  };
}

/**
 * Bounded causal inference alongside (never in control of) the selected coaching graph.
 * One inference at a time; resets invalidate pending results without starting another run.
 */
export class CausalMovementDetector {
  readonly config: MovementModelConfig;
  private samples: Sample[] = [];
  private epoch = 0;
  private busy = false;
  private lastInferenceMs: number | null = null;
  private lastFrameId: number | null = null;
  private lastTimestamp: number | null = null;
  private lastCamera: string | null = null;
  private lastTrack: string | null = null;
  private rootAnchor: ReturnType<typeof continuityRoot> = null;
  private session: { id: string; sport: string; selected: string; hierarchy: MovementHierarchy | null; mirror: boolean } | null = null;

  constructor(config: MovementModelConfig, private readonly predictor: AsyncMovementPredictor, private readonly options: {
    allow_provisional?: boolean;
    inference_interval_ms?: number;
    minimum_observed_fraction?: number;
    max_gap_ms?: number;
    max_result_age_ms?: number;
  } = {}) {
    this.config = validateMovementModelConfig(config);
  }

  /** `hierarchy` comes from the active sport pack's taxonomy; without it recognition stays fine-level only. */
  /**
   * @param handedness athlete's dominant hand from calibration. When the model declares the handedness it was trained
   * on (input.canonical_handedness) and the athlete differs, poses are mirrored into the training frame so a
   * left-hander's dominant-side action is seen as such, not as its mirror image. Unknown handedness is never mirrored.
   */
  startSession(id: string, sport: string, selectedMovement: string, hierarchy: MovementHierarchy | null = null, handedness: 'left' | 'right' | 'unknown' = 'unknown'): void {
    this.reset();
    const canonical = this.config.input.canonical_handedness;
    const mirror = !!canonical && handedness !== 'unknown' && handedness !== canonical;
    this.session = { id, sport, selected: selectedMovement, hierarchy, mirror };
  }

  /** Recognizer label -> reviewed explicit mapping, or an exact id present in the active taxonomy. */
  private movementOf(label: string): string | null {
    const mapped = this.config.movement_ids?.[label];
    if (mapped) return mapped;
    return label.startsWith(`${this.config.sport_id}.`) && this.session?.hierarchy?.movement_to_group[label] ? label : null;
  }

  endSession(): void {
    this.reset();
    this.session = null;
  }

  reset(): void {
    this.epoch++;
    this.samples = [];
    this.lastInferenceMs = null;
    this.lastFrameId = null;
    this.lastTimestamp = null;
    this.lastCamera = null;
    this.lastTrack = null;
    this.rootAnchor = null;
  }

  async observe(frame: PoseFrame, tick: BrainTick): Promise<MovementDetection | null> {
    const session = this.session;
    if (!session || frame.session_id !== session.id || tick.frame_id !== frame.frame_id) return null;
    if (session.sport !== this.config.sport_id || tick.executed_pack.id !== this.config.sport_id) {
      this.reset();
      return this.unknown(frame, 'SPORT_MISMATCH');
    }
    // Identity or session boundaries clear history; transient pose quality failures are masked below.
    if (tick.session_state !== 'ACTIVE') {
      this.reset();
      return this.unknown(frame, 'POSE_QUALITY');
    }
    if (frame.landmark_set !== this.config.input.landmark_set) {
      this.reset();
      return this.unknown(frame, 'LANDMARK_SET_MISMATCH');
    }
    if (this.config.calibration.status !== 'validated' && !this.options.allow_provisional) return this.unknown(frame, 'CALIBRATION_UNVALIDATED');
    if (!Number.isFinite(frame.timestamp_ms) || (this.lastTimestamp !== null && frame.timestamp_ms <= this.lastTimestamp) || (this.lastFrameId !== null && frame.frame_id <= this.lastFrameId)) return null;
    const identityUnsafe = frame.quality.ambiguous_people || frame.quality.track_changed || tick.signal.track_changed || tick.quality.reasons.some((r) => r === 'AMBIGUOUS_SUBJECT' || r === 'TRACK_CHANGED');
    if (identityUnsafe) this.reset();
    if (tick.signal.time_gap || (this.lastTimestamp !== null && frame.timestamp_ms - this.lastTimestamp > (this.options.max_gap_ms ?? 400)) || (this.lastCamera !== null && this.lastCamera !== frame.camera_id) || (this.lastTimestamp !== null && this.lastTrack !== (frame.tracked_subject_id ?? null))) this.reset();
    // Same frame gate as training (deployment input.frame_gate). identity_only keeps frames whose joints are only
    // partly visible; missing joints are masked per landmark by movementSample.
    const strictGate = (this.config.input.frame_gate ?? 'strict') === 'strict';
    const qualityBlocked = identityUnsafe || tick.signal.dropped || !tick.signal.normalization_valid
      || (strictGate && (!tick.quality.ok || !frame.quality.framing_ok || frame.quality.missing_joints.length > 0));
    let raw = qualityBlocked ? null : movementSample(frame, this.config.input.min_visibility, this.config.input.normalization);
    if (raw && this.config.input.subject_continuity === 'tracker_root_v1') {
      const root = continuityRoot(frame, this.config.input.min_visibility);
      if (!root) raw = null;
      else {
        const previous = this.rootAnchor;
        const dt = previous ? Math.max(0, (frame.timestamp_ms - previous.timestamp_ms) / 1000) : 0;
        if (previous && Math.hypot(root.x - previous.x, root.y - previous.y) / previous.torso > 0.75 + 12 * dt) {
          this.reset();
          this.rootAnchor = previous; // clear temporal evidence but do not follow the rejected subject
          raw = null;
        } else this.rootAnchor = root;
      }
    }
    this.lastFrameId = frame.frame_id;
    this.lastTimestamp = frame.timestamp_ms;
    this.lastCamera = frame.camera_id;
    this.lastTrack = frame.tracked_subject_id ?? null;
    const sample = raw && session.mirror ? mirrorSample(raw) : raw;
    const span = (this.config.input.window_frames - 1) * 1000 / this.config.input.hz;
    // Keep the timestamp so hold-last resampling cannot replace a bad frame with earlier good joints.
    // This yields the same zero input/mask tensors as the training dataset's invalid-frame handling.
    this.samples.push(sample ?? { timestamp_ms: frame.timestamp_ms, values: Array(33).fill(null), mask: Array(33).fill(false) });
    const cutoff = frame.timestamp_ms - span - this.config.input.max_hold_ms;
    this.samples = this.samples.filter((s) => s.timestamp_ms >= cutoff).slice(-4096);
    if (!sample) {
      this.epoch++; // suppress any inference started before this quality failure
      return this.unknown(frame, 'POSE_QUALITY');
    }
    if (this.samples[0].timestamp_ms > frame.timestamp_ms - span + 1e-6) return this.unknown(frame, 'INSUFFICIENT_HISTORY');
    const series = this.resample(frame.timestamp_ms);
    const observed = series.mask.reduce((n, row) => n + row.filter(Boolean).length, 0) / (33 * this.config.input.window_frames);
    if (observed < (this.options.minimum_observed_fraction ?? this.config.input.min_observed_fraction ?? 0.6)) {
      this.epoch++;
      return this.unknown(frame, 'POSE_QUALITY', observed);
    }
    if (this.busy || (this.lastInferenceMs !== null && frame.timestamp_ms - this.lastInferenceMs < (this.options.inference_interval_ms ?? 200))) return null;
    this.lastInferenceMs = frame.timestamp_ms;
    this.busy = true;
    const epoch = this.epoch;
    try {
      const output = await this.predictor.predictAsync(series);
      if (epoch !== this.epoch || this.session !== session || (this.lastTimestamp ?? frame.timestamp_ms) - frame.timestamp_ms > (this.options.max_result_age_ms ?? 1000)) return null;
      const hierarchy = session.hierarchy;
      if (hierarchy && (hierarchy.validation_status === 'approved' || (hierarchy.validation_status === 'provisional' && this.options.allow_provisional))) {
        const h = decideHierarchical(output, this.config.calibration.thresholds, this.config.calibration.margin, hierarchy, (l) => this.movementOf(l));
        const fine = h.movement;
        return {
          ...this.unknown(frame, (h.level ? fine.reason : h.reason) ?? 'UNKNOWN_CLASS', observed),
          // A validated fine model does not validate provisional group/family gates.
          calibration_status: hierarchy.validation_status === 'provisional' ? 'provisional' : this.config.calibration.status,
          capture_label: fine.unknown ? null : fine.movement_id,
          capture_name: fine.unknown || !fine.movement_id ? null : this.config.class_names?.[fine.movement_id] ?? fine.movement_id,
          movement_id: fine.unknown || !fine.movement_id ? null : this.movementOf(fine.movement_id),
          // `unknown` keeps its fine-level meaning; a group- or family-level answer is reported through `level`.
          unknown: fine.unknown,
          reason: h.level === 'movement' ? null : (fine.reason ?? h.reason ?? null),
          probability: fine.probability,
          probabilities: output.probabilities,
          unknown_probability: output.unknown_probability,
          level: h.level,
          group_id: h.group_id,
          group_name: h.group_id ? hierarchy.names[h.group_id] ?? null : null,
          group_probability: h.group_probability,
          family_id: h.family_id,
          family_name: h.family_id ? hierarchy.names[h.family_id] ?? null : null,
          family_probability: h.family_probability,
          closest_match: h.closest_match ? {
            capture_label: h.closest_match.class_label,
            capture_name: this.config.class_names?.[h.closest_match.class_label] ?? h.closest_match.class_label,
            movement_id: h.closest_match.movement_id,
            probability: h.closest_match.probability,
          } : null,
        };
      }
      const decision = decideOpenSet(output, this.config.calibration.thresholds, this.config.calibration.margin);
      return {
        ...this.unknown(frame, decision.reason ?? 'UNKNOWN_CLASS', observed),
        capture_label: decision.unknown ? null : decision.movement_id,
        capture_name: decision.unknown || !decision.movement_id ? null : this.config.class_names?.[decision.movement_id] ?? decision.movement_id,
        movement_id: decision.unknown || !decision.movement_id ? null : this.movementOf(decision.movement_id),
        unknown: decision.unknown,
        reason: decision.reason ?? null,
        probability: decision.probability,
        probabilities: output.probabilities,
        unknown_probability: output.unknown_probability,
      };
    } catch {
      return epoch === this.epoch && this.session === session ? this.unknown(frame, 'MODEL_UNAVAILABLE', observed) : null;
    } finally {
      this.busy = false;
    }
  }

  private resample(latest: number): ResampledSeries {
    const { window_frames: count, hz, max_hold_ms: hold } = this.config.input;
    const out: ResampledSeries = { timestamps_ms: [], values: [], mask: [], padded: [] };
    let idx = 0;
    for (let k = 0; k < count; k++) {
      const t = latest - (count - 1 - k) * 1000 / hz;
      while (idx + 1 < this.samples.length && this.samples[idx + 1].timestamp_ms <= t + 1e-6) idx++;
      const s = this.samples[idx];
      const usable = s && s.timestamp_ms <= t + 1e-6 && t - s.timestamp_ms <= hold;
      out.timestamps_ms.push(t);
      out.values.push(usable ? s.values : []);
      out.mask.push(usable ? s.mask : []);
      out.padded.push(!usable || !s.mask.some(Boolean));
    }
    return out;
  }

  private unknown(frame: PoseFrame, reason: MovementDetectionReason, observed = 0): MovementDetection {
    return {
      schema_version: '1.0.0', session_id: frame.session_id, frame_id: frame.frame_id, timestamp_ms: frame.timestamp_ms,
      sport_id: this.config.sport_id, selected_coaching_movement_id: this.session!.selected,
      model_task: this.config.model_task ?? (this.config.input.window_frames === 1 ? 'static_pose' : 'dynamic_movement'),
      capture_label: null, capture_name: null, movement_id: null, unknown: true, reason, probability: null, probabilities: {}, unknown_probability: null,
      observed_fraction: observed, calibration_status: this.config.calibration.status, model: this.config.model,
    };
  }
}
