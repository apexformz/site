/** Explicit synthetic geometry for end-to-end coaching tests, never accuracy data. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { syntheticPoseFrame } from '../packages/signal/src/synthetic';

const step_ms = 200;
const frames = Array.from({ length: 95 }, (_, i) => {
  const second = i >= 48;
  const local = second ? i - 48 : i;
  const elbow = local < 7 ? 0 : local < 17 ? (local - 7) * 8 : 72;
  const lean = local < 7 ? 0 : local < 17 ? (local - 7) * 4.5 : local < 22 ? 45 : 0;
  return syntheticPoseFrame(i, i * step_ms, {
    right_elbow_flexion: elbow,
    trunk_lean: second ? 0 : lean,
    left_knee_flexion: second ? 55 : 0,
    right_knee_flexion: second ? 55 : 0,
  }, { session_id: 'synthetic-browser-session', tracked_subject_id: 'synthetic-athlete' });
});
mkdirSync('data/audit/dynamic-feedback-investigation', { recursive: true });
writeFileSync('data/audit/dynamic-feedback-investigation/known-geometry.json', JSON.stringify({
  description: 'Synthetic incorrect attempt: straight knees and 45-degree lean during slow arm movement; then corrected bent-knee upright attempt. No ball/racket evidence. Test-only worker-input substitution, not perception or coaching accuracy validation.', step_ms, frames,
}));
console.log(`Wrote ${frames.length} explicitly synthetic geometry observations.`);
