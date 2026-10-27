import { describe, expect, it } from 'vitest';
import type { FeatureValue, PhaseGraph } from '@apexformz/contracts';
import { PhaseSegmenter } from './segmenter';
import { decideOpenSet } from './recognizer';

const ctx = { session_id: 's1', sport_pack_id: 'x', sport_pack_version: '1.0.0', movement_id: 'x.move', model_version: 'heuristic-1.0.0' };

function fv(id: string, value: number | null, valid = value !== null): FeatureValue {
  return { spec_id: id, name: id, value, unit: 'deg', valid, reason: valid ? null : 'MISSING_JOINT', evidence_frame_ids: [], confidence: valid ? 0.9 : null, view_applicability: 'any', coordinate_system: 'body_relative', timestamp_ms: 0 };
}

const lungeGraph: PhaseGraph = {
  id: 'pg', movement_id: 'x.move', kind: 'dynamic_sequence', confirm_hold_ms: 100, abort_timeout_ms: 4000, validation_status: 'provisional',
  phases: [
    { id: 'ready', name: 'r', kind: 'rest', contact_evidence: 'none', min_duration_ms: 100, enter: [{ feature: 'knee', op: 'gt', value: 150 }], hold_ms: 100, cue_allowed: true },
    { id: 'drive', name: 'd', kind: 'action', contact_evidence: 'none', min_duration_ms: 50, max_duration_ms: 1500, enter: [{ feature: 'knee', op: 'lt', value: 140 }], hold_ms: 40, cue_allowed: false },
    { id: 'bottom', name: 'b', kind: 'contact', contact_evidence: 'unobserved', min_duration_ms: 50, max_duration_ms: 1500, enter: [{ feature: 'knee', op: 'lt', value: 120 }], hold_ms: 40 },
    { id: 'recovery', name: 'rec', kind: 'recovery', contact_evidence: 'none', min_duration_ms: 100, max_duration_ms: 3000, enter: [{ feature: 'knee', op: 'gt', value: 150 }], hold_ms: 60, cue_allowed: true },
  ],
  edges: [{ from: 'ready', to: 'drive' }, { from: 'drive', to: 'bottom' }, { from: 'bottom', to: 'recovery' }, { from: 'recovery', to: 'ready' }],
  initial: 'ready', terminal: ['recovery'],
};

function run(seg: PhaseSegmenter, kneeSeries: Array<number | null>, dt = 40, quality = true) {
  const updates = [];
  for (let i = 0; i < kneeSeries.length; i++) {
    const features = new Map([['knee', fv('knee', kneeSeries[i])]]);
    updates.push(seg.update({ frame_id: i, timestamp_ms: i * dt, features, quality_ok: quality }));
  }
  return updates;
}

describe('PhaseSegmenter (dynamic)', () => {
  it('walks IDLE -> CANDIDATE -> CONFIRMED -> EXECUTING -> COMPLETE and emits monotonic events', () => {
    const seg = new PhaseSegmenter(lungeGraph, ctx);
    const series = [...Array(8).fill(170), ...Array(6).fill(130), ...Array(8).fill(100), ...Array(10).fill(165)];
    const ups = run(seg, series);
    const states = ups.map((u) => u.state);
    expect(states[0]).toBe('CANDIDATE');
    expect(states).toContain('CONFIRMED');
    expect(states).toContain('EXECUTING');
    expect(states).toContain('COMPLETE');
    const done = ups.find((u) => u.completed)!;
    expect(done.execution_phases.map((p) => p.phase_id)).toEqual(['ready', 'drive', 'bottom', 'recovery']);
    expect(done.execution_phases.every((p) => p.end_ms !== null)).toBe(true);
    const ids = ups.flatMap((u) => u.events).map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    const bottom = ups.find((u) => u.phase_id === 'bottom')!;
    expect(bottom.contact_evidence).toBe('unobserved');
    expect(bottom.cue_allowed).toBe(false);
  });

  it('requires hold time before transitions (hysteresis) and ignores one-frame blips', () => {
    const seg = new PhaseSegmenter(lungeGraph, ctx);
    const series = [...Array(8).fill(170), 130, 170, 170, 170, 170];
    const ups = run(seg, series);
    expect(ups.some((u) => u.state === 'EXECUTING')).toBe(false);
  });

  it('aborts on a time gap and resets without inventing velocities (G03 core)', () => {
    const seg = new PhaseSegmenter(lungeGraph, ctx);
    run(seg, [...Array(8).fill(170), ...Array(6).fill(130)]);
    expect(seg.currentState).toBe('EXECUTING');
    const u = seg.update({ frame_id: 100, timestamp_ms: 100000, features: new Map([['knee', fv('knee', 130)]]), quality_ok: true, continuity_broken: true });
    expect(u.state).toBe('IDLE');
    expect(u.aborted_reason).toBe('TIME_GAP');
    expect(u.events.some((e) => e.state === 'ABORTED')).toBe(true);
  });

  it('aborts and suppresses when quality is not ok (G05 core)', () => {
    const seg = new PhaseSegmenter(lungeGraph, ctx);
    run(seg, [...Array(8).fill(170), ...Array(6).fill(130)]);
    const u = seg.update({ frame_id: 50, timestamp_ms: 50 * 40, features: new Map([['knee', fv('knee', 130)]]), quality_ok: false, quality_reasons: ['AMBIGUOUS_SUBJECT'] });
    expect(u.aborted_reason).toBe('AMBIGUOUS_SUBJECT');
    expect(u.state).toBe('IDLE');
    expect(u.blocked_reasons).toContain('AMBIGUOUS_SUBJECT');
  });

  it('times out a phase that never progresses', () => {
    const seg = new PhaseSegmenter(lungeGraph, ctx);
    const ups = run(seg, [...Array(8).fill(170), ...Array(60).fill(130)]);
    expect(ups.some((u) => u.aborted_reason === 'PHASE_TIMEOUT')).toBe(true);
  });

  it('goes UNKNOWN when features stay invalid during execution', () => {
    const seg = new PhaseSegmenter(lungeGraph, ctx);
    const ups = run(seg, [...Array(8).fill(170), ...Array(6).fill(130), ...Array(40).fill(null)]);
    expect(ups.some((u) => u.unknown_reason === 'FEATURES_INVALID')).toBe(true);
  });

  it('is idempotent for a repeated frame id', () => {
    const seg = new PhaseSegmenter(lungeGraph, ctx);
    const f = new Map([['knee', fv('knee', 170)]]);
    const a = seg.update({ frame_id: 0, timestamp_ms: 0, features: f, quality_ok: true });
    const b = seg.update({ frame_id: 0, timestamp_ms: 0, features: f, quality_ok: true });
    expect(a.state).toBe(b.state);
    expect(b.events).toHaveLength(0);
  });
});

