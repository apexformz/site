import { describe, expect, it } from 'vitest';
import type { PhaseGraph } from '@apexformz/contracts';
import type { BrainTick } from '@apexformz/runtime';
import { dynamicProgress } from './dynamicProgress';

const graph = { initial: 'ready', phases: [{ id: 'ready', name: 'Ready', kind: 'rest' }, { id: 'swing', name: 'Forward swing', kind: 'action' }] } as PhaseGraph;
const tick = (change: Partial<BrainTick> = {}) => ({ timestamp_ms: 1000, quality: { ok: true, reasons: [] }, signal: { dropped: false, track_changed: false, time_gap: false }, temporal: { state: 'IDLE', phase_id: null, execution_phases: [], completed: false }, ...change }) as BrainTick;

describe('dynamic progress presentation', () => {
  it('shows reference alignment as progress, never as accuracy or a recognized repetition', () => {
    const current = tick({ dynamic_reference: { status: 'active', current: true, cue_allowed: false, attempt_id: 'a', progress: .4, reference_id: 'r', reason: null, complete_capture: false } });
    expect(dynamicProgress(graph, current, true)).toMatchObject({ title: 'Comparing with the selected recording', state: 'observing', activePhase: null, observedPhases: [] });
    expect(dynamicProgress(graph, current, true).description).toContain('Reference position: 40%');
    const ended = { ...current, dynamic_reference: { ...current.dynamic_reference!, status: 'incomplete' as const, current: false, cue_allowed: true } };
    expect(dynamicProgress(graph, ended, true)).toMatchObject({ title: 'Partial movement reviewed', state: 'reviewing' });
    expect(dynamicProgress(graph, { ...current, dynamic_reference: { ...current.dynamic_reference!, status: 'unavailable', reason: 'VIEW_INVALID' } }, true).description).toContain('available recorded view');
  });
  it('gives an explicit starting step while no movement has been observed', () => {
    expect(dynamicProgress(graph, tick(), true)).toMatchObject({ state: 'waiting', activePhase: null, description: 'Begin with Ready, then move into Forward swing. Return to the starting position and pause briefly after each attempt for feedback.' });
  });
  it('distinguishes missing live measurements from an absent recording', () => {
    const current = tick({ dynamic_reference: { status: 'unavailable', current: false, cue_allowed: false, attempt_id: null, progress: 0, reference_id: null, reason: 'COVERAGE_INSUFFICIENT', complete_capture: false } });
    const result = dynamicProgress(graph, current, true);
    expect(result).toMatchObject({ title: 'Waiting for clearer body measurements', state: 'interrupted' });
    expect(result.description).toContain('current joint measurements');
    expect(result.description).not.toContain('no usable reference');
  });
  it('shows a guided action without claiming a completed repetition', () => {
    const result = dynamicProgress(graph, tick({ guided_attempt: { phase_id: 'swing', since_ms: 750, cue_allowed: false } }), true);
    expect(result).toMatchObject({ state: 'observing', title: 'Following Forward swing', activePhase: 'swing', observedPhases: [], elapsedMs: 250 });
  });
  it('shows a completed attempt review separately from recognized completion', () => {
    const result = dynamicProgress(graph, tick({ guided_completion: { phase_id: 'swing', since_ms: 200, ended_ms: 900, cue_allowed: true } }), true);
    expect(result).toMatchObject({ state: 'reviewing', title: 'Reviewing Forward swing', observedPhases: [], elapsedMs: 700 });
  });
  it('labels a motion attempt without highlighting a phase as recognized', () => {
    expect(dynamicProgress(graph, tick({ guided_attempt: { phase_id: 'swing', since_ms: 500, cue_allowed: false, source: 'motion_bout' } }), true)).toMatchObject({
      state: 'observing', title: 'Analysing attempted swing', activePhase: null, observedPhases: [], elapsedMs: 500,
    });
  });
  it('reviews motion-bout body checks without timing the settling pause or claiming a repetition', () => {
    const completed = tick({ guided_completion: { phase_id: 'swing', since_ms: 200, ended_ms: 1000, cue_allowed: true, source: 'motion_bout' }, assessment: { criteria: [{ meta: { observed_end_ms: 800 } }] } as unknown as NonNullable<BrainTick['assessment']> });
    expect(dynamicProgress(graph, completed, true)).toMatchObject({ state: 'reviewing', title: 'Reviewing your movement attempt', activePhase: null, observedPhases: [], elapsedMs: 600 });
    expect(dynamicProgress(graph, { ...completed, assessment: null }, true).elapsedMs).toBeNull();
  });
  it('clears progress for camera stop, tracking interruption or stale completed guidance', () => {
    const current = tick({ guided_attempt: { phase_id: 'swing', since_ms: 750, cue_allowed: false } });
    expect(dynamicProgress(graph, current, false).activePhase).toBeNull();
    expect(dynamicProgress(graph, { ...current, signal: { ...current.signal, track_changed: true } }, true)).toMatchObject({ state: 'interrupted', activePhase: null });
    expect(dynamicProgress(graph, tick({ guided_completion: { phase_id: 'swing', since_ms: -10000, ended_ms: -9000, cue_allowed: true } }), true).state).toBe('waiting');
  });
});
