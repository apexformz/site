import { ByteTracker, type ByteTrackConfig, type TrackState } from './bytetrack';
import type { Candidate, SubjectSelection } from './types';
import { inSubjectRegion, validateSubjectRegion, type SubjectRegion } from './subject_tracker';

/** Common selector contract implemented by SubjectTracker (centroid heuristic) and ByteSubjectTracker. */
export interface SubjectSelector {
  readonly currentTrackId: string | null;
  select(candidates: Candidate[]): SubjectSelection;
  reset(): void;
}

export interface ByteSubjectConfig extends Partial<ByteTrackConfig> {
  /** Another tracked person with at least this fraction of the subject's box area and overlapping/adjacent => ambiguous. */
  competing_area_ratio?: number;
  /** Centre distance (normalized) under which two persons are considered competing. */
  competing_distance?: number;
  subject_roi?: SubjectRegion;
}

/**
 * Subject selection on top of ByteTrack: identity comes from the Kalman/IoU
 * tracker instead of a centroid heuristic, so brief occlusions and crossing
 * bystanders do not swap the athlete. Ambiguity is still surfaced (TRD 02):
 * when a comparable second person is near the subject, criterion feedback must freeze.
 */
export class ByteSubjectTracker implements SubjectSelector {
  private tracker: ByteTracker;
  private subjectId: string | null = null;
  private lastSeen = 0;
  private frame = 0;
  private readonly competingArea: number;
  private readonly competingDistance: number;
  private readonly lostAfter: number;
  private readonly roi?: SubjectRegion;

  constructor(cfg: ByteSubjectConfig = {}) {
    this.tracker = new ByteTracker(cfg);
    this.competingArea = cfg.competing_area_ratio ?? 0.6;
    this.competingDistance = cfg.competing_distance ?? 0.35;
    this.lostAfter = cfg.trackBuffer ?? 30;
    this.roi = validateSubjectRegion(cfg.subject_roi);
  }

  get currentTrackId(): string | null {
    return this.subjectId;
  }

  reset(): void {
    this.tracker.reset();
    this.subjectId = null;
    this.frame = 0;
  }

  select(candidates: Candidate[]): SubjectSelection {
    this.frame++;
    const eligible = candidates.map((c, i) => ({ c, i })).filter(({ c }) => inSubjectRegion(c, this.roi));
    const tracks = this.tracker.update(eligible.map(({ c, i }) => ({ box: [c.bbox.x0, c.bbox.y0, c.bbox.x1, c.bbox.y1] as [number, number, number, number], score: Math.max(0.11, c.confidence), ref: i })));
    const initialCandidates = [...eligible].sort((a, b) => b.c.bbox.area - a.c.bbox.area);
    if (this.subjectId === null && initialCandidates.length > 1 && initialCandidates[1].c.bbox.area >= this.competingArea * initialCandidates[0].c.bbox.area) {
      return { index: null, track_id: null, ambiguous: true, track_changed: false, person_count: candidates.length };
    }
    const byId = new Map(tracks.map((t) => [t.id, t]));
    let subject: TrackState | undefined = this.subjectId ? byId.get(this.subjectId) : undefined;
    let trackChanged = false;

    if (!subject) {
      if (this.subjectId && this.frame - this.lastSeen <= this.lostAfter) {
        // Subject temporarily unmatched: do not switch to someone else.
        return { index: null, track_id: this.subjectId, ambiguous: false, track_changed: false, person_count: candidates.length };
      }
      // Pick the largest confirmed track as the new subject.
      subject = [...tracks].sort((a, b) => area(b) - area(a))[0];
      if (!subject) return { index: null, track_id: this.subjectId, ambiguous: false, track_changed: false, person_count: candidates.length };
      if (eligible.some(({ c, i }) => i !== subject!.ref && c.bbox.area >= this.competingArea * area(subject!))) {
        return { index: null, track_id: this.subjectId, ambiguous: true, track_changed: false, person_count: candidates.length };
      }
      trackChanged = this.subjectId !== null && this.subjectId !== subject.id;
      this.subjectId = subject.id;
    }
    this.lastSeen = this.frame;
    const idx = subject.ref as number;
    const sArea = area(subject);
    const sc = centre(subject.box);
    const ambiguous = eligible.some(({ c, i }) => {
      if (i === idx) return false;
      return c.bbox.area >= this.competingArea * sArea && Math.hypot(c.bbox.cx - sc[0], c.bbox.cy - sc[1]) <= this.competingDistance;
    });
    return { index: ambiguous ? null : idx, track_id: subject.id, ambiguous, track_changed: trackChanged, person_count: candidates.length };
  }
}

function area(t: TrackState): number {
  return Math.max(0, t.box[2] - t.box[0]) * Math.max(0, t.box[3] - t.box[1]);
}

function centre(b: [number, number, number, number]): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}
