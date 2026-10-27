/**
 * Golden fixtures G01-G10 (TRD 15). Each test is deterministic and uses
 * synthetic geometry or sealed sport packs from disk.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { LANDMARK_INDEX, type FeatureSpec, type SportPackManifest, validate } from '@apexformz/contracts';
import { SignalPipeline, syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { FeatureEngine } from '@apexformz/features';
import { fromPoseLandmarkerResult, SubjectTracker } from '@apexformz/perception';
import { computeAssetHashes, loadSportPack, signManifestHmac, SportPackRegistry, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET } from '@apexformz/sport-runtime';
import { readPackDir } from '@apexformz/sport-runtime/node';
import { EventLedger, type BrainRuntime, type BrainTick } from '@apexformz/runtime';
import { activeSession, DEV_KEYS, PACKS_DIR, runtimeWithPacks, startRequest, calibration } from '../helpers/packs';

const DT = 40;
const spec = (id: string, kind: FeatureSpec['kind'], params: Record<string, unknown>): FeatureSpec => ({ id, kind, params, version: '1.0.0', coordinate_system: 'body_relative', view_applicability: 'any' });

function feed(rt: BrainRuntime, sessionId: string, segs: Array<{ o: SyntheticPoseOptions; count: number; meta?: Record<string, unknown> }>, startT = 0, startF = 0): BrainTick[] {
  const ticks: BrainTick[] = [];
  let i = startF;
  let t = startT;
  for (const s of segs) {
    for (let k = 0; k < s.count; k++, i++, t += DT) {
      const tick = rt.process(syntheticPoseFrame(i, t, s.o, { session_id: sessionId, ...(s.meta ?? {}) }), t);
      if (tick) ticks.push(tick);
    }
  }
  return ticks;
}

describe('G01 straight-line synthetic elbow landmarks', () => {
  it('yields 180 degrees within floating tolerance', () => {
    const eng = new FeatureEngine([spec('elbow', 'angle_at', { a: 'left_shoulder', b: 'left_elbow', c: 'left_wrist' })]);
    const p = new SignalPipeline();
    const f = syntheticPoseFrame(0, 0);
    // Force exact collinearity in image space: elbow is the midpoint of shoulder and wrist.
    const s = f.normalized_landmarks[LANDMARK_INDEX['left_shoulder']];
    const w = f.normalized_landmarks[LANDMARK_INDEX['left_wrist']];
    const e = f.normalized_landmarks[LANDMARK_INDEX['left_elbow']];
    e.x = (s.x + w.x) / 2;
    e.y = (s.y + w.y) / 2;
    p.process(f);
    const v = eng.compute(p.window, { view: 'front', handedness: 'right' }).get('elbow')!;
    expect(v.valid).toBe(true);
    expect(Math.abs(v.value! - 180)).toBeLessThan(1e-6);
    expect(v.unit).toBe('deg');
  });
});

describe('G02 zero-length arm segment', () => {
  it('returns value=null with DEGENERATE_GEOMETRY', () => {
    const eng = new FeatureEngine([spec('elbow', 'angle_at', { a: 'left_shoulder', b: 'left_elbow', c: 'left_wrist' })]);
    const p = new SignalPipeline();
    const f = syntheticPoseFrame(0, 0);
    const s = f.normalized_landmarks[LANDMARK_INDEX['left_shoulder']];
    const e = f.normalized_landmarks[LANDMARK_INDEX['left_elbow']];
    e.x = s.x;
    e.y = s.y;
    e.z = s.z;
    p.process(f);
    const v = eng.compute(p.window, { view: 'front', handedness: 'right' }).get('elbow')!;
    expect(v.value).toBeNull();
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('DEGENERATE_GEOMETRY');
  });
});

describe('G03 normal pose then time gap', () => {
  it('resets temporal state and never emits an invalid velocity', async () => {
    const { rt, sessionId } = await activeSession(['badminton'], 'badminton', 'badminton.lunge', { strict_rubrics: false });
    const before = feed(rt, sessionId, [{ o: { right_knee_flexion: 0 }, count: 12 }, { o: { right_knee_flexion: 50 }, count: 8 }]);
    expect(before.at(-1)!.temporal!.state).toBe('EXECUTING');
    const after = feed(rt, sessionId, [{ o: { right_knee_flexion: 50 }, count: 1 }], 20 * DT + 5000, 20);
    const tick = after[0];
    expect(tick.signal.time_gap).toBe(true);
    expect(tick.temporal!.aborted_reason).toBe('TIME_GAP');
    expect(tick.temporal!.state).toBe('IDLE');
    // Every history-dependent feature requested by the lunge must abstain right after the gap.
    const derived = tick.features.filter((f) => f.spec_id === 'lunge_sequencing' || f.unit.endsWith('_per_s'));
    expect(derived.length).toBeGreaterThan(0);
    for (const f of derived) {
      expect(f.valid).toBe(false);
      expect(f.value).toBeNull();
      expect(f.reason).toBe('INSUFFICIENT_HISTORY');
    }
    // The engine only computes features the pack requests (no sport-agnostic velocity is invented).
    expect(tick.features.some((f) => f.spec_id === 'lead_knee_angle')).toBe(true);
  });
});

describe('G04 left-hand mirrored sequence', () => {
  it('produces consistent normalized semantics and preserves the mirror flag', () => {
    const specs = [spec('left_knee', 'angle_at', { a: 'left_hip', b: 'left_knee', c: 'left_ankle' }), spec('right_knee', 'angle_at', { a: 'right_hip', b: 'right_knee', c: 'right_ankle' })];
    const run = (mirror: boolean) => {
      const eng = new FeatureEngine(specs);
      const p = new SignalPipeline();
      let out = new Map();
      let last;
      for (let i = 0; i < 10; i++) {
        const f = syntheticPoseFrame(i, i * DT, { left_knee_flexion: 40 });
        if (mirror) {
          // Build the selfie-view image of the same athlete: flip x and swap left/right labels.
          const flipped = f.normalized_landmarks.map((l) => ({ ...l, x: 1 - l.x }));
          for (const [L, R] of [[LANDMARK_INDEX['left_knee'], LANDMARK_INDEX['right_knee']], [LANDMARK_INDEX['left_hip'], LANDMARK_INDEX['right_hip']], [LANDMARK_INDEX['left_ankle'], LANDMARK_INDEX['right_ankle']], [LANDMARK_INDEX['left_shoulder'], LANDMARK_INDEX['right_shoulder']]]) {
            const a = flipped[L];
            flipped[L] = { ...flipped[R], id: L };
            flipped[R] = { ...a, id: R };
          }
          f.normalized_landmarks = flipped;
          f.mirror = true;
        }
        last = p.process(f);
        out = eng.compute(p.window, { view: 'front', handedness: 'left' });
      }
      return { out, mirrorApplied: last!.frame!.mirror_applied };
    };
    const plain = run(false);
    const mirrored = run(true);
    expect(mirrored.mirrorApplied).toBe(true);
    expect(plain.mirrorApplied).toBe(false);
    expect(mirrored.out.get('left_knee')!.value).toBeCloseTo(plain.out.get('left_knee')!.value!, 5);
    expect(mirrored.out.get('right_knee')!.value).toBeCloseTo(plain.out.get('right_knee')!.value!, 5);
    expect(plain.out.get('left_knee')!.value!).toBeCloseTo(140, 0);
  });
});

describe('G05 second person enters foreground', () => {
  it('flags AMBIGUOUS_SUBJECT and suppresses coaching', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance', { strict_rubrics: false, allow_draft_feedback: true });
    const stance: SyntheticPoseOptions = { right_arm_raise: 88, right_elbow_flexion: 5, trunk_lean: 25 };
    feed(rt, sessionId, [{ o: stance, count: 40 }]);
    const tracker = new SubjectTracker();
    const meta = { session_id: sessionId, camera_id: 'c', image_size: [1280, 720] as [number, number], mirror: false, orientation: 'landscape' as const, provenance: { model_id: 'synthetic', version: '1' } };
    const person = (o: SyntheticPoseOptions, i: number) => syntheticPoseFrame(i, i * DT, o).normalized_landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z ?? 0, visibility: l.visibility, presence: l.presence }));
    fromPoseLandmarkerResult({ landmarks: [person(stance, 40)] }, { ...meta, frame_id: 40, timestamp_ms: 40 * DT }, { tracker });
    const ticks: BrainTick[] = [];
    for (let i = 41; i < 70; i++) {
      const frame = fromPoseLandmarkerResult({ landmarks: [person(stance, i), person({ ...stance, offset_x: 0.1, scale: 0.42 }, i)] }, { ...meta, frame_id: i, timestamp_ms: i * DT }, { tracker });
      const tick = rt.process(frame, i * DT);
      if (tick) ticks.push(tick);
    }
    expect(ticks.every((t) => t.quality.reasons.includes('AMBIGUOUS_SUBJECT'))).toBe(true);
    expect(ticks.every((t) => !t.feedback || t.feedback.kind !== 'technique_cue')).toBe(true);
    expect(ticks.some((t) => t.feedback?.kind === 'setup_instruction')).toBe(true);
    expect(ticks.every((t) => !t.assessment || t.assessment.criteria.every((c) => c.state !== 'IMPROVE' && c.state !== 'PASS'))).toBe(true);
    const tel = rt.telemetry()!;
    expect(tel.abstention_reasons['AMBIGUOUS_SUBJECT']).toBeGreaterThan(0);
  });
});

describe('G06 badminton session with shooting package available', () => {
  it('only the badminton pack executes', async () => {
    const { rt, sessionId } = await activeSession(['badminton', 'shooting'], 'badminton', 'badminton.ready_stance', { strict_rubrics: false });
    const ticks = feed(rt, sessionId, [{ o: { left_knee_flexion: 15, right_knee_flexion: 15 }, count: 40 }]);
    expect(ticks.every((t) => t.executed_pack.id === 'badminton')).toBe(true);
    expect(() => rt.router.packFor(sessionId, 'shooting')).toThrowError(/may not access/);
    expect(rt.telemetry()!.executed_packs).toEqual(['badminton@1.0.0']);
    expect(ticks.flatMap((t) => t.assessment?.criteria ?? []).every((c) => c.criterion_id.startsWith('badminton.'))).toBe(true);
  });
});

describe('G07 unobserved racket contact', () => {
  it('marks the contact criterion NOT_ASSESSABLE', async () => {
    const { rt, sessionId } = await activeSession(['badminton'], 'badminton', 'badminton.lunge', { strict_rubrics: false, capabilities_available: ['body_pose', 'optional_implement'] });
    const lunge = (k: number): SyntheticPoseOptions => ({ right_knee_flexion: k, right_arm_raise: 40, right_elbow_flexion: 20 });
    const ticks = feed(rt, sessionId, [{ o: lunge(0), count: 15 }, { o: lunge(50), count: 6 }, { o: lunge(70), count: 10 }, { o: lunge(0), count: 12 }]);
    const done = ticks.find((t) => t.temporal?.completed)!;
    const contact = done.assessment!.criteria.find((c) => c.criterion_id === 'badminton.lunge.racket_contact_height')!;
    expect(contact.state).toBe('NOT_ASSESSABLE');
    expect(contact.measurement.value).toBeNull();
    expect(contact.measurement.reason).toBe('CONTACT_UNOBSERVED');
    expect(contact.feedback).toBeNull();
    expect(done.assessment!.coverage.omitted.some((o) => o.criterion_id === 'badminton.lunge.racket_contact_height')).toBe(true);
  });
});

describe('G08 manifest asset hash mismatch', () => {
  it('rejects the package and retains the known-good version', async () => {
    const rt = await runtimeWithPacks(['badminton']);
    const input = await readPackDir(path.join(PACKS_DIR, 'badminton'));
    const manifest = { ...(input.manifest as SportPackManifest), version: '1.0.1' };
    const assets = { ...input.assets };
    const prov = JSON.parse(assets[manifest.provenance]);
    prov.version = '1.0.1';
    assets[manifest.provenance] = JSON.stringify(prov);
    manifest.asset_hashes = await computeAssetHashes(assets);
    const signed = await signManifestHmac(manifest, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET);
    assets['feedback_templates.json'] = assets['feedback_templates.json'].replace('Set your feet', 'Set yer feet');
    await expect(rt.installPack({ manifest: signed, assets })).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH', recoverable: false });
    expect(rt.registry.activeVersion('badminton')).toBe('1.0.0');
    expect(rt.registry.listInstalled().map((p) => p.version)).toEqual(['1.0.0']);
    const reg = new SportPackRegistry();
    reg.install(await loadSportPack(await readPackDir(path.join(PACKS_DIR, 'badminton')), { platform: 'web', hmac_keys: DEV_KEYS }));
    expect(reg.get('badminton', '1.0.0')).not.toBeNull();
  });
});

describe('G09 offline session + retried duplicated events', () => {
  it('ingests exactly once by event id', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance', { strict_rubrics: false });
    feed(rt, sessionId, [{ o: { right_arm_raise: 88, right_elbow_flexion: 5 }, count: 50 }]);
    const ledger = new EventLedger();
    const batch1 = rt.drainOutbox(50);
    expect(batch1.length).toBeGreaterThan(0);
    const r1 = ledger.ingest(batch1, (e) => (validate('eventEnvelope', e).ok ? null : 'SCHEMA_INVALID'));
    expect(r1.accepted).toHaveLength(batch1.length);
    // Network failed before ack: the client retries the same batch plus new events.
    const batch2 = rt.drainOutbox(500);
    const r2 = ledger.ingest(batch2);
    expect(r2.duplicates).toEqual(batch1.map((e) => e.event_id));
    expect(r2.accepted).toHaveLength(batch2.length - batch1.length);
    rt.ackOutbox(batch2.map((e) => e.event_id));
    expect(rt.outboxPending()).toBe(0);
    expect(ledger.count(sessionId)).toBe(batch2.length);
    const seq = ledger.events(sessionId).map((e) => e.sequence);
    expect(seq).toEqual([...seq].sort((a, b) => a! - b!));
  });
});

describe('G10 model update during active session', () => {
  it('keeps the pinned version until completion', async () => {
    const rt = await runtimeWithPacks(['shooting']);
    rt.calibrate(calibration(), 0);
    const sessionId = 'g10';
    rt.start(startRequest(sessionId, 'shooting', 'shooting.setup_stance'), 0);
    const input = await readPackDir(path.join(PACKS_DIR, 'shooting'));
    const manifest = { ...(input.manifest as SportPackManifest), version: '1.1.0' };
    const assets = { ...input.assets };
    const prov = JSON.parse(assets[manifest.provenance]);
    prov.version = '1.1.0';
    assets[manifest.provenance] = JSON.stringify(prov);
    manifest.asset_hashes = await computeAssetHashes(assets);
    const signed = await signManifestHmac(manifest, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET);
    await rt.installPack({ manifest: signed, assets });
    expect(() => rt.activatePack('shooting', '1.1.0')).toThrowError(/pinned/);
    const tick = rt.process(syntheticPoseFrame(0, 0, { right_arm_raise: 88 }, { session_id: sessionId }), 0)!;
    expect(tick.executed_pack.version).toBe('1.0.0');
    rt.complete(1000);
    rt.activatePack('shooting', '1.1.0');
    expect(rt.registry.activeVersion('shooting')).toBe('1.1.0');
  });
});
