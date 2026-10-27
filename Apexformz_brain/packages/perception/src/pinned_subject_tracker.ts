import type { Candidate, SubjectSelection } from './types';
import type { SubjectSelector } from './byte_subject_tracker';
import { bodySignature, RunningSignature, signatureDistance } from './body_signature';
import { AppearanceGallery } from './appearance';

/**
 * Tap-to-pin subject selection (sport-agnostic).
 *
 * The user taps the athlete. From then on that person is followed, whatever their size, by motion
 * continuity (overlap with a velocity-predicted box). Body proportions only rule out clearly different
 * builds. Nothing here guesses:
 * - Crossings, where another comparable person overlaps the pinned box, pause the analysis ("uncertain").
 * - A lost athlete is re-acquired only near the last known position, when exactly one plausible person is
 *   there and is not ruled out by proportions.
 * - Otherwise the tracker keeps searching and the UI asks for a re-tap.
 * While nobody is pinned, the wrapped tracker decides exactly as before.
 */
export type PinState = 'unpinned' | 'pending' | 'tracking' | 'uncertain' | 'searching';

export interface PinStatus {
  state: PinState;
  subject_id: string | null;
  /** Clean body-proportion samples collected for the pinned person (veto active from 10). */
  signature_samples: number;
  /** Appearance samples of the pinned person (appearance decides from appearance_min_gallery). */
  appearance_samples: number;
  lost_frames: number;
  last_error: string | null;
}

export interface PinnedTrackerConfig {
  /** Minimum overlap with the predicted box to continue the pinned track. */
  link_iou: number;
  /** The best continuation must beat the second by this factor, otherwise it is a crossing. */
  link_ratio: number;
  /** Another person at least this fraction of the pinned person's area, overlapping them, makes the frame uncertain. */
  competing_area_ratio: number;
  /** Proportion distance above which a person is ruled out (measured: 1.4 % false rule-outs of the athlete). */
  proportion_veto: number;
  /** Appearance similarities must differ by at least this to decide a crossing or a re-find (measured 97.6-98.4 % correct). */
  appearance_margin: number;
  /** Minimum appearance similarity to re-find the athlete away from their last position (measured: 0.6 % of other people pass). */
  appearance_accept: number;
  /** Minimum appearance similarity for the person chosen in a crossing. */
  appearance_crossing_min: number;
  /** Appearance evidence is used for at most this many frames after it was computed. */
  appearance_max_age_frames: number;
  /** Clean gallery samples needed before appearance may decide. */
  appearance_min_gallery: number;
  /** Max normalized centre distance from the last known position for re-acquisition. */
  reacquire_radius: number;
  /** Frames a tap may wait for a detection under the finger. */
  pin_wait_frames: number;
  /** Max normalized distance from the tap to a body landmark when no box contains the tap. */
  tap_radius: number;
  min_visibility: number;
}

export const DEFAULT_PINNED_CONFIG: PinnedTrackerConfig = {
  link_iou: 0.25,
  link_ratio: 1.5,
  competing_area_ratio: 0.6,
  proportion_veto: 0.3,
  appearance_margin: 0.1,
  appearance_accept: 0.85,
  appearance_crossing_min: 0.75,
  appearance_max_age_frames: 6,
  appearance_min_gallery: 5,
  reacquire_radius: 0.25,
  pin_wait_frames: 15,
  tap_radius: 0.08,
  min_visibility: 0.5,
};

type Box = Candidate['bbox'];

/** Crops the worker should embed for the tracker (normalized boxes of the frame just selected). */
export interface AppearanceRequest {
  readonly request_id: number;
  readonly generation: number;
  readonly subject_id: string;
  readonly purpose: 'gallery' | 'resolve';
  readonly frame: number;
  readonly boxes: Box[];
}

function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const u = a.area + b.area - ix;
  return u > 0 ? ix / u : 0;
}

function shifted(b: Box, dx: number, dy: number): Box {
  return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy, area: b.area, cx: b.cx + dx, cy: b.cy + dy };
}

export function candidateSignature(c: Candidate, minVisibility = 0.5): number[] | null {
  if (!c.world || !c.world.length) return null;
  const world = c.world.map((w) => (w ? { x: w.x, y: w.y, z: w.z } : undefined));
  const vis = c.normalized.map((l) => l?.visibility ?? l?.presence ?? 0);
  return bodySignature(world, vis, minVisibility);
}

