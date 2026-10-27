import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/body_signature.json';
import { bodySignature, signatureDistance } from './body_signature';
import { PinnedSubjectTracker } from './pinned_subject_tracker';
import { SubjectTracker } from './subject_tracker';
import type { Candidate } from './types';
import { AppearanceGallery } from './appearance';

type Fx = { cases: { world: { x: number; y: number; z: number }[]; visibility: number[]; signature: (number | null)[] }[]; distances: (number | null)[][] };
const fx = fixture as unknown as Fx;

describe('body signature (parity with Python)', () => {
  it('matches the shared fixture', () => {
    const sigs = fx.cases.map((c) => bodySignature(c.world, c.visibility)!);
    sigs.forEach((s, k) => s.forEach((v, j) => {
      const want = fx.cases[k].signature[j];
      if (want === null) expect(Number.isNaN(v)).toBe(true);
      else expect(v).toBeCloseTo(want, 6);
    }));
    for (let a = 0; a < sigs.length; a++) for (let b = 0; b < sigs.length; b++) {
      const want = fx.distances[a][b];
      const got = signatureDistance(sigs[a], sigs[b]);
      if (want === null) expect(got).toBeNull();
      else expect(got).toBeCloseTo(want, 6);
    }
  });
});

/** A standing person centred at (cx, cy) with height h; `scale` stretches the limbs (a different build). */
function person(cx: number, cy: number, h = 0.5, scale = 1): Candidate {
  const pts: [number, number][] = new Array(33).fill(0).map(() => [cx, cy]);
  const set = (i: number, dx: number, dy: number) => { pts[i] = [cx + dx * h, cy + dy * h]; };
  set(0, 0, -0.45); set(11, -0.1, -0.3); set(12, 0.1, -0.3); set(13, -0.12, -0.15 * scale); set(14, 0.12, -0.15 * scale);
  set(15, -0.13, 0); set(16, 0.13, 0); set(23, -0.07, 0); set(24, 0.07, 0); set(25, -0.07, 0.25 * scale); set(26, 0.07, 0.25 * scale);
  set(27, -0.07, 0.5); set(28, 0.07, 0.5);
  const normalized = pts.map(([x, y], id) => ({ id, x, y, z: 0, visibility: 0.99 }));
  const world = pts.map(([x, y], id) => ({ id, x: (x - cx) / h, y: (y - cy) / h, z: 0, confidence: 0.99 }));
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
  return { normalized, world, confidence: 0.99, bbox: { x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } };
}

