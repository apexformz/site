import { CORE_BODY_LANDMARKS, LANDMARK_INDEX, type PoseLandmark } from '@apexformz/contracts';
import type { Candidate, SubjectSelection } from './types';

/** Explicit capture-space region chosen by the caller; never inferred to hide reflections. */
export interface SubjectRegion { x0: number; y0: number; x1: number; y1: number }
export function validateSubjectRegion(roi?: SubjectRegion): SubjectRegion | undefined {
  if (!roi) return undefined;
  if (![roi.x0, roi.y0, roi.x1, roi.y1].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    || roi.x0 >= roi.x1 || roi.y0 >= roi.y1) throw new Error('subject_roi must be an ordered normalized region');
  return { ...roi };
}
export function inSubjectRegion(candidate: Candidate, roi?: SubjectRegion): boolean {
  const b = candidate.bbox;
  return Number.isFinite(b.area) && b.area > 0 && (!roi || (b.cx >= roi.x0 && b.cx <= roi.x1 && b.cy >= roi.y0 && b.cy <= roi.y1));
}

export interface SubjectTrackerConfig {
  /** Second candidate at least this fraction of the best candidate's area counts as competing. Candidate value. */
  competing_area_ratio: number;
  /** Max normalized centroid distance for track continuity. Candidate value. */
  max_centroid_jump: number;
  /** Frames without a detection before the track is considered lost. */
  lost_after_frames: number;
  min_visibility: number;
  subject_roi?: SubjectRegion;
}

export const DEFAULT_TRACKER_CONFIG: SubjectTrackerConfig = {
  competing_area_ratio: 0.6,
  max_centroid_jump: 0.25,
  lost_after_frames: 15,
  min_visibility: 0.5,
};

export function candidateFromLandmarks(normalized: PoseLandmark[], world?: Candidate['world'], minVisibility = 0.5): Candidate {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let confSum = 0;
  let n = 0;
  for (const name of CORE_BODY_LANDMARKS) {
    const l = normalized[LANDMARK_INDEX[name]];
    if (!l) continue;
    const v = l.visibility ?? l.presence ?? 1;
    confSum += v;
    n++;
    if (v < minVisibility) continue;
    x0 = Math.min(x0, l.x);
    y0 = Math.min(y0, l.y);
    x1 = Math.max(x1, l.x);
    y1 = Math.max(y1, l.y);
  }
  if (!Number.isFinite(x0)) {
    x0 = y0 = 0;
    x1 = y1 = 0;
  }
  return {
    normalized,
    world,
    bbox: { x0, y0, x1, y1, area: Math.max(0, x1 - x0) * Math.max(0, y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 },
    confidence: n ? confSum / n : 0,
  };
}

/**
 * Keeps a single unambiguous target athlete (TRD 02). When identity cannot be
 * preserved confidently the selection is flagged ambiguous so downstream
 * criterion feedback freezes and a framing instruction is issued.
 */
export class SubjectTracker {
  private trackId: string | null = null;
  private trackSeq = 0;
  private last: { cx: number; cy: number; area: number } | null = null;
  private missedFrames = 0;
  private readonly cfg: SubjectTrackerConfig;

  constructor(cfg: Partial<SubjectTrackerConfig> = {}) {
    this.cfg = { ...DEFAULT_TRACKER_CONFIG, ...cfg };
    this.cfg.subject_roi = validateSubjectRegion(cfg.subject_roi);
  }

  get currentTrackId(): string | null {
    return this.trackId;
  }

  reset(): void {
    this.trackId = null;
    this.last = null;
    this.missedFrames = 0;
  }

  select(candidates: Candidate[]): SubjectSelection {
    const personCount = candidates.length;
    const eligible = candidates.map((c, i) => ({ c, i })).filter(({ c }) => inSubjectRegion(c, this.cfg.subject_roi));
    if (!eligible.length) {
      this.missedFrames++;
      if (this.missedFrames > this.cfg.lost_after_frames) {
        this.trackId = null;
        this.last = null;
      }
      return { index: null, track_id: this.trackId, ambiguous: false, track_changed: false, person_count: personCount };
    }
    this.missedFrames = 0;

    const previousId = this.trackId;
    const byArea = [...eligible].sort((a, b) => b.c.bbox.area - a.c.bbox.area);
    let chosen = byArea[0];
    let ambiguous = false;

    if (this.last) {
      const scored = eligible.map(({ c, i }) => ({ c, i, d: Math.hypot(c.bbox.cx - this.last!.cx, c.bbox.cy - this.last!.cy) }))
        .sort((a, b) => a.d - b.d);
      const nearest = scored[0];
      if (nearest.d <= this.cfg.max_centroid_jump) {
        chosen = nearest;
        // Ambiguity: another person of comparable size also near the previous track position.
        const competitor = scored.slice(1).find((s) => s.c.bbox.area >= this.cfg.competing_area_ratio * nearest.c.bbox.area && s.d <= this.cfg.max_centroid_jump * 1.5);
        if (competitor) ambiguous = true;
      } else {
        // Track jumped: identity cannot be preserved confidently.
        ambiguous = eligible.length > 1;
        if (!ambiguous) this.startNewTrack();
      }
    } else if (byArea.length > 1 && byArea[1].c.bbox.area >= this.cfg.competing_area_ratio * byArea[0].c.bbox.area) {
      ambiguous = true;
    }

    // An ambiguous detection must not establish or drag the selected track onto a reflection.
    if (ambiguous) return { index: null, track_id: this.trackId, ambiguous: true, track_changed: false, person_count: personCount };

    if (this.trackId === null) this.startNewTrack();
    this.last = { cx: chosen.c.bbox.cx, cy: chosen.c.bbox.cy, area: chosen.c.bbox.area };
    return { index: chosen.i, track_id: this.trackId, ambiguous, track_changed: previousId !== this.trackId && this.trackSeq > 1, person_count: personCount };
  }

  private startNewTrack(): void {
    this.trackSeq++;
    this.trackId = `track-${this.trackSeq}`;
  }
}
