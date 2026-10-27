import type { PhaseGraph } from '@apexformz/contracts';
import type { BrainTick } from '@apexformz/runtime';

export interface DynamicProgress {
  title: string;
  description: string;
  activePhase: string | null;
  observedPhases: string[];
  state: 'waiting' | 'observing' | 'reviewing' | 'complete' | 'interrupted';
  elapsedMs: number | null;
}

/** Present observed phase evidence separately from completed movement sequences. */
export function dynamicProgress(graph: PhaseGraph | null, tick: BrainTick | null, live: boolean): DynamicProgress {
  const initial = graph?.phases.find(p => p.id === graph.initial);
  const next = graph?.phases.find(p => p.id !== graph.initial && !['rest', 'hold'].includes(p.kind));
  const waiting: DynamicProgress = { title: 'Ready for the movement', description: `Begin with ${initial?.name ?? 'the starting position'}${next ? `, then move into ${next.name}` : ' and perform the selected sequence'}. Return to the starting position and pause briefly after each attempt for feedback.`, activePhase: null, observedPhases: [], state: 'waiting', elapsedMs: null };
  if (!graph || !tick || !live) return waiting;
  if (!tick.quality.ok || tick.signal.dropped || tick.signal.track_changed || tick.signal.time_gap) return {
    ...waiting, title: 'Waiting for clear movement evidence', description: 'Keep the same athlete fully visible. Movement timing starts again after a tracking interruption.', state: 'interrupted',
  };
  const reference = tick.dynamic_reference;
  if (reference) {
    if (reference.status === 'unavailable' && ['LOW_CONFIDENCE', 'COVERAGE_INSUFFICIENT', 'MISSING_JOINT', 'INSUFFICIENT_HISTORY'].includes(reference.reason ?? '')) return {
      ...waiting, title: 'Waiting for clearer body measurements', description: 'Keep your whole body visible and match the selected camera view. Comparison resumes when enough current joint measurements are reliable.', state: 'interrupted',
    };
    if (reference.status === 'unavailable') return { ...waiting, title: 'Recorded comparison unavailable', description: reference.reason === 'VIEW_INVALID'
      ? 'This camera view has no usable reference for the selected movement. Choose an available recorded view in setup. Reference verdicts are withheld.'
      : reference.reason === 'HANDEDNESS_UNKNOWN' ? 'The recorded comparison needs matching handedness. Check your actual dominant hand and available recordings in setup.'
        : 'The selected movement has no usable reference for this setup. Tracking remains available, but the recording comparison has no verdict.', state: 'waiting' };
    if (reference.status === 'complete' || reference.status === 'incomplete') return { ...waiting, title: reference.status === 'complete' ? 'Recorded sequence reviewed' : 'Partial movement reviewed',
      description: reference.status === 'complete' ? 'Review the comparison checks and corrections for your next attempt. Matching the recorded sequence does not confirm ball contact or a completed squash repetition.'
        : 'The visible movement was compared with a recorded segment. Unobserved parts have no verdict. Return to the starting position and pause before the next attempt.', state: 'reviewing' };
    if (reference.status === 'active') return { ...waiting, title: 'Comparing with the selected recording',
      description: `Reference position: ${Math.round(Math.max(0, Math.min(1, reference.progress ?? 0)) * 100)}%. This is movement progress, not a technique score. Follow the full movement, then pause for feedback.`, state: 'observing' };
    return { ...waiting, title: 'Ready to compare your movement', description: 'Begin from the recorded starting position and perform the selected movement. Keep your whole body visible, then pause briefly for the attempt review.' };
  }
  const temporal = tick.temporal;
  const observedPhases = temporal?.execution_phases.filter(p => p.end_ms !== null).map(p => p.phase_id) ?? [];
  const completion = tick.guided_completion;
  const attempt = tick.guided_attempt;
  const phaseId = attempt?.phase_id ?? temporal?.phase_id ?? completion?.phase_id ?? null;
  const phase = graph.phases.find(p => p.id === phaseId);
  if (temporal?.completed) return { ...waiting, title: 'Movement sequence completed', description: 'Return to the starting position for the next repetition. Technique corrections are shown separately.', activePhase: temporal.phase_id, observedPhases, state: 'complete', elapsedMs: null };
  if (completion && (!attempt || attempt.cue_allowed) && completion.ended_ms <= tick.timestamp_ms && tick.timestamp_ms - completion.ended_ms <= 8000) {
    const reviewed = graph.phases.find(p => p.id === completion.phase_id);
    if (completion.source === 'motion_bout') {
      const ends = tick.assessment?.criteria.map(c => (c as typeof c & { meta?: { observed_end_ms?: unknown } }).meta?.observed_end_ms)
        .filter((value): value is number => typeof value === 'number' && value >= completion.since_ms && value <= completion.ended_ms) ?? [];
      return { ...waiting, title: 'Reviewing your movement attempt', description: 'Review the body-position checks from your attempt. This review does not confirm contact or a completed repetition.', state: 'reviewing', elapsedMs: ends.length ? Math.max(...ends) - completion.since_ms : null };
    }
    return { ...waiting, title: `Reviewing ${reviewed?.name ?? 'the attempted movement'}`, description: 'The observed action has ended. Review the available technique checks before your next attempt.', activePhase: completion.phase_id, observedPhases, state: 'reviewing', elapsedMs: completion.ended_ms - completion.since_ms };
  }
  if (attempt?.source === 'motion_bout') return {
    ...waiting, title: phase?.name.toLowerCase().includes('swing') ? 'Analysing attempted swing' : 'Analysing attempted movement',
    description: 'Tracking your movement attempt. Return to the starting position and pause briefly after each attempt for feedback.',
    state: 'observing', elapsedMs: tick.timestamp_ms - attempt.since_ms,
  };
  if (phase && (attempt || temporal && ['CANDIDATE', 'CONFIRMED', 'EXECUTING'].includes(temporal.state))) return {
    ...waiting, title: `Following ${phase.name}`, description: attempt ? 'Following this part of your attempt. A full repetition is counted only when the movement sequence is observed.' : 'Following the observed sequence. Continue through the next phase; technique checks appear as evidence becomes available.',
    activePhase: phase.id, observedPhases, state: 'observing', elapsedMs: attempt ? tick.timestamp_ms - attempt.since_ms : temporal?.phase_duration_ms ?? null,
  };
  return { ...waiting, observedPhases };
}