describe('PinnedSubjectTracker', () => {
  it('follows the tapped person even when someone larger is in view', () => {
    const t = new PinnedSubjectTracker(new SubjectTracker());
    t.pin({ x: 0.3, y: 0.5 });
    let sel = t.select([person(0.7, 0.5, 0.7), person(0.3, 0.5, 0.4)]);
    expect(sel.index).toBe(1);
    expect(sel.track_changed).toBe(true);
    for (let k = 1; k <= 5; k++) {
      sel = t.select([person(0.7, 0.5, 0.7), person(0.3 + 0.01 * k, 0.5, 0.4)]);
      expect(sel.index).toBe(1);
      expect(sel.identity_method).toBe('pinned');
      expect(sel.track_id).toBe('pinned-1');
    }
  });

  it('pauses during a crossing instead of guessing', () => {
    const t = new PinnedSubjectTracker(new SubjectTracker());
    t.pin({ x: 0.3, y: 0.5 });
    t.select([person(0.3, 0.5, 0.5)]);
    const sel = t.select([person(0.31, 0.5, 0.5), person(0.33, 0.5, 0.5)]);
    expect(sel.index).toBeNull();
    expect(sel.ambiguous).toBe(true);
    expect(t.status.state).toBe('uncertain');
  });

  it('re-acquires only near the last position and never jumps to a far person', () => {
    const t = new PinnedSubjectTracker(new SubjectTracker());
    t.pin({ x: 0.3, y: 0.5 });
    t.select([person(0.3, 0.5, 0.5)]);
    expect(t.select([]).index).toBeNull();
    expect(t.status.state).toBe('searching');
    expect(t.select([person(0.85, 0.5, 0.5)]).index).toBeNull();   // someone far away is not taken
    const back = t.select([person(0.85, 0.5, 0.5), person(0.45, 0.5, 0.5)]); // no box overlap, but within the radius
    expect(back.index).toBe(1);
    expect(back.identity_method).toBe('reacquired');
  });

  it('rules out a clearly different build once the proportions are learned', () => {
    const t = new PinnedSubjectTracker(new SubjectTracker());
    t.pin({ x: 0.3, y: 0.5 });
    for (let k = 0; k < 12; k++) t.select([person(0.3, 0.5, 0.5)]);   // clean frames teach the signature
    expect(t.status.signature_samples).toBeGreaterThanOrEqual(10);
    t.select([]);                                                       // lost for a frame
    const other = t.select([person(0.32, 0.5, 0.5, 1.8)]);              // same place, very different limb proportions
    expect(other.index).toBeNull();
  });

  it('unpinned behaviour is the wrapped tracker unchanged, and a tap on nobody fails cleanly', () => {
    const t = new PinnedSubjectTracker(new SubjectTracker());
    expect(t.select([person(0.5, 0.5)]).index).toBe(0);
    t.pin({ x: 0.05, y: 0.05 });
    for (let k = 0; k < 20; k++) t.select([person(0.6, 0.5, 0.4)]);
    expect(t.status.state).toBe('unpinned');
    expect(t.status.last_error).toMatch(/no person/);
  });

  it('does not apply an unresolved tap to a new camera image after reset', () => {
    const t = new PinnedSubjectTracker(new SubjectTracker());
    t.pin({ x: 0.3, y: 0.5 });
    t.reset();
    expect(t.status.state).toBe('unpinned');
    t.select([person(0.3, 0.5)]);
    expect(t.pinned).toBe(false);
    t.pin({ x: 0.3, y: 0.5 }); t.select([person(0.3, 0.5)]);
    const subject = t.status.subject_id;
    t.pin({ x: 0.8, y: 0.5 }); t.reset();
    const selected = t.select([person(0.3, 0.5), person(0.8, 0.5)]);
    expect(selected.index).toBe(0);
    expect(t.status.subject_id).toBe(subject);
  });
});

