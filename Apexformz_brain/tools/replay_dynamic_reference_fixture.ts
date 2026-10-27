/** Replay an explicitly labelled pose fixture through the deployed pack and full runtime. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoseFrame, ViewLabel, Handedness } from '@apexformz/contracts';
import { createLegacyAdapterState, skeletonFeedbackStyle, toLegacyFrameAnalysis } from '@apexformz/brain-client';
import { activeSession, calibration } from '../tests/helpers/packs';
import { createTechniqueReview, recordTechniqueAssessment } from '../apps/frontend/src/lib/brain/sessionTechniqueReview';

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: tsx tools/replay_dynamic_reference_fixture.ts fixture.json [report.json]');
  const fixture = JSON.parse(fs.readFileSync(input, 'utf8')) as { movement_id: string; view: ViewLabel; handedness: Handedness; input_kind: string; frames: PoseFrame[] };
  const { rt, sessionId, ctx } = await activeSession(['squash'], 'squash', fixture.movement_id,
    { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true }, calibration({ nominal_view: fixture.view, handedness: fixture.handedness }));
  const visual = { handedness: fixture.handedness, featureSpecs: ctx.feature_specs };
  const adapter = createLegacyAdapterState();
  const review = createTechniqueReview(sessionId, fixture.movement_id);
  const ticks = fixture.frames.flatMap(frame => { const tick = rt.process({ ...frame, session_id: sessionId }, frame.timestamp_ms); return tick ? [tick] : []; });
  let red = 0, redKnee = 0;
  const states: Record<string, number> = {}, criteria: Record<string, number> = {};
  for (const tick of ticks) {
    const state = tick.dynamic_reference?.status ?? 'no-reference'; states[state] = (states[state] ?? 0) + 1;
    recordTechniqueAssessment(review, tick.assessment, visual);
    const body = toLegacyFrameAnalysis(tick, adapter, [], visual);
    if (body.visual_cues.some(c => c.state === 'IMPROVE' && c.affected_segments.length)) red++;
    if (skeletonFeedbackStyle(body.visual_cues, 'left_knee', 'left_ankle').state === 'improve') redKnee++;
    for (const c of tick.assessment?.criteria ?? []) { const key = `${c.criterion_id}:${c.state}`; criteria[key] = (criteria[key] ?? 0) + 1; }
  }
  const report = { fixture: path.resolve(input), input_kind: fixture.input_kind, movement: fixture.movement_id, view: fixture.view,
    ticks: ticks.length, states, criteria, red_frames: red, red_knee_frames: redKnee, recognized_repetitions: ticks.filter(t => t.temporal?.completed).length,
    technique_cues: ticks.filter(t => t.feedback?.kind === 'technique_cue').map(t => ({ at: t.timestamp_ms, text: t.feedback!.text, criterion: t.feedback!.criterion_id })),
    faults: ticks.filter(t => t.assessment?.criteria.some(c => c.state === 'IMPROVE')).map(t => ({ at: t.timestamp_ms, status: t.dynamic_reference?.status, progress: t.dynamic_reference?.progress,
      criteria: t.assessment!.criteria.filter(c => c.state === 'IMPROVE').map(c => ({ id: c.criterion_id, value: c.measurement.value })) })),
    session_review: review.review };
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ movement: report.movement, states, red_frames: red, red_knee_frames: redKnee, technique_cues: report.technique_cues, faults: report.faults, recognized_repetitions: report.recognized_repetitions }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
