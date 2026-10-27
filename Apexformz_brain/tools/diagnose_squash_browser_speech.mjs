/** Observe native speech events without substituting speech or pose results. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const out = 'data/audit/browser-squash/speech-diagnostic.json';
const fixture = JSON.parse(fs.readFileSync('data/audit/browser-squash/fixtures/manifest.json')).fixtures.find((f) => f.id === 'left');
const digest = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(digest(fixture.y4m_path), fixture.y4m_sha256);
const report = { purpose: 'native_speech_event_diagnostic', started_at: new Date().toISOString(),
  build_id: fs.readFileSync('apps/frontend/.next/BUILD_ID', 'utf8').trim(),
  tool_sha256: digest(new URL(import.meta.url)), fixture_sha256: fixture.y4m_sha256,
  headless: true, audible_output_verified: false, page_errors: [], status: 'running' };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${fixture.y4m_path}`, '--enable-unsafe-swiftshader', '--no-proxy-server'] });
try {
  report.browser = browser.version();
  const page = await browser.newPage({ permissions: ['camera'] });
  await page.route('**/*', (route) => new URL(route.request().url()).origin === 'http://127.0.0.1:3101' ? route.continue() : route.abort());
  page.on('pageerror', (e) => report.page_errors.push(e.message));
  await page.addInitScript((view) => {
    window.__speechDiagnostic = { events: [] };
    const p = window.__speechDiagnostic, synth = window.speechSynthesis;
    const record = (kind, extras = {}) => p.events.push({ kind, at_ms: performance.now(), ...extras });
    const speak = synth.speak.bind(synth), cancel = synth.cancel.bind(synth);
    synth.speak = (utterance) => {
      record('speak', { text: utterance.text, voices: synth.getVoices().length });
      for (const kind of ['start', 'end', 'error']) utterance.addEventListener(kind, (e) => record(kind, { error: e.error ?? null }));
      return speak(utterance);
    };
    synth.cancel = () => { record('cancel'); return cancel(); };
    localStorage.setItem('brain_setup_squash', JSON.stringify({ mode: 'development',
      calibration: { full_body_framing: true, nominal_view: view, handedness: 'right', handedness_assumed: false,
        camera_tilt_deg: null, floor_orientation_available: false, scale_known: false, scale_marker_m: null, athlete_context: 'unknown' } }));
  }, fixture.view);
  await page.goto(`http://127.0.0.1:3101/train/squash?movement=${fixture.movement_id}&mode=development`);
  await page.getByRole('region', { name: 'Squash movement recognition' }).getByText('On device', { exact: true }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'ENABLE CAMERA TO START' }).click();
  await page.getByTitle('Start session', { exact: true }).click();
  await page.waitForFunction(() => window.__speechDiagnostic.events.some((e) => e.kind === 'speak'), null, { timeout: 60000 });
  await page.waitForTimeout(8000);
  await page.getByTitle('Toggle camera', { exact: true }).click();
  await page.getByText('Camera is disabled', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  report.observed = await page.evaluate(() => ({ ...window.__speechDiagnostic,
    voices: speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang, localService: v.localService })) }));
  await page.getByTitle('Finish session', { exact: true }).click();
  await page.waitForURL('**/results/**');
  assert.equal(report.page_errors.length, 0);
  report.status = 'observed';
} catch (e) { report.status = 'failed'; report.error = e.stack ?? String(e); }
finally { await browser.close(); report.finished_at = new Date().toISOString(); fs.writeFileSync(out, JSON.stringify(report, null, 2)+'\n'); }
console.log(JSON.stringify(report));
if (report.status === 'failed') process.exitCode = 1;
