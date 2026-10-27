import { describe, expect, it } from 'vitest';
import type { AssessmentSet, CriterionEvidence, FeedbackTemplates } from '@apexformz/contracts';
import { CoachingPolicy, type CoachingInput } from './policy';

const templates = (review: 'approved' | 'draft'): FeedbackTemplates => ({
  schema_version: '1.0.0', sport_id: 'x', catalog_version: '1.0.0', default_locale: 'en',
  entries: [{ error_id: 'x.m.knee_bad', cue: { en: 'Bend the knee.' }, rationale: { en: 'why' }, review_status: review, cooldown_ms: 1000, persistence_count: 2, severity: 'medium', positive_cue: { en: 'Nice knee.' } }],
  generic: {},
  policy: { global_min_interval_ms: 100, positive_reinforcement_interval_ms: 100 },
});

function assessment(state: 'PASS' | 'IMPROVE', t: number): AssessmentSet {
  const c = { criterion_id: 'x.m.knee', movement_id: 'x.m', state, score: state === 'PASS' ? 1 : 0, measurement: { value: 100, unit: 'deg', reason: null }, confidence: { movement: 0.9, assessment: 0.9 }, evidence: { frame_ids: [1], view: 'front' }, feedback: { error_id: 'x.m.knee_bad' }, provenance: { sport_pack: '1.0.0', rubric: '1.0.0', validation_status: 'provisional', evaluator: 'range' }, severity: 'medium', timestamp_ms: t } as unknown as CriterionEvidence;
  return { schema_version: '1.0.0', session_id: 's', event_id: `a${t}`, timestamp_ms: t, movement_id: 'x.m', criteria: [c], score: null, coverage: { ratio: 1, valid: 1, total: 1 }, method: 'm', weights: {}, rubric_version: '1.0.0', sport_pack_id: 'x', sport_pack_version: '1.0.0', retrospective: false } as unknown as AssessmentSet;
}

const input = (t: number, state: 'PASS' | 'IMPROVE', cueAllowed = true): CoachingInput => ({ timestamp_ms: t, frame_id: t, assessment: assessment(state, t), quality_ok: true, quality_reasons: [], cue_allowed: cueAllowed, recognition_state: 'EXECUTING', movement_id: 'x.m' });

function runPasses(policy: CoachingPolicy, cueAllowed: boolean, n = 6) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const a = policy.decide(input(i * 1000, 'PASS', cueAllowed));
    if (a) out.push(a);
  }
  return out;
}

describe('CoachingPolicy positive reinforcement guards (TRD 11)', () => {
  it('prioritizes a specific measured correction over whole-pose similarity at the same severity', () => {
    const catalog = templates('approved');
    catalog.entries.push({ ...catalog.entries[0], error_id: 'x.m.reference_bad', cue: { en: 'Match the reference.' } });
    const p = new CoachingPolicy(catalog, { session_id: 's', sport_pack_id: 'x', sport_pack_version: '1.0.0', allow_draft_cues: false });
    let cue;
    for (let t = 1000; t <= 2000; t += 1000) {
      const next = input(t, 'IMPROVE');
      const knee = next.assessment!.criteria[0];
      knee.score = 0.4;
      next.assessment!.criteria.unshift({ ...knee, criterion_id: 'x.m.reference', score: 0,
        feedback: { error_id: 'x.m.reference_bad', cue: 'Match the reference.' },
        provenance: { ...knee.provenance, evaluator: 'reference_nearest' } });
      cue = p.decide(next);
    }
    expect(cue?.text).toBe('Bend the knee.');
  });
  it('speaks an approved positive cue after sustained clean assessments in a cueable phase', () => {
    const p = new CoachingPolicy(templates('approved'), { session_id: 's', sport_pack_id: 'x', sport_pack_version: '1.0.0', allow_draft_cues: false });
    const out = runPasses(p, true);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].kind).toBe('positive_reinforcement');
    expect(out[0].provenance.review_status).toBe('approved');
  });

  it('never speaks a draft positive cue when draft cues are not allowed (strict mode)', () => {
    const p = new CoachingPolicy(templates('draft'), { session_id: 's', sport_pack_id: 'x', sport_pack_version: '1.0.0', allow_draft_cues: false });
    expect(runPasses(p, true)).toHaveLength(0);
    expect(p.lastSuppressedReason).toBe('feedback_not_reviewed');
  });

  it('speaks a draft positive cue only in development mode and labels it draft', () => {
    const p = new CoachingPolicy(templates('draft'), { session_id: 's', sport_pack_id: 'x', sport_pack_version: '1.0.0', allow_draft_cues: true });
    const out = runPasses(p, true);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].provenance.review_status).toBe('draft');
  });

  it('stays silent during phases that forbid cues, even for praise', () => {
    const p = new CoachingPolicy(templates('approved'), { session_id: 's', sport_pack_id: 'x', sport_pack_version: '1.0.0', allow_draft_cues: false });
    expect(runPasses(p, false)).toHaveLength(0);
    expect(p.lastSuppressedReason).toBe('phase_not_cueable');
  });

  it('does not praise while a primary correction is still active', () => {
    const p = new CoachingPolicy(templates('approved'), { session_id: 's', sport_pack_id: 'x', sport_pack_version: '1.0.0', allow_draft_cues: false });
    let cue = null;
    for (let i = 1; i <= 3 && !cue; i++) cue = p.decide(input(i * 1000, 'IMPROVE'));
    expect(cue?.kind).toBe('technique_cue');
    // Immediately after, clean assessments arrive while the cue is still active (expires after min(cooldown, 8s)).
    const t0 = cue!.timestamp_ms;
    const praise = [1, 2, 3].map((k) => p.decide(input(t0 + k * 150, 'PASS'))).filter(Boolean);
    expect(praise).toHaveLength(0);
  });

  it('resolves positive feedback by explicit rubric error id when PASS has no feedback object', () => {
    const catalog = templates('approved');
    catalog.entries[0].error_id = 'shared.cue.knee';
    const p = new CoachingPolicy(catalog, { session_id: 's', sport_pack_id: 'x', sport_pack_version: '1', allow_draft_cues: false,
      criterion_error_ids: { 'x.m.knee': 'shared.cue.knee' } });
    let cue;
    for (const t of [1000, 2000]) {
      const next = input(t, 'PASS'); next.assessment!.criteria[0].feedback = null;
      cue = p.decide(next);
    }
    expect(cue?.kind).toBe('positive_reinforcement');
    expect(cue?.text).toBe('Nice knee.');
  });
});

