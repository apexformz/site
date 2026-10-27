import {
  BrainError, type CoordinateSystem, type FeatureSpec, type FeatureValue, type MissingReason, type Unit,
} from '@apexformz/contracts';
import type { FilteredLandmark, FilteredPoseFrame, PoseWindow } from '@apexformz/signal';
import {
  angleAt, derivativeSeries, distance, finiteDifference, fittedSlope, lineInclination, mean, segmentOrientation, std,
} from './geometry';
import { resolveLandmarkRef } from './landmark_ref';
import type { FeatureContext, FeatureHistorySample, FeatureMap } from './types';

const DERIVED_KINDS = new Set(['time_derivative', 'angular_velocity', 'stability_variability', 'window_min', 'window_max', 'window_mean', 'relative_phase_timing']);

function derivativeUnit(u: Unit): Unit {
  switch (u) {
    case 'deg': return 'deg_per_s';
    case 'rad': return 'rad_per_s';
    case 'deg_per_s': return 'deg_per_s2';
    case 'normalized': return 'normalized_per_s';
    case 'normalized_per_s': return 'normalized_per_s2';
    case 'normalized_per_s2': return 'normalized_per_s3';
    case 'm': return 'm_per_s';
    default: return 'none';
  }
}

function defaultUnit(spec: FeatureSpec): Unit {
  if (spec.unit) return spec.unit;
  switch (spec.kind) {
    case 'angle_at':
    case 'line_inclination':
    case 'segment_orientation':
      return 'deg';
    case 'interjoint_distance_ratio':
      return 'ratio';
    case 'relative_phase_timing':
      return 'score';
    case 'path_smoothness':
      return 'normalized_per_s3';
    case 'center_of_keypoints':
    case 'landmark_coordinate':
    case 'landmark_offset':
      return spec.coordinate_system === 'body_relative' ? 'normalized' : 'normalized';
    default:
      return 'none';
  }
}

/**
 * Feature engine (TRD 04): pure functions of validated PoseWindow + FeatureSpec,
 * dependency graph compiled from the requested spec list, per-frame cache,
 * typed missingness, explicit coordinate systems and view applicability.
 *
 * The engine contains no sport knowledge and no thresholds.
 */
export class FeatureEngine {
  private specs = new Map<string, FeatureSpec>();
  private order: string[] = [];
  private history = new Map<string, FeatureHistorySample[]>();
  private historyMs: number;
  private cadenceMaxGapMs: number | undefined;
  private invalidAt = new Map<string, number>();
  private lastFrameId: number | null = null;
  private cache: FeatureMap = new Map();
  private computeCount = 0;
  private units = new Map<string, Unit>();

  constructor(specs: FeatureSpec[], options: { history_ms?: number; cadence_max_gap_ms?: number } = {}) {
    this.historyMs = options.history_ms ?? 4000;
    this.cadenceMaxGapMs = options.cadence_max_gap_ms;
    this.setSpecs(specs);
  }

  get stats() {
    return { specs: this.specs.size, computes: this.computeCount, history_series: this.history.size };
  }

  setSpecs(specs: FeatureSpec[]): void {
    this.specs.clear();
    for (const s of specs) {
      if (this.specs.has(s.id)) throw new BrainError('PACK_VALIDATION_FAILED', `duplicate feature spec id ${s.id}`, { recoverable: false });
      this.specs.set(s.id, s);
    }
    this.order = this.topoSort();
    for (const id of this.order) this.units.set(id, this.resolveUnit(id, new Set()));
    this.reset();
  }

  /** Clear all temporal history (time gap, track change, session boundary). */
  reset(): void {
    this.history.clear();
    this.invalidAt.clear();
    this.cache.clear();
    this.lastFrameId = null;
  }

  dependenciesOf(spec: FeatureSpec): string[] {
    const p = spec.params as Record<string, unknown>;
    const deps: string[] = [];
    if (typeof p.of === 'string') deps.push(p.of);
    if (Array.isArray(p.features)) deps.push(...(p.features as string[]));
    return deps;
  }

