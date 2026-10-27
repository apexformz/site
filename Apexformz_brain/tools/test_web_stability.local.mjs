/** Real browser/API smoke test. Camera input is an existing recorded squash fixture; inference is not mocked. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

const root = process.cwd();
const base = process.env.APEXFORMZ_WEB_TEST_URL || 'http://localhost:3001';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Only local integration servers are allowed');
const output = path.join(root, 'data/audit/web-stability');
fs.mkdirSync(output, { recursive: true });
const report = { started_at: new Date().toISOString(), url: base, camera: 'recorded squash fixture; no physical camera', checks: [], errors: [] };
const env = dotenv.parse(fs.readFileSync(path.join(root, '../Apexformz/apps/backend/.env')));
const database = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
let browser, context, page, userId;
const id = randomUUID();
const request = async (url, options = {}) => {
  const response = await fetch(`${base}${url}`, options);
  const body = await response.json();
  assert.ok(response.ok, `${url} returned ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};
try {
  const manifest = await request('/api/brain/sport-packs/squash/manifest');
  const catalog = await request(`/api/brain/sport-packs/squash/assets/${manifest.movements}`);
  assert.equal(catalog.movements.length, 184);
  report.checks.push('Verified squash pack and full 184-movement catalog served by web');
  const registration = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Integration Check', email: `web-integration-${id}@example.test`, password: `Check-${id}`, preferred_sport: 'squash' }) });
  const auth = registration.data;
  userId = auth.user.id;
  report.checks.push('Web same-origin API proxy and account creation');
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${path.join(root, 'data/audit/browser-squash/fixtures/front.y4m')}`,
    '--enable-unsafe-swiftshader',
  ] });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera'] });
  await context.addInitScript(({ access, refresh }) => {
    localStorage.setItem('access_token', access);
    localStorage.setItem('refresh_token', refresh);
    const state = window.__brainCheck = { ready: false, models: 0, ticks: 0, poses: 0, detections: 0, inferred: {}, states: [], errors: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.requests = new Map();
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'ready') state.ready = true;
          if (data.type === 'state') state.states.push(data.state);
          if (data.type === 'tick') state.ticks++;
          if (data.type === 'pose') state.poses++;
          if (data.type === 'movement_detection') {
            state.detections++;
            if (Object.keys(data.detection.probabilities ?? {}).length) state.inferred[data.detection.model_task] = (state.inferred[data.detection.model_task] ?? 0) + 1;
          }
          if (data.type === 'error') state.errors.push(data.message || data.error?.message || data.code);
          if (data.type === 'ok' && this.requests.get(data.id) === 'load_movement_models') state.models = data.result.length;
        });
      }
      postMessage(message, ...args) { if (message.id) this.requests.set(message.id, message.type); super.postMessage(message, ...args); }
    };
  }, { access: auth.access_token, refresh: auth.refresh_token });
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${base}/train/squash/setup`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('textbox', { name: 'Search movements' }).fill('Court recovery movement');
  await page.getByRole('button', { name: /Court recovery movement/ }).first().click();
  await page.screenshot({ path: path.join(output, 'setup.png'), fullPage: true });
  await page.getByRole('button', { name: /Enter training studio/ }).click();
  await page.waitForURL(/\/train\/squash\?movement=/, { timeout: 60000 });
  await page.waitForFunction(() => window.__brainCheck?.ready && window.__brainCheck.models === 2, null, { timeout: 180000 });
  report.checks.push('Setup selects a pack movement; both real squash models load in Brain worker');
  await page.getByRole('button', { name: 'ENABLE CAMERA TO START', exact: true }).click();
  await page.getByTitle('Start session', { exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('button[title="Start session"]')?.disabled, null, { timeout: 60000 });
  await page.getByTitle('Start session', { exact: true }).click();
  await page.waitForFunction(() => window.__brainCheck?.ticks >= 600 && window.__brainCheck.inferred.static_pose > 0 && window.__brainCheck.inferred.dynamic_movement > 0, null, { timeout: 180000 });
  report.runtime = await page.evaluate(() => window.__brainCheck);
  assert.equal(report.runtime.models, 2);
  assert.ok(report.runtime.poses > 0);
  assert.ok(report.runtime.states.includes('ACTIVE') || report.runtime.states.includes('DEGRADED'));
  await page.screenshot({ path: path.join(output, 'training.png'), fullPage: true });
  report.checks.push('Recorded camera input produces real poses, Brain ticks and probability outputs from both static and dynamic models');
  await page.getByTitle('Toggle camera', { exact: true }).click();
  await page.waitForFunction(() => window.__brainCheck?.states.includes('PAUSED'), null, { timeout: 15000 });
  await page.getByTitle('Toggle camera', { exact: true }).click();
  report.checks.push('Camera stop pauses session and can resume');
  // Deliberate network fault: the completed result must stay reviewable and retryable.
  await page.route('**/api/v1/sessions/*/complete', route => route.abort());
  await page.getByTitle('Finish session', { exact: true }).click();
  await page.waitForURL(/\/results\//, { timeout: 60000 });
  await page.getByRole('heading', { name: 'Technique feedback', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Retry account save' }).waitFor();
  await page.unroute('**/api/v1/sessions/*/complete');
  await page.getByRole('button', { name: 'Retry account save' }).click();
  await page.getByText('Saved to your account', { exact: false }).waitFor({ timeout: 30000 });
  report.checks.push('Deliberately failed completion remains reviewable and saves successfully through the retry button');
  const sessionId = new URL(page.url()).pathname.split('/').pop();
  const saved = await request(`/api/v1/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${auth.access_token}` } });
  assert.equal(saved.data.athlete_id, userId);
  assert.equal(saved.data.movement_id, 'squash.dynamic.0014');
  assert.equal(saved.data.summary.last_score, null);
  assert.ok(saved.data.summary.frames_processed > 0);
  assert.ok(saved.data.duration_s > 0);
  assert.equal(saved.data.completion_sync, 'synced');
  report.saved_session = { session_id: sessionId, frames: saved.data.summary.frames_processed, duration_s: saved.data.duration_s, score: saved.data.summary.last_score, xp: saved.data.xp_earned };
  await page.screenshot({ path: path.join(output, 'results.png'), fullPage: true });
  report.checks.push('Session completion persists real frames, duration, null score and XP');
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('brain_session_')) localStorage.removeItem(key); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Technique feedback', exact: true }).waitFor();
  assert.ok((await page.locator('body').innerText()).includes('Saved to your account'));
  report.checks.push('Results reload from authenticated backend after clearing browser session cache');
  await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  await page.locator(`a[href="/results/${sessionId}"]`).waitFor({ timeout: 30000 });
  assert.ok((await page.locator(`a[href="/results/${sessionId}"]`).innerText()).includes('Not scored'));
  await page.screenshot({ path: path.join(output, 'dashboard.png'), fullPage: true });
  report.checks.push('Brain session appears in dashboard history with Not scored');
  assert.deepEqual(report.errors, [], 'No uncaught browser errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.stack;
  if (page) {
    report.page_text = (await page.locator('body').innerText().catch(() => '')).slice(0, 7000);
    report.runtime = await page.evaluate(() => window.__brainCheck).catch(() => null);
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (userId) {
    await database.brainSession.deleteMany({ where: { athlete_id: userId } });
    await database.user.delete({ where: { id: userId } });
    report.fixture_account_removed = true;
  }
  await database.$disconnect();
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