describe('PhaseSegmenter (static hold)', () => {
  const holdGraph: PhaseGraph = {
    id: 'pgs', movement_id: 'x.move', kind: 'static_hold', confirm_hold_ms: 200, validation_status: 'provisional',
    phases: [{ id: 'hold', name: 'h', kind: 'hold', contact_evidence: 'none', min_duration_ms: 300, enter: [{ feature: 'motion', op: 'lt', value: 0.01 }], hold_ms: 200, cue_allowed: true }],
    edges: [], initial: 'hold', terminal: ['hold'],
  };

  it('confirms after the hold and completes when the hold breaks after min duration', () => {
    const seg = new PhaseSegmenter(holdGraph, ctx);
    const ups = [];
    for (let i = 0; i < 20; i++) ups.push(seg.update({ frame_id: i, timestamp_ms: i * 50, features: new Map([['motion', fv('motion', i < 15 ? 0.001 : 0.05)]]), quality_ok: true }));
    expect(ups[0].state).toBe('CANDIDATE');
    expect(ups[6].state).toBe('CONFIRMED');
    expect(ups[6].execution_id).not.toBeNull();
    const done = ups.find((u) => u.completed)!;
    expect(done).toBeDefined();
    expect(done.ended_phase?.phase_id).toBe('hold');
    expect(done.execution_phases[0].end_ms).not.toBeNull();
  });

  it('drops a candidate that never reaches confirmation', () => {
    const seg = new PhaseSegmenter(holdGraph, ctx);
    const ups = [];
    for (let i = 0; i < 6; i++) ups.push(seg.update({ frame_id: i, timestamp_ms: i * 50, features: new Map([['motion', fv('motion', i < 2 ? 0.001 : 0.05)]]), quality_ok: true }));
    expect(ups.every((u) => u.state !== 'CONFIRMED')).toBe(true);
    expect(ups.at(-1)!.state).toBe('IDLE');
  });
});

describe('open-set decision', () => {
  const model = { model_id: 'tcn', version: '0.0.1' };
  it('uses per-movement thresholds and rejects ambiguous top-2', () => {
    expect(decideOpenSet({ probabilities: { a: 0.9, b: 0.05 }, unknown_probability: 0.05, model }, { a: 0.7, b: 0.7 })).toMatchObject({ movement_id: 'a', unknown: false });
    expect(decideOpenSet({ probabilities: { a: 0.6, b: 0.05 }, unknown_probability: 0.35, model }, { a: 0.7, b: 0.7 })).toMatchObject({ unknown: true, reason: 'BELOW_THRESHOLD' });
    expect(decideOpenSet({ probabilities: { a: 0.46, b: 0.44 }, unknown_probability: 0.1, model }, { a: 0.4, b: 0.4 })).toMatchObject({ unknown: true, reason: 'AMBIGUOUS_TOP2' });
    expect(() => decideOpenSet({ probabilities: { c: 0.9 }, unknown_probability: 0.1, model }, { a: 0.7 })).toThrow(/threshold/);
  });
});
