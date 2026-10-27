import { describe, expect, it } from 'vitest';
import type { FeatureSpec, FeatureValue, PhaseGraph } from '@apexformz/contracts';
import type { TemporalUpdate } from '@apexformz/analysis';
import { guidedPhase, guidedPhaseEnd } from './guided';

const graph: PhaseGraph = {
  id: 'g', movement_id: 'stroke', kind: 'dynamic_sequence', initial: 'ready', terminal: ['recovery'], validation_status: 'provisional',
  phases: [
    { id: 'ready', name: 'Ready', kind: 'rest', enter: [{ feature: 'stillness', op: 'lt', value: 0.01 }], cue_allowed: true, contact_evidence: 'none', min_duration_ms: 100 },
    { id: 'prepare', name: 'Prepare', kind: 'preparation', enter: [{ feature: 'wrist_height', op: 'lt', value: 0.1 }], cue_allowed: false, contact_evidence: 'none', min_duration_ms: 100 },
    { id: 'swing', name: 'Swing', kind: 'action', enter: [{ feature: 'velocity', op: 'abs_gt', value: 180 }, { feature: 'elbow', op: 'gt', value: 140 }], cue_allowed: false, contact_evidence: 'none', min_duration_ms: 100 },
    { id: 'recovery', name: 'Recover', kind: 'recovery', enter: [{ feature: 'stillness', op: 'lt', value: 0.01 }], cue_allowed: true, contact_evidence: 'none', min_duration_ms: 100 },
  ], edges: [{ from: 'ready', to: 'prepare' }, { from: 'prepare', to: 'swing' }, { from: 'swing', to: 'recovery' }],
};
const specs = [
  { id: 'stillness', kind: 'stability_variability', params: {} },
  { id: 'velocity', kind: 'angular_velocity', params: {} },
  { id: 'elbow', kind: 'angle_at', params: {} },
  { id: 'wrist_height', kind: 'normalized_distance', params: {} },
] as FeatureSpec[];
const temporal = { state: 'IDLE', phase_id: null } as TemporalUpdate;
const values = (velocity: number) => new Map(Object.entries({ stillness: 0, wrist_height: 0.5, velocity, elbow: 100 }).map(([id, value]) => [id, { valid: true, value, confidence: 1 } as FeatureValue]));

describe('guided dynamic candidate selection', () => {
  it('observes a uniquely supported swing despite wrong preparation height and elbow angle', () => {
    const candidate = guidedPhase(graph, specs, values(250), temporal);
    expect(candidate?.id).toBe('swing');
    expect(candidate?.cue_allowed).toBe(false);
    expect(temporal.state).toBe('IDLE');
    expect(temporal.phase_id).toBeNull();
  });
  it('does not infer a swing from static posture or absent velocity evidence', () => {
    expect(guidedPhase(graph, specs, values(0), temporal)?.id).toBe('ready');
    const missing = values(250); missing.delete('velocity');
    expect(guidedPhase(graph, specs, missing, temporal)?.id).not.toBe('swing');
  });
  it('abstains between multiple kinematically plausible phases instead of guessing one', () => {
    const ambiguous = structuredClone(graph);
    ambiguous.phases.push({ ...ambiguous.phases[2], id: 'other-swing' });
    expect(guidedPhase(ambiguous, specs, values(250), temporal)).toBeNull();
  });
  it('does not overwrite an established recovery/contact/action phase with an assumed phase', () => {
    expect(guidedPhase(graph, specs, values(250), { ...temporal, state: 'EXECUTING', phase_id: 'recovery' })).toBeNull();
  });
  it('requires a distinct observable endpoint and abstains on missing or ambiguous transition evidence', () => {
    expect(guidedPhaseEnd(graph, specs, values(250), 'swing')).toBeNull();
    expect(guidedPhaseEnd(graph, specs, values(0), 'swing')?.id).toBe('recovery');
    const missing = values(0); missing.delete('velocity');
    expect(guidedPhaseEnd(graph, specs, missing, 'swing')).toBeNull();
    const ambiguous = structuredClone(graph);
    ambiguous.phases.push({ ...ambiguous.phases[3], id: 'second-end' });
    ambiguous.edges.push({ from: 'swing', to: 'second-end' });
    expect(guidedPhaseEnd(ambiguous, specs, values(0), 'swing')).toBeNull();
  });
});
