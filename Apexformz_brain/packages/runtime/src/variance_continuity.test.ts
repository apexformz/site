import { describe, expect, it } from 'vitest';
import { syntheticPoseFrame } from '@apexformz/signal';
import type { CriterionEvidence } from '@apexformz/contracts';
import { activeSession } from '../../../tests/helpers/packs';

describe('personal variance history follows the tracked athlete', () => {
  it.each([
    { subject: 'athlete-b', gap: 0, expectedRepetitions: 1 },
    { subject: 'athlete-a', gap: 1000, expectedRepetitions: 2 },
  ])('after continuity break: $subject, gap $gap', async ({ subject, gap, expectedRepetitions }) => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance', {
      strict_rubrics: false,
      human_variance: { consistency: { enabled: true, window: 8, min_reps: 3 } },
    });
    const pose = { right_arm_raise: 88, right_elbow_flexion: 5, left_arm_raise: 5, stance_width: 0.45 };
    let index = 0;
    let time = 0;
    const feed = (subjectId: string) => {
      let last: CriterionEvidence | undefined;
      for (let k = 0; k < 60; k++, index++, time += 40) {
        const tick = rt.process(syntheticPoseFrame(index, time, pose, { session_id: sessionId, tracked_subject_id: subjectId }), time);
        const evidence = tick?.assessment?.criteria.find((c) => c.criterion_id === 'shooting.setup_stance.shooting_elbow_extension');
        if (evidence) last = evidence;
      }
      return last as CriterionEvidence & { meta: { repetitions: { reps: number } } };
    };
    expect(feed('athlete-a').meta.repetitions.reps).toBe(1);
    time += gap;
    expect(feed(subject).meta.repetitions.reps).toBe(expectedRepetitions);
  });
});
