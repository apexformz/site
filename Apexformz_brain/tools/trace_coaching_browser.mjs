/** Replay a user-supplied screen recording through the real detector and Brain.
 * Screen overlays are present in these pixels: this is a regression trace, not accuracy validation.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

const root = process.cwd();
const base = process.env.APEXFORMZ_WEB_TEST_URL || 'http://localhost:3000';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local tests only');
const output = path.join(root, process.env.TRACE_OUTPUT_ROOT || 'data/audit/static-investigation-2', process.env.TRACE_LABEL || 'trace');
const expectDynamic = process.env.TRACE_EXPECT_DYNAMIC === '1';
const expectInterrupted = process.env.TRACE_EXPECT_INTERRUPTED === '1';
const movement = process.env.TRACE_MOVEMENT || (expectDynamic ? 'squash.dynamic.0040' : 'squash.static.0001');
const movementName = process.env.TRACE_MOVEMENT_NAME || (expectDynamic ? 'Backhand swing' : 'Ready stance');
const buildId = fs.readFileSync(path.join(root, '../Apexformz/apps/frontend/.next/BUILD_ID'), 'utf8').trim();
const referencePath = path.join(root, 'sport-packs/squash/models/dynamic-reference', `${movement}.json`);
const referenceHash = fs.existsSync(referencePath) ? createHash('sha256').update(fs.readFileSync(referencePath)).digest('hex') : null;
fs.mkdirSync(output, { recursive: true });
const camera = path.resolve(process.env.TRACE_CAMERA || 'data/audit/static-investigation-2/current-attempt.y4m');
// Optional deterministic geometry fixture exercises the real worker/runtime/UI.
// It deliberately bypasses perception and is reported separately from camera tests.
const poseFixture = process.env.TRACE_POSE_FIXTURE ? JSON.parse(fs.readFileSync(process.env.TRACE_POSE_FIXTURE, 'utf8')) : null;
const env = dotenv.parse(fs.readFileSync(path.join(root, '../Apexformz/apps/backend/.env')));
const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
let browser, page, userId;
const trace = { ticks: [], poses: [], detections: [], dom: [], speech: [], errors: [] };
let savedReview = null;
async function collectDomSamples() {
  if (!page || page.isClosed()) return;
  const samples = await page.evaluate(() => {
    clearInterval(window.__coachingDomTimer);
    return window.__coachingDomSamples || null;
  });
  // Finishing/reloading navigates away from the sampled studio document.
  if (samples) trace.dom = samples;
}
try {
  const id = randomUUID();
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Coaching Trace', email: `trace-${id}@example.test`, password: `Trace-${id}`, preferred_sport: 'squash' }) });
  const { data: auth } = await response.json();
  if (!response.ok || !auth?.user) throw new Error(`Registration failed: ${response.status}`);
  userId = auth.user.id;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camera}`, '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera'] });
  await context.exposeBinding('recordBrainTrace', (_source, type, value) => { if (trace[type]) trace[type].push(value); });
  await context.addInitScript(({ access, refresh, captureInterval, poseFixture, selectedMovement, selectedView }) => {
    localStorage.setItem('access_token', access);
    localStorage.setItem('refresh_token', refresh);
    localStorage.setItem('brain_setup_squash', JSON.stringify({ movement_id: selectedMovement, mode: 'development', pose_backend: 'mediapipe',
      calibration: { full_body_framing: true, camera_tilt_deg: null, nominal_view: selectedView, handedness: 'right', handedness_assumed: false,
        floor_orientation_available: false, scale_known: false, scale_marker_m: null, athlete_context: 'unknown' } }));
    const NativeWorker = window.Worker;
    window.__coachingSequenceCompletions = 0;
    if (window.SpeechSynthesis) {
      const speak = SpeechSynthesis.prototype.speak;
      SpeechSynthesis.prototype.speak = function(utterance) { window.recordBrainTrace('speech', utterance.text); return speak.call(this, utterance); };
    }
    window.Worker = class extends NativeWorker {
      lastImageAt = -Infinity;
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'tick') {
            window.__coachingLatestTick = data.tick;
            if (data.tick.temporal?.completed) window.__coachingSequenceCompletions++;
            window.recordBrainTrace('ticks', data.tick);
          }
          if (data.type === 'pose') {
            window.__coachingLatestPose = data.frame;
            window.recordBrainTrace('poses', data.frame);
          }
          if (data.type === 'movement_detection') window.recordBrainTrace('detections', data.detection);
          if (data.type === 'error') window.recordBrainTrace('errors', data);
        });
      }
      postMessage(message, ...args) {
        if (poseFixture && message.type === 'start') {
          this.fixtureSession = message.request.session_id;
          this.fixtureStart = null;
          this.fixtureImageAt = -Infinity;
        }
        if (poseFixture && message.type === 'image') {
          message.bitmap.close();
          if (message.session_id === this.fixtureSession && message.timestamp_ms - this.fixtureImageAt >= poseFixture.step_ms) {
            this.fixtureStart ??= message.timestamp_ms;
            this.fixtureImageAt = message.timestamp_ms;
            const index = Math.min(poseFixture.frames.length - 1, Math.floor((message.timestamp_ms - this.fixtureStart) / poseFixture.step_ms));
            const frame = { ...poseFixture.frames[index], session_id: message.session_id, frame_id: message.frame_id, timestamp_ms: message.timestamp_ms };
            super.postMessage({ type: 'pose_frame', frame });
            this.dispatchEvent(new MessageEvent('message', { data: { type: 'pose', frame, latency_ms: 0 } }));
          }
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { type: 'image_done', image_id: message.image_id, frame_id: message.frame_id, session_id: message.session_id } })));
          return;
        }
        // Exercise sparse real observations, without changing the detector,
        // timestamps, model output, runtime, or UI. Discarded images have the
        // same completion acknowledgement as the normal capture backpressure.
        if (message.type === 'image' && captureInterval > 0) {
          if (message.timestamp_ms - this.lastImageAt < captureInterval) {
            message.bitmap.close();
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { type: 'image_done', image_id: message.image_id, frame_id: message.frame_id, session_id: message.session_id } })));
            return;
          }
          this.lastImageAt = message.timestamp_ms;
        }
        return super.postMessage(message, ...args);
      }
    };
  }, { access: auth.access_token, refresh: auth.refresh_token, captureInterval: Number(process.env.TRACE_CAPTURE_INTERVAL_MS || 0), poseFixture,
    selectedMovement: movement, selectedView: process.env.TRACE_VIEW || 'front' });
  page = await context.newPage();
  page.on('pageerror', e => trace.errors.push(e.message));
  await page.goto(`${base}/train/squash?movement=${encodeURIComponent(movement)}&mode=development&view=${encodeURIComponent(process.env.TRACE_VIEW || 'front')}`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.getByRole('button', { name: 'ENABLE CAMERA TO START', exact: true }).click();
  await page.waitForFunction(() => { const b = document.querySelector('button[title="Start session"]'); return b && !b.disabled; }, null, { timeout: 90000 });
  await page.getByTitle('Start session', { exact: true }).click();
  if (process.env.TRACE_PIN_ATHLETE === '1') {
    await page.waitForFunction(() => window.__coachingLatestPose?.normalized_landmarks.filter(p => [11, 12, 23, 24].includes(p.id) && p.visibility > .5).length === 4, null, { timeout: 45000 });
    const point = await page.locator('video').evaluate(video => {
      const torso = window.__coachingLatestPose.normalized_landmarks.filter(p => [11, 12, 23, 24].includes(p.id));
      const raw = { x: torso.reduce((sum, p) => sum + p.x, 0) / 4, y: torso.reduce((sum, p) => sum + p.y, 0) / 4 };
      const box = video.getBoundingClientRect(), scale = Math.max(box.width / video.videoWidth, box.height / video.videoHeight);
      const x = box.left + (box.width - video.videoWidth * scale) / 2 + (1 - raw.x) * video.videoWidth * scale;
      const y = box.top + (box.height - video.videoHeight * scale) / 2 + raw.y * video.videoHeight * scale;
      return { x, y, blocked: !!document.elementFromPoint(x, y)?.closest('button, a, [data-no-pin]') };
    });
    assert.ok(!point.blocked, 'Detected athlete must be tappable on the camera surface');
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => window.__coachingLatestPose?.tracked_subject_id?.startsWith('pinned-'), null, { timeout: 30000 });
    await page.getByRole('button', { name: 'Unpin athlete', exact: true }).waitFor();
  }
  await page.evaluate(() => {
    // Sample the rendered UI independently of screenshots or worker callbacks:
    // a review may be visible only briefly before another movement begins.
    window.__coachingDomSamples = [];
    const started = performance.now();
    const sample = () => {
      if (window.__coachingDomSamples.length >= 1000) {
        clearInterval(window.__coachingDomTimer);
        return;
      }
      const panel = testId => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        if (!element) return { text: '', visible: false };
        const rect = element.getBoundingClientRect();
        let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
        let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
        let visible = element.getClientRects().length > 0;
        for (let current = element; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) visible = false;
          if (current !== element && /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
            const clip = current.getBoundingClientRect();
            left = Math.max(left, clip.left); right = Math.min(right, clip.right);
            top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
          }
        }
        return { text: element.innerText.trim().slice(0, 1600), visible: visible && right > left && bottom > top };
      };
      const tick = window.__coachingLatestTick;
      const selected = document.querySelector('[data-testid="selected-drill-name"]');
      const sessionText = selected?.nextElementSibling?.textContent || '';
      const count = sessionText.match(/(\d+) reps completed/);
      let red = 0, blue = 0;
      for (const canvas of document.querySelectorAll('canvas')) {
        if (canvas.width < 100 || canvas.height < 100) continue;
        const context = canvas.getContext('2d');
        if (!context) continue;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 180 && pixels[i + 1] < 130 && pixels[i + 2] < 150 && pixels[i + 3] > 150) red++;
          if (pixels[i] < 80 && pixels[i + 1] > 160 && pixels[i + 2] > 190 && pixels[i + 3] > 150) blue++;
        }
      }
      window.__coachingDomSamples.push({
        elapsed_ms: Math.round(performance.now() - started),
        tick_timestamp_ms: tick?.timestamp_ms ?? null,
        selected_drill: selected?.textContent?.trim() || '',
        progress: panel('dynamic-movement-progress'),
        live_feedback: panel('live-technique-feedback'),
        last_review: panel('last-attempt-review'),
        named_checks: panel('dynamic-attempt-checks'),
        overlay: { red, blue },
        displayed_completed_reps: count ? Number(count[1]) : null,
        observed_sequence_completions: window.__coachingSequenceCompletions,
        guided_attempt_source: tick?.guided_attempt?.source || null,
        guided_completion_source: tick?.guided_completion?.source || null,
        assessment_event_id: tick?.assessment?.event_id || null,
        assessment_states: tick?.assessment?.criteria.map(c => c.state) || [],
        completed_attempt_assessment: Boolean(tick?.assessment?.criteria.some(c => ['guided_attempt_completed', 'dynamic_reference_completed'].includes(c.meta?.assessment_source))),
        reference_status: tick?.dynamic_reference?.status ?? null,
      });
    };
    sample();
    window.__coachingDomTimer = setInterval(sample, 200);
  });
  await page.waitForTimeout(Number(process.env.TRACE_DURATION_MS || 32000));
  await collectDomSamples();
  if (process.env.TRACE_EXPECT_CORRECTIONS === '1') {
    assert.ok(trace.ticks.some(t => t.assessment?.criteria.some(c => c.state === 'IMPROVE')), 'Recorded attempt must produce correction evidence');
    assert.ok(trace.ticks.some(t => t.feedback?.kind === 'technique_cue'), 'Persistent incorrect attempt must generate a voice cue');
    await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(canvas => {
      if (canvas.width < 100) return false;
      const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels) return false;
      let red = 0, blue = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 180 && pixels[i+1] < 130 && pixels[i+2] < 150 && pixels[i+3] > 150) red++;
        if (pixels[i] < 80 && pixels[i+1] > 160 && pixels[i+2] > 190 && pixels[i+3] > 150) blue++;
      }
      return red > 20 && blue > 20;
    }), null, { timeout: 20000 });
    await page.getByTestId('live-technique-feedback').getByText(/correction.*to make/).waitFor();
    assert.ok(await page.getByTestId('camera-coaching-cue').isVisible(), 'Correction must be visible over the camera');
    assert.equal(await page.getByTestId('selected-drill-name').innerText(), movementName);
    assert.equal(await page.getByText('Target match uncertain', { exact: true }).isVisible().catch(() => false), false, 'Classifier diagnostics should not obscure live technique guidance');
  }
  if (expectDynamic) {
    assert.equal(await page.getByTestId('selected-drill-name').innerText(), movementName, 'The requested dynamic drill must remain selected');
    assert.match(movement, /^squash\.dynamic\./, 'Dynamic trace must exercise a dynamic drill');
    assert.ok(trace.dom.length > 1, 'Dynamic UI must be sampled during playback');
    assert.ok(trace.dom.some(s => s.progress.visible && /Analysing attempted|Following |Reviewing |Comparing|reference|Partial movement reviewed|Recorded sequence reviewed/i.test(s.progress.text)), 'Dynamic analysis must be visible during playback');
    assert.ok(trace.ticks.some(t => t.assessment?.criteria.length), 'The real Brain must produce technique assessment evidence');
    if (expectInterrupted) {
      assert.ok(trace.ticks.some(t => !t.quality.ok || t.signal.time_gap || t.signal.track_changed), 'The interruption fixture must contain actual missing or broken tracking evidence');
      assert.ok(trace.dom.some(s => /Waiting for clear|Waiting for clearer/.test(s.progress.text)), 'Interrupted evidence must be explained in the studio');
      assert.ok(!trace.ticks.some(t => t.assessment?.criteria.some(c => c.provenance.evaluator === 'dynamic_reference' && c.meta?.dynamic_reference?.status === 'complete' && c.state === 'PASS')), 'This incomplete capture must not receive a whole-sequence PASS');
    } else {
      assert.ok(trace.dom.some(s => s.last_review.visible && /Last attempt review/i.test(s.last_review.text)), 'A completed attempt review must remain visible during a later attempt');
    }
    if (process.env.TRACE_EXPECT_REFERENCE_MATCH === '1') {
      // A source match is only concluded at the segment endpoint. Its result
      // belongs in the retained review, not on a now-idle live skeleton.
      assert.ok(trace.dom.some(s => s.last_review.visible && /[1-9]\d* checks? in range/i.test(s.last_review.text)), 'A correct recorded segment must display its measured match in the retained review');
    } else {
      assert.ok(trace.dom.some(s => s.live_feedback.visible && s.assessment_states.some(state => state === 'PASS' || state === 'IMPROVE')
        || s.last_review.visible && /checks? in range|corrections? to make/i.test(s.last_review.text)), 'A measured verdict must reach the live feedback panel or retained attempt review');
    }
    const counters = trace.dom.filter(s => s.displayed_completed_reps !== null);
    assert.ok(counters.length, 'Completed-rep counter must be observable');
    assert.ok(counters.every(s => s.displayed_completed_reps <= s.observed_sequence_completions), 'Guided motion attempts must not inflate completed repetitions');
  }
  await page.screenshot({ path: path.join(output, 'studio.png'), fullPage: true });
  fs.writeFileSync(path.join(output, 'page.txt'), await page.locator('body').innerText());
  if (process.env.TRACE_EXPECT_DYNAMIC_CORRECTION === '1') {
    assert.ok(trace.dom.some(s => s.overlay.red > 20 && s.overlay.blue > 20), 'A supported dynamic live correction must color the affected body area red while other tracked areas remain blue');
    const cues = trace.ticks.filter(t => t.feedback?.kind === 'technique_cue').map(t => t.feedback.text);
    assert.ok(cues.length, 'A sustained dynamic mistake must yield a correction cue');
    assert.ok(trace.speech.some(text => cues.includes(text)), 'The dynamic correction must reach speech synthesis');
  }
  if (process.env.TRACE_EXPECT_REFERENCE_MATCH === '1') {
    const evidence = trace.ticks.flatMap(t => t.assessment?.criteria ?? []).filter(c => c.provenance.evaluator === 'dynamic_reference');
    assert.ok(evidence.some(c => c.state === 'PASS' && c.meta?.dynamic_reference?.segment_matched), 'The correct recorded pose sequence must reach a measured reference match');
    assert.ok(!evidence.some(c => c.state === 'IMPROVE'), 'A correct reference replay must not produce a false correction');
  }
  if (process.env.TRACE_FINISH_REVIEW === '1') {
    await page.getByTitle('Finish session', { exact: true }).click();
    await page.waitForURL(/\/results\//, { timeout: 60000 });
    if (expectDynamic) await page.getByTestId('session-technique-review').waitFor();
    else await page.getByText('Technique feedback', { exact: true }).waitFor();
    await page.getByText('Saved to your account', { exact: false }).waitFor({ timeout: 30000 });
    const sessionId = new URL(page.url()).pathname.split('/').pop();
    const result = await fetch(`${base}/api/v1/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${auth.access_token}` } });
    const stored = (await result.json()).data;
    assert.ok(result.ok && (expectDynamic ? stored.session_technique_review : stored.last_assessment), 'Technique review or static assessment must be persisted by the API');
    savedReview = expectDynamic ? stored.session_technique_review : stored.last_assessment;
    fs.writeFileSync(path.join(output, 'saved-review.json'), JSON.stringify(savedReview, null, 2));
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('brain_session_')) localStorage.removeItem(key); });
    await page.reload({ waitUntil: 'networkidle' });
    if (expectDynamic) await page.getByTestId('session-technique-review').waitFor();
    else await page.getByText('Technique feedback', { exact: true }).waitFor();
    if (process.env.TRACE_EXPECT_DYNAMIC_CORRECTION === '1') {
      assert.ok(await page.getByTestId('session-review-correction').count() > 0, 'Earlier dynamic corrections must survive a later corrected/uncertain tail and backend reload');
    }
    await page.screenshot({ path: path.join(output, 'results.png'), fullPage: true });
    fs.writeFileSync(path.join(output, 'results.txt'), await page.locator('body').innerText());
  }
} catch (e) {
  trace.errors.push(e.stack); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await page.locator('body').innerText().then(text => fs.writeFileSync(path.join(output, 'failure.txt'), text)).catch(() => {});
  }
}
finally {
  await collectDomSamples().catch(e => trace.errors.push(`DOM sampling: ${e.message}`));
  await browser?.close();
  if (userId) { await db.brainSession.deleteMany({ where: { athlete_id: userId } }); await db.user.delete({ where: { id: userId } }); }
  await db.$disconnect();
  for (const key of ['ticks', 'poses', 'detections', 'dom']) fs.writeFileSync(path.join(output, `${key}.jsonl`), trace[key].map(x => JSON.stringify(x)).join('\n'));
  const count = (list, fn) => list.reduce((out, x) => { const k = fn(x); out[k] = (out[k] || 0) + 1; return out; }, {});
  const criteria = trace.ticks.flatMap(t => t.assessment?.criteria || []);
  const deltas = trace.ticks.slice(1).map((t, i) => t.timestamp_ms - trace.ticks[i].timestamp_ms).sort((a,b) => a-b);
  const report = { camera, movement, input_kind: poseFixture ? (poseFixture.input_kind || 'synthetic geometry through real worker; pose detection bypassed') : 'recorded camera through real detector', pose_fixture: process.env.TRACE_POSE_FIXTURE || null, capture_interval_ms: Number(process.env.TRACE_CAPTURE_INTERVAL_MS || 0), ticks: trace.ticks.length, assessments: trace.ticks.filter(t => t.assessment).length,
    frontend_build_id: buildId, reference_model_sha256: referenceHash,
    temporal: count(trace.ticks, t => t.temporal?.state || 'none'), gaps: trace.ticks.filter(t => t.signal.time_gap).length,
    expected_interrupted_evidence: expectInterrupted,
    reference_statuses: count(trace.ticks, t => t.dynamic_reference?.status || 'none'),
    interval_ms: { median: deltas[Math.floor(deltas.length/2)], p90: deltas[Math.floor(deltas.length*.9)] },
    quality: count(trace.ticks, t => t.quality.reasons.join(',') || 'OK'),
    criteria: count(criteria, c => `${c.criterion_id}: ${c.state} ${c.reason || ''}`),
    dynamic_visibility: {
      expected: expectDynamic, sample_interval_ms: 200, sample_limit: 1000, samples: trace.dom.length,
      progress_visible_samples: trace.dom.filter(s => s.progress.visible).length,
      analysis_visible_samples: trace.dom.filter(s => s.progress.visible && /Analysing attempted|Following |Comparing with/.test(s.progress.text)).length,
      live_verdict_visible_samples: trace.dom.filter(s => s.live_feedback.visible && s.assessment_states.some(state => state === 'PASS' || state === 'IMPROVE')).length,
      completed_review_visible_samples: trace.dom.filter(s => s.progress.visible && /Reviewing /.test(s.progress.text) && s.completed_attempt_assessment).length,
      last_review_visible_samples: trace.dom.filter(s => s.last_review.visible).length,
      red_overlay_samples: trace.dom.filter(s => s.overlay.red > 20).length,
      named_checks_visible_samples: trace.dom.filter(s => s.named_checks.visible).length,
      last_review_texts: [...new Set(trace.dom.filter(s => s.last_review.visible).map(s => s.last_review.text))],
      progress_texts: [...new Set(trace.dom.filter(s => s.progress.visible).map(s => s.progress.text.replace(/\b\d+\.\d s\b/g, '<elapsed>')))],
      actual_sequence_completions: trace.ticks.filter(t => t.temporal?.completed).length,
      motion_bout_completion_ticks: trace.ticks.filter(t => t.guided_completion?.source === 'motion_bout').length,
      maximum_displayed_completed_reps: Math.max(0, ...trace.dom.map(s => s.displayed_completed_reps ?? 0)),
      counter_exceeded_observed_completions: trace.dom.some(s => s.displayed_completed_reps !== null && s.displayed_completed_reps > s.observed_sequence_completions),
    },
    cues: trace.ticks.filter(t => t.feedback).map(t => t.feedback.text), speech_requests: trace.speech, session_review_persisted: Boolean(savedReview), errors: trace.errors };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