describe('bounded dynamic cue deferral', () => {
  const policy = () => new CoachingPolicy(templates('approved'), { session_id: 's', sport_pack_id: 'x', sport_pack_version: '1', allow_draft_cues: false, deferred_cue_max_age_ms: 8000 });
  const action = (t: number, state: 'PASS' | 'IMPROVE' = 'IMPROVE'): CoachingInput => {
    const next = input(t, state, false);
    next.evidence_scope = 'attempt-1';
    next.assessment!.criteria[0].phase_id = 'swing';
    return next;
  };
  const rest = (t: number): CoachingInput => ({ ...input(t, 'PASS'), assessment: null, evidence_scope: 'attempt-1' });
  const queue = (p: CoachingPolicy) => { expect(p.decide(action(1000))).toBeNull(); expect(p.decide(action(2000))).toBeNull(); };

  it('speaks a supported action error on the next safe frame without generating a fresh assessment', () => {
    const p = policy(); queue(p);
    const safe = rest(2200);
    const cue = p.decide(safe);
    expect(cue?.text).toBe('For your next attempt: Bend the knee.');
    expect(cue?.timestamp_ms).toBe(2200);
    expect(cue?.evidence_frame_ids).toEqual([1]);
    expect(safe.assessment).toBeNull();
    expect(p.decide(rest(3500))).toBeNull();
  });

  it('does not turn one transient assessment repeated by a cached execution into persistence', () => {
    const p = policy(); const cached = action(1000);
    p.decide(cached);
    p.decide({ ...cached, timestamp_ms: 2000 });
    expect(p.decide(rest(2200))).toBeNull();
  });

  it('waits for current motion safety even when the unknown temporal phase allows cues', () => {
    const p = policy(); queue(p);
    expect(p.decide({ ...rest(2200), deferred_cue_allowed: false })).toBeNull();
    expect(p.lastSuppressedReason).toBe('motion_not_settled');
    expect(p.decide({ ...rest(2400), deferred_cue_allowed: true })?.kind).toBe('technique_cue');
  });

  it.each(['quality', 'reset', 'expiry', 'scope', 'movement', 'contrary'])('discards queued evidence after %s', reason => {
    const p = policy(); queue(p);
    if (reason === 'reset') p.reset();
    if (reason === 'quality') p.decide({ ...rest(2100), quality_ok: false, quality_reasons: ['LOW_CONFIDENCE'] });
    if (reason === 'contrary') p.decide(action(2100, 'PASS'));
    const next = rest(reason === 'expiry' ? 10001 : 2200);
    if (reason === 'scope') next.evidence_scope = 'attempt-2';
    if (reason === 'movement') next.movement_id = 'another-movement';
    expect(p.decide(next)).toBeNull();
  });

  it('does not erase a supported action error with a different-phase resting verdict', () => {
    const p = policy(); queue(p);
    const next = { ...action(2100, 'PASS'), cue_allowed: true };
    next.assessment!.criteria[0].phase_id = 'ready';
    expect(p.decide(next)?.kind).toBe('technique_cue');
  });

  it('keeps a completed review through a global speech interval and speaks its original evidence once', () => {
    const catalog = templates('approved'); catalog.policy!.global_min_interval_ms = 2000;
    const p = new CoachingPolicy(catalog, { session_id: 's', sport_pack_id: 'x', sport_pack_version: '1', allow_draft_cues: false, deferred_cue_max_age_ms: 8000 });
    p.decide(input(1000, 'PASS')); expect(p.decide(input(1500, 'PASS'))?.kind).toBe('positive_reinforcement');
    const review = { ...action(2000), cue_allowed: true };
    Object.assign(review.assessment!.criteria[0], { meta: { assessment_source: 'guided_attempt_completed' }, evidence: { frame_ids: [4, 5, 6], view: 'front' } });
    expect(p.decide(review)).toBeNull();
    const cue = p.decide(rest(3500));
    expect(cue?.evidence_frame_ids).toEqual([4, 5, 6]);
    expect(cue?.kind).toBe('technique_cue');
    expect(p.decide({ ...review, timestamp_ms: 6000 })).toBeNull();
  });
});