  private topoSort(): string[] {
    const visited = new Set<string>();
    const temp = new Set<string>();
    const out: string[] = [];
    const visit = (id: string, chain: string[]) => {
      if (visited.has(id)) return;
      if (temp.has(id)) throw new BrainError('PACK_VALIDATION_FAILED', `feature dependency cycle: ${[...chain, id].join(' -> ')}`, { recoverable: false });
      const spec = this.specs.get(id);
      if (!spec) throw new BrainError('PACK_VALIDATION_FAILED', `feature ${chain.at(-1)} depends on unknown feature ${id}`, { recoverable: false });
      temp.add(id);
      for (const d of this.dependenciesOf(spec)) visit(d, [...chain, id]);
      temp.delete(id);
      visited.add(id);
      out.push(id);
    };
    for (const id of this.specs.keys()) visit(id, []);
    return out;
  }

  private resolveUnit(id: string, seen: Set<string>): Unit {
    const spec = this.specs.get(id)!;
    if (spec.unit) return spec.unit;
    if (seen.has(id)) return 'none';
    seen.add(id);
    const p = spec.params as Record<string, unknown>;
    switch (spec.kind) {
      case 'time_derivative':
      case 'angular_velocity':
        return derivativeUnit(this.resolveUnit(p.of as string, seen));
      case 'stability_variability':
      case 'window_min':
      case 'window_max':
      case 'window_mean':
        return this.resolveUnit(p.of as string, seen);
      case 'min_of':
      case 'max_of': {
        const first = (p.features as string[] | undefined)?.[0];
        return first ? this.resolveUnit(first, seen) : 'none';
      }
      default:
        return defaultUnit(spec);
    }
  }

  unitOf(id: string): Unit {
    return this.units.get(id) ?? 'none';
  }

  /** Compute every spec for the window's latest frame. Idempotent per frame_id. */
  compute(window: PoseWindow, ctx: FeatureContext): FeatureMap {
    const latest = window.latest();
    if (!latest) return new Map();
    if (this.lastFrameId === latest.frame_id && this.cache.size) return this.cache;
    this.computeCount++;
    const out: FeatureMap = new Map();
    for (const id of this.order) {
      const spec = this.specs.get(id)!;
      const v = this.computeOne(spec, window, latest, ctx, out);
      out.set(id, v);
      if (v.valid && v.value !== null && !DERIVED_KINDS.has(spec.kind) || (v.valid && v.value !== null && spec.kind !== 'relative_phase_timing')) {
        this.appendHistory(id, { frame_id: latest.frame_id, timestamp_ms: latest.timestamp_ms, value: v.value!, confidence: v.confidence ?? 0 }, latest.timestamp_ms);
      } else {
        if (!v.valid) this.invalidAt.set(id, latest.timestamp_ms);
        this.trimHistory(id, latest.timestamp_ms);
      }
    }
    this.cache = out;
    this.lastFrameId = latest.frame_id;
    return out;
  }

  /** History (valid samples only) of a feature within `spanMs` of the latest timestamp. */
  historyOf(id: string, spanMs: number, untilMs?: number): FeatureHistorySample[] {
    const h = this.history.get(id) ?? [];
    if (!h.length) return [];
    const end = untilMs ?? h[h.length - 1].timestamp_ms;
    const cutoff = end - spanMs;
    return h.filter((s) => s.timestamp_ms >= cutoff && s.timestamp_ms <= end);
  }

  /** Contiguous observed values only: never bridge a missing feature or a capture gap. */
  private cadenceHistory(id: string, spanMs: number, untilMs: number): FeatureHistorySample[] {
    if (!this.cadenceMaxGapMs) return [];
    const samples = this.historyOf(id, spanMs, untilMs).filter(s => s.timestamp_ms > (this.invalidAt.get(id) ?? -Infinity));
    let start = samples.length - 1;
    while (start > 0 && samples[start].timestamp_ms - samples[start - 1].timestamp_ms <= this.cadenceMaxGapMs) start--;
    return samples.slice(Math.max(0, start));
  }

  private appendHistory(id: string, s: FeatureHistorySample, nowMs: number): void {
    let h = this.history.get(id);
    if (!h) {
      h = [];
      this.history.set(id, h);
    }
    h.push(s);
    this.trimHistory(id, nowMs);
  }