describe('PinnedSubjectTracker appearance re-identification', () => {
  const emb = (seed: number, noise = 0) => Float32Array.from({ length: 16 }, (_, k) => Math.sin(seed * 7.1 + k) + noise * Math.cos(k * 3.3 + seed));
  const A = emb(1);
  const B = emb(2);

  /** Pin at x=0.3 and feed clean frames, answering gallery requests with A's look. */
  function pinnedWithGallery() {
    const t = new PinnedSubjectTracker(new SubjectTracker());
    t.pin({ x: 0.3, y: 0.5 });
    for (let k = 0; k < 40; k++) {
      t.select([person(0.3, 0.5, 0.5)]);
      const req = t.appearanceRequest();
      if (req?.purpose === 'gallery') t.provideAppearance(req, req.boxes.map(() => A));
    }
    expect(t.status.appearance_samples).toBeGreaterThanOrEqual(5);
    return t;
  }

  it.each(['repin', 'unpin', 'reset'] as const)('rejects delayed gallery results across %s and accepts a fresh request once', (boundary) => {
    const t = new PinnedSubjectTracker(new SubjectTracker());
    t.pin({ x: 0.3, y: 0.5 }); t.select([person(0.3, 0.5)]);
    const old = t.appearanceRequest()!;
    if (boundary === 'reset') t.reset();
    else {
      if (boundary === 'unpin') t.unpin();
      t.pin({ x: 0.7, y: 0.5 });
      // Even while a new tap waits for a detection, the old identity's work is invalid.
      t.provideAppearance(old, [A]);
      expect(t.status.appearance_samples).toBe(0);
      expect(t.appearanceRequest()).toBeNull();
    }
    t.select([person(boundary === 'reset' ? 0.3 : 0.7, 0.5)]);
    t.provideAppearance(old, [A]);
    expect(t.status.appearance_samples).toBe(0);
    const fresh = t.appearanceRequest()!;
    expect(fresh.generation).toBeGreaterThan(old.generation);
    t.provideAppearance(fresh, [B]); t.provideAppearance(fresh, [B]);
    expect(t.status.appearance_samples).toBe(1);
  });

  it.each(['repin', 'reset'] as const)('rejects delayed resolution across %s and clears old crossing evidence', (boundary) => {
    const t = pinnedWithGallery();
    const crossing = () => [person(0.31, 0.5), person(0.33, 0.5)];
    t.select(crossing());
    const old = t.appearanceRequest()!;
    t.provideAppearance(old, [B, A]);
    if (boundary === 'reset') t.reset();
    else { t.pin({ x: 0.3, y: 0.5 }); t.select([person(0.3, 0.5)]); }
    t.provideAppearance(old, [B, A]);
    expect(t.select(crossing()).ambiguous).toBe(true);
  });

  it('drops old frames and out-of-order resolution instead of replacing fresh evidence', () => {
    const t = pinnedWithGallery();
    const crossing = () => [person(0.31, 0.5), person(0.33, 0.5)];
    t.select(crossing()); const older = t.appearanceRequest()!;
    t.select(crossing()); t.select(crossing()); const newer = t.appearanceRequest()!;
    t.provideAppearance(newer, [B, A]); t.provideAppearance(older, [A, B]);
    expect(t.select(crossing()).index).toBe(1);
    t.reset(); t.select(crossing()); const expired = t.appearanceRequest()!;
    for (let i = 0; i < 7; i++) t.select(crossing());
    t.provideAppearance(expired, [B, A]);
    expect(t.select(crossing()).ambiguous).toBe(true);
  });

  it('does not contaminate the appearance gallery with empty, non-finite or incompatible embeddings', () => {
    const gallery = new AppearanceGallery();
    for (const e of [new Float32Array(), new Float32Array(16), Float32Array.of(NaN), Float32Array.of(Infinity)]) gallery.add(e);
    expect(gallery.size).toBe(0);
    gallery.add(A); gallery.add(Float32Array.of(1));
    expect(gallery.size).toBe(1);
    expect(gallery.similarity(Float32Array.of(1))).toBeNull();
    expect(gallery.similarity(A)).toBeCloseTo(1, 6);
  });

  it('resolves a crossing when the pinned look clearly matches one of the people', () => {
    const t = pinnedWithGallery();
    const crossing = () => [person(0.31, 0.5, 0.5), person(0.33, 0.5, 0.5)];
    expect(t.select(crossing()).ambiguous).toBe(true);
    const req = t.appearanceRequest();
    expect(req?.purpose).toBe('resolve');
    t.provideAppearance(req!, [B, emb(1, 0.05)]);          // second box looks like the pinned athlete
    const sel = t.select(crossing());
    expect(sel.index).toBe(1);
    expect(sel.identity_method).toBe('appearance');
  });

  it('stays paused when the looks are too similar to decide', () => {
    const t = pinnedWithGallery();
    const crossing = () => [person(0.31, 0.5, 0.5), person(0.33, 0.5, 0.5)];
    t.select(crossing());
    const req = t.appearanceRequest()!;
    t.provideAppearance(req, [emb(1, 0.05), emb(1, 0.06)]); // both look like the athlete: no decisive gap
    expect(t.select(crossing()).ambiguous).toBe(true);
  });

  it('re-finds the athlete anywhere by appearance, but only when every visible person was compared', () => {
    const t = pinnedWithGallery();
    t.select([]);                                            // athlete leaves
    const far = () => [person(0.85, 0.5, 0.5), person(0.6, 0.5, 0.5)];
    expect(t.select(far()).index).toBeNull();
    let req = t.appearanceRequest()!;
    t.provideAppearance(req, [emb(1, 0.02)]);                // only the first person was compared
    expect(t.select(far()).index).toBeNull();
    t.select(far());                                         // requests are rate-limited to every 2nd frame
    req = t.appearanceRequest()!;
    t.provideAppearance(req, [emb(1, 0.02), B]);             // both compared; the far one is clearly the athlete
    const sel = t.select(far());
    expect(sel.index).toBe(0);
    expect(sel.identity_method).toBe('appearance');
  });
});
