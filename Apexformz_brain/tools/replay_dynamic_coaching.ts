/** Regression replay of locally recorded poses, preserving source time and quality. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { activeSession, calibration } from '../tests/helpers/packs';
import type { PoseFrame } from '@apexformz/contracts';
import type { BrainTick } from '@apexformz/runtime';
import { currentAssessment, currentFeedback } from '../apps/frontend/src/lib/brain/presentation';
import { createLegacyAdapterState, toLegacyFrameAnalysis } from '@apexformz/brain-client';

async function main() {
  const input = process.env.REPLAY_POSES || 'data/audit/dynamic-investigation/user-backhand-in-progress/poses.jsonl';
  const movement = process.env.REPLAY_MOVEMENT || 'squash.dynamic.0040';
  const output = process.env.REPLAY_OUTPUT || 'data/audit/dynamic-investigation/user-pose-replay.json';
  const source = readFileSync(input, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l)).filter(f => !f._header) as PoseFrame[];
  const results = [];
  for (const hz of [30, 5, 3]) {
    const selected: PoseFrame[] = [];
    for (const f of source) if (!selected.length || f.timestamp_ms - selected.at(-1)!.timestamp_ms >= 1000 / hz) selected.push(f);
    const { rt, sessionId } = await activeSession(['squash'], 'squash', movement,
      { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true }, calibration({ nominal_view: 'front', camera_tilt_deg: null, athlete_context: 'unknown' }));
    const ticks: BrainTick[] = [];
    const first = selected[0].timestamp_ms;
    for (const f of selected) {
      const frame = { ...f, session_id: sessionId, timestamp_ms: f.timestamp_ms - first };
      const tick = rt.process(frame, frame.timestamp_ms);
      if (tick) ticks.push(tick);
    }
    const criteria = ticks.flatMap(t => t.assessment?.criteria || []);
    const intervals = selected.slice(1).map((frame, i) => frame.timestamp_ms - selected[i].timestamp_ms).sort((a, b) => a - b);
    const count = <T>(items: T[], key: (v: T) => string) => items.reduce<Record<string, number>>((out, item) => { const k = key(item); out[k] = (out[k] || 0) + 1; return out; }, {});
    let prior = null as BrainTick['assessment'];
    let feedback = null as BrainTick['feedback'];
    let shown = 0, shownVoice = 0;
    const adapter = createLegacyAdapterState();
    for (const tick of ticks) {
      prior = currentAssessment(tick.assessment ?? prior, tick, 0);
      feedback = currentFeedback(tick.feedback ?? feedback, tick, true, tick.timestamp_ms);
      if (prior?.criteria.length) shown++;
      if (feedback?.kind === 'technique_cue') shownVoice++;
      toLegacyFrameAnalysis(tick, adapter);
    }
    results.push({ requested_max_hz: hz, input_frames: selected.length,
      actual_interval_ms: { median: intervals[Math.floor(intervals.length / 2)], p90: intervals[Math.floor(intervals.length * .9)] },
      continuity_gaps: ticks.filter(t => t.signal.time_gap).length, quality_good: ticks.filter(t => t.quality.ok).length,
      assessments: ticks.filter(t => t.assessment?.criteria.length).length, visible_assessment_ticks: shown, visible_cue_ticks: shownVoice,
      attempts: ticks.filter(t => t.guided_attempt?.source === 'motion_bout').length,
      completion_review_ticks: ticks.filter(t => t.guided_completion?.source === 'motion_bout').length,
      criteria: count(criteria, c => `${c.criterion_id}: ${c.state} ${c.measurement.reason || ''}`),
      phases: count(ticks, t => t.temporal?.phase_id || 'idle'), completed_repetitions: rt.summary().executions_completed,
      cues: ticks.filter(t => t.feedback).map(t => ({ at_ms: t.timestamp_ms, kind: t.feedback!.kind, text: t.feedback!.text })),
      endpoint_assessments: ticks.filter(t => t.assessment?.criteria.some(c => (c as typeof c & { meta?: { assessment_source?: string } }).meta?.assessment_source === 'guided_attempt_completed')).map(t => ({ at_ms: t.timestamp_ms, phase: t.assessment!.phase_id, states: t.assessment!.criteria.map(c => ({ id: c.criterion_id, state: c.state, value: c.measurement.value, reason: c.measurement.reason })) })),
    });
  }
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ input, movement, note: 'Source timestamps/quality preserved; no interpolation or fabricated end frames. Training or screen-recording regression only, not independent accuracy validation.', results }, null, 2));
  console.log(JSON.stringify(results.map(r => ({ hz: r.requested_max_hz, frames: r.input_frames, assessments: r.assessments, visible: r.visible_assessment_ticks, attempt_frames: r.attempts, completion_review_ticks: r.completion_review_ticks, cues: r.cues.length })), null, 2));
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