export class PinnedSubjectTracker implements SubjectSelector {
  private readonly cfg: PinnedTrackerConfig;
  private pending: { x: number; y: number; waited: number } | null = null;
  private subjectId: string | null = null;
  private seq = 0;
  private box: Box | null = null;
  private vx = 0;
  private vy = 0;
  private lost = 0;
  private state: PinState = 'unpinned';
  private lastError: string | null = null;
  private signature = new RunningSignature();
  private gallery = new AppearanceGallery();
  private evidence: { frame: number; items: { bbox: Box; sim: number }[] } | null = null;
  private frameNo = 0;
  private lastBoxes: Box[] = [];
  private lastChosen: number | null = null;
  private lastClean = false;
  private lastGalleryFrame = -1e9;
  private lastResolveFrame = -1e9;
  private appearanceGeneration = 0;
  private appearanceSequence = 0;
  private appearanceRequests = new Map<number, AppearanceRequest>();

  constructor(private readonly base: SubjectSelector, cfg: Partial<PinnedTrackerConfig> = {}) {
    this.cfg = { ...DEFAULT_PINNED_CONFIG, ...cfg };
  }

  /** Pin the person under a normalized image point (raw, un-mirrored camera coordinates); null unpins. */
  pin(point: { x: number; y: number } | null): PinStatus {
    if (!point) {
      this.unpin();
      return this.status;
    }
    if (![point.x, point.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('pin point must be normalized (0..1)');
    this.invalidateAppearance();
    this.pending = { x: point.x, y: point.y, waited: 0 };
    this.lastError = null;
    if (this.state === 'unpinned') this.state = 'pending';
    return this.status;
  }

  unpin(): void {
    this.invalidateAppearance();
    this.pending = null;
    this.subjectId = null;
    this.box = null;
    this.vx = this.vy = 0;
    this.lost = 0;
    this.signature = new RunningSignature();
    this.gallery = new AppearanceGallery();
    this.evidence = null;
    this.state = 'unpinned';
    this.base.reset();
  }

  get status(): PinStatus {
    return { state: this.state, subject_id: this.subjectId, signature_samples: this.signature.count, appearance_samples: this.gallery.size,
      lost_frames: this.lost, last_error: this.lastError };
  }

  get currentTrackId(): string | null {
    return this.subjectId ?? this.base.currentTrackId;
  }

  get pinned(): boolean {
    return this.subjectId !== null;
  }

  /** Session boundaries reset motion, but a pinned identity stays pinned (re-acquired near its last position). */
  reset(): void {
    this.invalidateAppearance();
    this.pending = null; // an unresolved tap belongs to the previous camera image
    this.lastBoxes = [];
    this.lastChosen = null;
    this.lastClean = false;
    this.base.reset();
    this.vx = this.vy = 0;
    this.state = this.subjectId ? 'searching' : 'unpinned';
  }

  /**
   * Which person crops to embed for the frame just selected, if any: the pinned person on clean frames (gallery),
   * or every candidate while crossing or searching (resolve). The worker embeds them off-thread, then calls provideAppearance.
   */
  appearanceRequest(): AppearanceRequest | null {
    if (!this.subjectId || this.pending || !this.lastBoxes.length) return null;
    if ((this.state === 'uncertain' || this.state === 'searching') && this.gallery.size >= this.cfg.appearance_min_gallery
        && this.frameNo - this.lastResolveFrame >= 2) {
      this.lastResolveFrame = this.frameNo;
      return this.issueAppearance('resolve', this.lastBoxes.slice(0, 4));
    }
    if (this.state === 'tracking' && this.lastChosen !== null && this.lastClean
        && this.frameNo - this.lastGalleryFrame >= (this.gallery.size < 20 ? 5 : 30)) {
      this.lastGalleryFrame = this.frameNo;
      return this.issueAppearance('gallery', [this.lastBoxes[this.lastChosen]]);
    }
    return null;
  }

  /** Embeddings for an earlier appearanceRequest, in the same order as its boxes. */
  provideAppearance(request: AppearanceRequest, embeddings: Float32Array[]): void {
    if (this.appearanceRequests.get(request.request_id) !== request) return;
    this.appearanceRequests.delete(request.request_id); // a result can be consumed only once
    if (this.pending || request.subject_id !== this.subjectId || request.generation !== this.appearanceGeneration
        || this.frameNo - request.frame > this.cfg.appearance_max_age_frames) return;
    if (request.purpose === 'gallery') {
      request.boxes.forEach((_, k) => { if (embeddings[k]) this.gallery.add(embeddings[k]); });
      return;
    }
    if (this.evidence && request.frame < this.evidence.frame) return;
    const items: { bbox: Box; sim: number }[] = [];
    request.boxes.forEach((bbox, k) => {
      const sim = embeddings[k] ? this.gallery.similarity(embeddings[k]) : null;
      if (sim !== null) items.push({ bbox, sim });
    });
    this.evidence = { frame: request.frame, items };
  }

  private invalidateAppearance(): void {
    this.appearanceGeneration++;
    this.appearanceRequests.clear();
    this.evidence = null;
    this.lastGalleryFrame = this.lastResolveFrame = -1e9;
  }

  private issueAppearance(purpose: AppearanceRequest['purpose'], boxes: Box[]): AppearanceRequest {
    for (const [id, request] of this.appearanceRequests) {
      if (this.frameNo - request.frame > this.cfg.appearance_max_age_frames) this.appearanceRequests.delete(id);
    }
    const request: AppearanceRequest = Object.freeze({ request_id: ++this.appearanceSequence,
      generation: this.appearanceGeneration, subject_id: this.subjectId!, purpose, frame: this.frameNo,
      boxes: boxes.map((box) => ({ ...box })) });
    this.appearanceRequests.set(request.request_id, request);
    return request;
  }

  private appearanceOf(c: Candidate): number | null {
    if (!this.evidence || this.frameNo - this.evidence.frame > this.cfg.appearance_max_age_frames) return null;
    let best: number | null = null;
    let bestOverlap = 0.5;
    for (const it of this.evidence.items) {
      const o = iou(c.bbox, it.bbox);
      if (o >= bestOverlap) { bestOverlap = o; best = it.sim; }
    }
    return best;
  }

  /** The clearly most similar contender, or null unless every contender has evidence and the gap is decisive. */
  private resolveByAppearance(contenders: { c: Candidate; i: number }[], minSimilarity: number): { c: Candidate; i: number; sim: number } | null {
    if (!contenders.length || this.gallery.size < this.cfg.appearance_min_gallery) return null;
    const sims = contenders.map((x) => ({ ...x, sim: this.appearanceOf(x.c) }));
    if (sims.some((x) => x.sim === null)) return null;
    sims.sort((p, q) => (q.sim as number) - (p.sim as number));
    const top = sims[0] as { c: Candidate; i: number; sim: number };
    if (sims.length > 1 && top.sim - (sims[1].sim as number) < this.cfg.appearance_margin) return null;
    return top.sim >= minSimilarity ? top : null;
  }

  select(candidates: Candidate[]): SubjectSelection {
    const personCount = candidates.length;
    this.frameNo++;
    this.lastBoxes = candidates.map((c) => c.bbox);
    this.lastChosen = null;
    this.lastClean = false;
    if (this.pending) {
      const idx = this.pickAt(this.pending, candidates);
      if (idx !== null) return this.startPin(candidates, idx);
      if (++this.pending.waited > this.cfg.pin_wait_frames) {
        this.pending = null;
        this.lastError = 'no person found at the tapped point';
        if (!this.subjectId) this.state = 'unpinned';
      }
    }
    if (!this.subjectId || !this.box) return this.base.select(candidates);

    const ref = this.signature.ready ? this.signature.value() : null;
    const allowed = candidates.map((c, i) => ({ c, i })).filter(({ c }) => {
      if (!ref) return true;
      const sig = candidateSignature(c, this.cfg.min_visibility);
      const d = sig ? signatureDistance(ref, sig) : null;
      return d === null || d <= this.cfg.proportion_veto;
    });
    const predicted = shifted(this.box, this.vx, this.vy);
    const scored = allowed.map((a) => ({ ...a, o: iou(a.c.bbox, predicted) })).sort((p, q) => q.o - p.o);
    const best = scored[0];
    const second = scored[1];

    if (best && best.o >= this.cfg.link_iou) {
      const separable = !second || second.o < this.cfg.link_iou || best.o >= this.cfg.link_ratio * second.o;
      const competitor = scored.slice(1).find((s) => s.c.bbox.area >= this.cfg.competing_area_ratio * best.c.bbox.area && iou(s.c.bbox, best.c.bbox) > 0.1);
      if (!separable || competitor) {
        // crossing: appearance may decide between the overlapping people when the gap is decisive
        const contenders = scored.filter((s) => s === best || s.o >= this.cfg.link_iou || iou(s.c.bbox, best.c.bbox) > 0.1);
        const pick = this.resolveByAppearance(contenders, this.cfg.appearance_crossing_min);
        if (pick) return this.accept(pick.c, pick.i, candidates, personCount, 'appearance', pick.sim);
        this.state = 'uncertain';
        return { index: null, track_id: this.subjectId, ambiguous: true, track_changed: false, person_count: personCount };
      }
      return this.accept(best.c, best.i, candidates, personCount, 'pinned', best.o);
    }

    // Lost: appearance may re-find the athlete anywhere, if every visible person was compared and one clearly matches.
    this.lost++;
    this.state = 'searching';
    const byLook = this.resolveByAppearance(allowed.filter(({ c }) => c.bbox.area >= 0.25 * this.box!.area), this.cfg.appearance_accept);
    if (byLook) return this.accept(byLook.c, byLook.i, candidates, personCount, 'appearance', byLook.sim);
    // otherwise re-acquire only an unambiguous, plausible person near the last known position
    const near = allowed.filter(({ c }) => Math.hypot(c.bbox.cx - predicted.cx, c.bbox.cy - predicted.cy) <= this.cfg.reacquire_radius
      && c.bbox.area >= 0.4 * this.box!.area && c.bbox.area <= 2.5 * this.box!.area);
    if (near.length === 1) {
      const only = near[0];
      const rival = candidates.some((c, i) => i !== only.i && c.bbox.area >= this.cfg.competing_area_ratio * only.c.bbox.area
        && Math.hypot(c.bbox.cx - only.c.bbox.cx, c.bbox.cy - only.c.bbox.cy) <= this.cfg.reacquire_radius);
      if (!rival) return this.accept(only.c, only.i, candidates, personCount, 'reacquired', null);
    }
    return { index: null, track_id: this.subjectId, ambiguous: false, track_changed: false, person_count: personCount };
  }

  private pickAt(p: { x: number; y: number }, candidates: Candidate[]): number | null {
    let bestIdx: number | null = null;
    let bestD = Infinity;
    candidates.forEach((c, i) => {
      for (const l of c.normalized) {
        if (!l || (l.visibility ?? l.presence ?? 1) < this.cfg.min_visibility) continue;
        const d = Math.hypot(l.x - p.x, l.y - p.y);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
    });
    if (bestIdx === null) return null;
    const inside = candidates.filter((c) => p.x >= c.bbox.x0 - 0.03 && p.x <= c.bbox.x1 + 0.03 && p.y >= c.bbox.y0 - 0.03 && p.y <= c.bbox.y1 + 0.03);
    return inside.length || bestD <= this.cfg.tap_radius ? bestIdx : null;
  }

  private startPin(candidates: Candidate[], idx: number): SubjectSelection {
    this.invalidateAppearance();
    this.pending = null;
    this.seq++;
    this.subjectId = `pinned-${this.seq}`;
    this.signature = new RunningSignature();
    this.gallery = new AppearanceGallery();
    this.evidence = null;
    this.box = null;
    this.vx = this.vy = 0;
    const sel = this.accept(candidates[idx], idx, candidates, candidates.length, 'pinned', 1);
    return { ...sel, track_changed: true };
  }

  private accept(c: Candidate, i: number, candidates: Candidate[], personCount: number, method: 'pinned' | 'reacquired' | 'appearance', score: number | null): SubjectSelection {
    if (this.box && method === 'pinned') {
      this.vx = 0.5 * this.vx + 0.5 * (c.bbox.cx - this.box.cx);
      this.vy = 0.5 * this.vy + 0.5 * (c.bbox.cy - this.box.cy);
    }
    this.box = c.bbox;
    this.lost = 0;
    this.state = 'tracking';
    // learn proportions only from clean frames: nobody else near the pinned person
    const clean = !candidates.some((o, j) => j !== i && Math.hypot(o.bbox.cx - c.bbox.cx, o.bbox.cy - c.bbox.cy) < 0.3);
    if (clean) this.signature.add(candidateSignature(c, this.cfg.min_visibility));
    if (method !== 'pinned') this.vx = this.vy = 0; // a jump after a crossing or a re-find carries no velocity
    this.lastChosen = i;
    this.lastClean = clean;
    return { index: i, track_id: this.subjectId, ambiguous: false, track_changed: false, person_count: personCount,
      identity_method: method, identity_score: score };
  }
}