  private trimHistory(id: string, nowMs: number): void {
    const h = this.history.get(id);
    if (!h) return;
    const cutoff = nowMs - this.historyMs;
    let drop = 0;
    while (drop < h.length && h[drop].timestamp_ms < cutoff) drop++;
    if (drop) h.splice(0, drop);
  }

  private invalid(spec: FeatureSpec, latest: FilteredPoseFrame, reason: MissingReason, ctx: FeatureContext, derivedFrom?: string[]): FeatureValue {
    return {
      spec_id: spec.id,
      name: spec.id,
      value: null,
      unit: this.unitOf(spec.id),
      valid: false,
      reason,
      evidence_frame_ids: [latest.frame_id],
      confidence: null,
      view_applicability: spec.view_applicability,
      coordinate_system: spec.coordinate_system,
      timestamp_ms: latest.timestamp_ms,
      derived_from: derivedFrom,
      retrospective: ctx.retrospective ?? false,
    };
  }

  private valid(spec: FeatureSpec, latest: FilteredPoseFrame, value: number, confidence: number, frameIds: number[], ctx: FeatureContext, meta?: Record<string, unknown>, derivedFrom?: string[]): FeatureValue {
    if (!Number.isFinite(value)) return this.invalid(spec, latest, 'DEGENERATE_GEOMETRY', ctx, derivedFrom);
    return {
      spec_id: spec.id,
      name: spec.id,
      value,
      unit: this.unitOf(spec.id),
      valid: true,
      reason: null,
      evidence_frame_ids: frameIds,
      confidence,
      view_applicability: spec.view_applicability,
      coordinate_system: spec.coordinate_system,
      timestamp_ms: latest.timestamp_ms,
      derived_from: derivedFrom,
      retrospective: ctx.retrospective ?? false,
      meta,
    };
  }

  private viewOk(spec: FeatureSpec, ctx: FeatureContext): boolean {
    if (spec.view_applicability === 'any') return true;
    return spec.view_applicability.includes(ctx.view);
  }

  private landmarks(spec: FeatureSpec, frame: FilteredPoseFrame): { set: FilteredLandmark[]; ok: boolean; reason?: MissingReason } {
    const cs: CoordinateSystem = spec.coordinate_system;
    if (cs === 'body_relative') {
      if (!frame.normalization_valid) return { set: frame.body, ok: false, reason: frame.normalization_reason ?? 'NORMALIZATION_INVALID' };
      return { set: frame.body, ok: true };
    }
    if (cs === 'image_normalized') return { set: frame.image, ok: true };
    // image_pixel: scale normalized image coordinates; estimated/calibrated world not supplied by the pipeline yet.
    if (cs === 'image_pixel') {
      const [W, H] = frame.image_size;
      return { set: frame.image.map((l) => ({ ...l, x: l.x * W, y: l.y * H, z: l.z === null ? null : l.z * W })), ok: true };
    }
    return { set: [], ok: false, reason: 'SCALE_UNKNOWN' };
  }

  private pick(set: FilteredLandmark[], ref: string, ctx: FeatureContext): { lm: FilteredLandmark | null; reason?: MissingReason; assumed?: boolean } {
    const r = resolveLandmarkRef(ref, ctx.handedness, ctx.handedness_assumed);
    if (r.id === null) return { lm: null, reason: r.reason };
    const lm = set[r.id];
    if (!lm) return { lm: null, reason: 'MISSING_JOINT' };
    if (!lm.valid) return { lm: null, reason: lm.reason ?? 'MISSING_JOINT' };
    return { lm, assumed: r.assumed };
  }

  private computeOne(spec: FeatureSpec, window: PoseWindow, latest: FilteredPoseFrame, ctx: FeatureContext, computed: FeatureMap): FeatureValue {
    if (!this.viewOk(spec, ctx)) return this.invalid(spec, latest, 'VIEW_INVALID', ctx);
    const p = spec.params as Record<string, unknown>;

    switch (spec.kind) {
      case 'angle_at': {
        const L = this.landmarks(spec, latest);
        if (!L.ok) return this.invalid(spec, latest, L.reason!, ctx);
        const a = this.pick(L.set, p.a as string, ctx);
        const b = this.pick(L.set, p.b as string, ctx);
        const c = this.pick(L.set, p.c as string, ctx);
        const miss = [a, b, c].find((x) => !x.lm);
        if (miss) return this.invalid(spec, latest, miss.reason ?? 'MISSING_JOINT', ctx);
        const use3d = p.dims === '3d';
        if (use3d && [a, b, c].some((x) => x.lm!.z === null)) return this.invalid(spec, latest, 'MISSING_JOINT', ctx);
        const ang = angleAt(a.lm!, b.lm!, c.lm!, use3d);
        if (ang === null) return this.invalid(spec, latest, 'DEGENERATE_GEOMETRY', ctx);
        return this.valid(spec, latest, ang, this.conf([a.lm!, b.lm!, c.lm!], a.assumed || b.assumed || c.assumed), [latest.frame_id], ctx);
      }
      case 'line_inclination': {
        const L = this.landmarks(spec, latest);
        if (!L.ok) return this.invalid(spec, latest, L.reason!, ctx);
        const from = this.midpointOrLandmark(L.set, p.from, ctx);
        const to = this.midpointOrLandmark(L.set, p.to, ctx);
        if (!from.pt || !to.pt) return this.invalid(spec, latest, from.reason ?? to.reason ?? 'MISSING_JOINT', ctx);
        const v = lineInclination(from.pt, to.pt, (p.reference as 'vertical' | 'horizontal') ?? 'vertical');
        if (v === null) return this.invalid(spec, latest, 'DEGENERATE_GEOMETRY', ctx);
        return this.valid(spec, latest, v, Math.min(from.conf, to.conf), [latest.frame_id], ctx);
      }
      case 'segment_orientation': {
        const L = this.landmarks(spec, latest);
        if (!L.ok) return this.invalid(spec, latest, L.reason!, ctx);
        const from = this.midpointOrLandmark(L.set, p.from, ctx);
        const to = this.midpointOrLandmark(L.set, p.to, ctx);
        if (!from.pt || !to.pt) return this.invalid(spec, latest, from.reason ?? to.reason ?? 'MISSING_JOINT', ctx);
        const v = segmentOrientation(from.pt, to.pt, (p.plane as 'xy' | 'xz' | 'yz') ?? 'xy');
        if (v === null) return this.invalid(spec, latest, p.plane && p.plane !== 'xy' ? 'MISSING_JOINT' : 'DEGENERATE_GEOMETRY', ctx);
        return this.valid(spec, latest, v, Math.min(from.conf, to.conf), [latest.frame_id], ctx);
      }
      case 'interjoint_distance_ratio': {
        const L = this.landmarks(spec, latest);
        if (!L.ok) return this.invalid(spec, latest, L.reason!, ctx);
        const refs = ['a', 'b', 'c', 'd'].map((k) => this.midpointOrLandmark(L.set, p[k], ctx));
        const miss = refs.find((r) => !r.pt);
        if (miss) return this.invalid(spec, latest, miss.reason ?? 'MISSING_JOINT', ctx);
        const use3d = p.dims === '3d';
        const num = distance(refs[0].pt!, refs[1].pt!, use3d);
        const den = distance(refs[2].pt!, refs[3].pt!, use3d);
        if (den < 1e-6) return this.invalid(spec, latest, 'DEGENERATE_GEOMETRY', ctx);
        return this.valid(spec, latest, num / den, Math.min(...refs.map((r) => r.conf)), [latest.frame_id], ctx);
      }
      case 'center_of_keypoints': {
        const L = this.landmarks(spec, latest);
        if (!L.ok) return this.invalid(spec, latest, L.reason!, ctx);
        const names = p.landmarks as string[];
        const pts = names.map((n) => this.pick(L.set, n, ctx));
        const miss = pts.find((x) => !x.lm);
        if (miss) return this.invalid(spec, latest, miss.reason ?? 'MISSING_JOINT', ctx);
        const axis = (p.axis as 'x' | 'y' | 'z') ?? 'y';
        const vals = pts.map((x) => (axis === 'z' ? x.lm!.z : x.lm![axis]));
        if (vals.some((v) => v === null)) return this.invalid(spec, latest, 'MISSING_JOINT', ctx);
        return this.valid(spec, latest, mean(vals as number[])!, this.conf(pts.map((x) => x.lm!)), [latest.frame_id], ctx, { note: 'keypoint centroid proxy; not a biomechanical centre of mass' });
      }
      case 'landmark_coordinate': {
        const L = this.landmarks(spec, latest);
        if (!L.ok) return this.invalid(spec, latest, L.reason!, ctx);
        const a = this.pick(L.set, p.landmark as string, ctx);
        if (!a.lm) return this.invalid(spec, latest, a.reason ?? 'MISSING_JOINT', ctx);
        const axis = (p.axis as 'x' | 'y' | 'z') ?? 'y';
        const v = axis === 'z' ? a.lm.z : a.lm[axis];
        if (v === null) return this.invalid(spec, latest, 'MISSING_JOINT', ctx);
        return this.valid(spec, latest, v, this.conf([a.lm], a.assumed), [latest.frame_id], ctx);
      }
      case 'landmark_offset': {
        const L = this.landmarks(spec, latest);
        if (!L.ok) return this.invalid(spec, latest, L.reason!, ctx);
        const a = this.pick(L.set, p.a as string, ctx);
        const b = this.pick(L.set, p.b as string, ctx);
        if (!a.lm || !b.lm) return this.invalid(spec, latest, a.reason ?? b.reason ?? 'MISSING_JOINT', ctx);
        const axis = (p.axis as 'x' | 'y' | 'z') ?? 'x';
        const va = axis === 'z' ? a.lm.z : a.lm[axis];
        const vb = axis === 'z' ? b.lm.z : b.lm[axis];
        if (va === null || vb === null) return this.invalid(spec, latest, 'MISSING_JOINT', ctx);
        return this.valid(spec, latest, va - vb, this.conf([a.lm, b.lm], a.assumed || b.assumed), [latest.frame_id], ctx);
      }
      case 'time_derivative':
      case 'angular_velocity': {
        const of = p.of as string;
        const base = computed.get(of);
        if (!base) return this.invalid(spec, latest, 'DEPENDENCY_INVALID', ctx, [of]);
        if (!base.valid) return this.invalid(spec, latest, 'DEPENDENCY_INVALID', ctx, [of]);
        const span = (p.window_ms as number) ?? 200;
        const h = this.historyOf(of, span, latest.timestamp_ms).concat([{ frame_id: latest.frame_id, timestamp_ms: latest.timestamp_ms, value: base.value!, confidence: base.confidence ?? 0 }]);
        let dedup = h.filter((s, i) => i === 0 || s.frame_id !== h[i - 1].frame_id);
        const method = (p.method as string) ?? 'finite';
        let cadenceAdapted = false;
        if (method === 'finite' && this.cadenceMaxGapMs) dedup = this.cadenceHistory(of, span, latest.timestamp_ms);
        if (method === 'finite' && dedup.length < 2 && this.cadenceMaxGapMs) {
          const observed = this.cadenceHistory(of, this.cadenceMaxGapMs, latest.timestamp_ms).slice(-2);
          if (observed.length === 2 && observed[0].frame_id === this.lastFrameId && observed[1].frame_id === latest.frame_id) {
            dedup = observed;
            cadenceAdapted = true;
          }
        }
        const vals = dedup.map((s) => s.value);
        const ts = dedup.map((s) => s.timestamp_ms);
        const d = method === 'fit' ? fittedSlope(vals, ts) : finiteDifference(vals, ts);
        if (d === null) return this.invalid(spec, latest, 'INSUFFICIENT_HISTORY', ctx, [of]);
        return this.valid(spec, latest, d, Math.min(...dedup.map((s) => s.confidence)), dedup.map((s) => s.frame_id), ctx,
          cadenceAdapted ? { cadence_adapted: true, requested_span_ms: span, effective_span_ms: ts.at(-1)! - ts[0], samples: dedup.length } : undefined, [of]);
      }
      case 'stability_variability':
      case 'window_min':
      case 'window_max':
      case 'window_mean': {
        const of = p.of as string;
        const base = computed.get(of);
        if (!base) return this.invalid(spec, latest, 'DEPENDENCY_INVALID', ctx, [of]);
        const span = (p.window_ms as number) ?? 1000;
        const minSamples = (p.min_samples as number) ?? 3;
        let h = this.historyOf(of, span, latest.timestamp_ms);
        let cadenceAdapted = false;
        if (base.valid && (h.length === 0 || h[h.length - 1].frame_id !== latest.frame_id)) {
          h.push({ frame_id: latest.frame_id, timestamp_ms: latest.timestamp_ms, value: base.value!, confidence: base.confidence ?? 0 });
        }
        if (spec.kind === 'stability_variability' && this.cadenceMaxGapMs) {
          if (!base.valid) return this.invalid(spec, latest, 'DEPENDENCY_INVALID', ctx, [of]);
          // Keep the declared sample count. A slower device needs a longer
          // observation interval, not invented samples or a two-point variance.
          h = this.cadenceHistory(of, span, latest.timestamp_ms);
          if (h.length < minSamples) {
            const maxSpan = Math.max(span, Math.min(1200, this.cadenceMaxGapMs * (minSamples - 1)));
            const observed = this.cadenceHistory(of, maxSpan, latest.timestamp_ms).slice(-minSamples);
            if (observed.length >= minSamples) { h = observed; cadenceAdapted = true; }
          }
        }
        if (h.length < minSamples) return this.invalid(spec, latest, 'INSUFFICIENT_HISTORY', ctx, [of]);
        const vals = h.map((s) => s.value);
        let v: number | null;
        if (spec.kind === 'stability_variability') {
          const stat = (p.stat as string) ?? 'std';
          v = stat === 'range' ? Math.max(...vals) - Math.min(...vals) : std(vals);
        } else if (spec.kind === 'window_min') v = Math.min(...vals);
        else if (spec.kind === 'window_max') v = Math.max(...vals);
        else v = mean(vals);
        if (v === null) return this.invalid(spec, latest, 'INSUFFICIENT_HISTORY', ctx, [of]);
        return this.valid(spec, latest, v, Math.min(...h.map((s) => s.confidence)), h.map((s) => s.frame_id), ctx,
          { samples: h.length, ...(cadenceAdapted ? { cadence_adapted: true, requested_span_ms: span, effective_span_ms: h.at(-1)!.timestamp_ms - h[0].timestamp_ms } : {}) }, [of]);
      }
      case 'path_smoothness': {
        const span = (p.window_ms as number) ?? 500;
        const frames = window.recent(span).filter((f) => f.normalization_valid);
        const ref = p.landmark as string;
        const r = resolveLandmarkRef(ref, ctx.handedness, ctx.handedness_assumed);
        if (r.id === null) return this.invalid(spec, latest, r.reason ?? 'UNKNOWN_FEATURE', ctx);
        const pts = frames.map((f) => ({ f, lm: f.body[r.id!] })).filter((x) => x.lm && x.lm.valid);
        if (pts.length < 4) return this.invalid(spec, latest, 'INSUFFICIENT_HISTORY', ctx);
        const ts = pts.map((x) => x.f.timestamp_ms);
        const axes: Array<'x' | 'y'> = ['x', 'y'];
        let total = 0;
        for (const ax of axes) {
          const v = derivativeSeries(pts.map((x) => x.lm[ax]), ts);
          const a = derivativeSeries(v.values, v.timesMs);
          const j = derivativeSeries(a.values, a.timesMs);
          if (!j.values.length) return this.invalid(spec, latest, 'INSUFFICIENT_HISTORY', ctx);
          total += j.values.reduce((s, x) => s + x * x, 0) / j.values.length;
        }
        const rmsJerk = Math.sqrt(total);
        return this.valid(spec, latest, rmsJerk, Math.min(...pts.map((x) => x.lm.confidence)), pts.map((x) => x.f.frame_id), ctx, { samples: pts.length });
      }
      case 'min_of':
      case 'max_of': {
        const feats = p.features as string[];
        const vals = feats.map((id) => computed.get(id));
        if (vals.some((v) => !v)) return this.invalid(spec, latest, 'DEPENDENCY_INVALID', ctx, feats);
        const bad = vals.find((v) => !v!.valid);
        if (bad) return this.invalid(spec, latest, 'DEPENDENCY_INVALID', ctx, feats);
        const nums = vals.map((v) => v!.value as number);
        const idx = spec.kind === 'min_of' ? nums.indexOf(Math.min(...nums)) : nums.indexOf(Math.max(...nums));
        const frames = [...new Set(vals.flatMap((v) => v!.evidence_frame_ids))];
        return this.valid(spec, latest, nums[idx], Math.min(...vals.map((v) => v!.confidence ?? 0)), frames, ctx, { selected: feats[idx] }, feats);
      }
      case 'relative_phase_timing': {
        const feats = p.features as string[];
        const span = (p.window_ms as number) ?? 1500;
        const peaks: Array<{ id: string; t: number }> = [];
        for (const id of feats) {
          const base = computed.get(id);
          if (!base) return this.invalid(spec, latest, 'DEPENDENCY_INVALID', ctx, feats);
          const h = this.historyOf(id, span, latest.timestamp_ms);
          if (base.valid && (h.length === 0 || h[h.length - 1].frame_id !== latest.frame_id)) h.push({ frame_id: latest.frame_id, timestamp_ms: latest.timestamp_ms, value: base.value!, confidence: base.confidence ?? 0 });
          if (h.length < 3) return this.invalid(spec, latest, 'INSUFFICIENT_HISTORY', ctx, feats);
          const d = derivativeSeries(h.map((s) => s.value), h.map((s) => s.timestamp_ms));
          let best = -1;
          let bestT = 0;
          for (let i = 0; i < d.values.length; i++) {
            const m = Math.abs(d.values[i]);
            if (m > best) {
              best = m;
              bestT = d.timesMs[i];
            }
          }
          peaks.push({ id, t: bestT });
        }
        let correct = 0;
        let total = 0;
        for (let i = 0; i < peaks.length; i++) {
          for (let j = i + 1; j < peaks.length; j++) {
            total++;
            if (peaks[i].t <= peaks[j].t) correct++;
          }
        }
        if (total === 0) return this.invalid(spec, latest, 'INSUFFICIENT_HISTORY', ctx, feats);
        return this.valid(spec, latest, correct / total, 1, [latest.frame_id], ctx, { peak_times_ms: Object.fromEntries(peaks.map((x) => [x.id, x.t])) }, feats);
      }
      default:
        return this.invalid(spec, latest, 'UNKNOWN_FEATURE', ctx);
    }
  }

  private midpointOrLandmark(set: FilteredLandmark[], ref: unknown, ctx: FeatureContext): { pt: FilteredLandmark | null; conf: number; reason?: MissingReason } {
    if (Array.isArray(ref)) {
      const picks = (ref as string[]).map((r) => this.pick(set, r, ctx));
      const miss = picks.find((x) => !x.lm);
      if (miss) return { pt: null, conf: 0, reason: miss.reason ?? 'MISSING_JOINT' };
      const lms = picks.map((x) => x.lm!);
      const z = lms.every((l) => l.z !== null) ? mean(lms.map((l) => l.z as number)) : null;
      return {
        pt: { id: -1, x: mean(lms.map((l) => l.x))!, y: mean(lms.map((l) => l.y))!, z, valid: true, confidence: this.conf(lms), predicted: lms.some((l) => l.predicted) },
        conf: this.conf(lms, picks.some((x) => x.assumed)),
      };
    }
    const a = this.pick(set, ref as string, ctx);
    if (!a.lm) return { pt: null, conf: 0, reason: a.reason ?? 'MISSING_JOINT' };
    return { pt: a.lm, conf: this.conf([a.lm], a.assumed) };
  }

  private conf(lms: FilteredLandmark[], assumed?: boolean): number {
    let c = Math.min(...lms.map((l) => l.confidence));
    if (lms.some((l) => l.predicted)) c = Math.min(c, 0.4);
    if (assumed) c *= 0.8;
    return Math.max(0, Math.min(1, c));
  }
}
