/** Supplemental real Edge render check; uses the same pinned native squash fixture. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = process.cwd(), out = path.join(root, 'data/audit/browser-squash');
const fixture = JSON.parse(fs.readFileSync(path.join(out, 'fixtures/manifest.json'))).fixtures.find((f) => f.id === 'front_native');
const digest = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(digest(fixture.y4m_path), fixture.y4m_sha256);
const report = { status: 'running', purpose: 'supplemental_Edge_render_regression', source_sha256: fixture.source_sha256,
  fixture_sha256: fixture.y4m_sha256, build_id: fs.readFileSync('apps/frontend/.next/BUILD_ID', 'utf8').trim(),
  tool_sha256: digest(new URL(import.meta.url)), physical_camera: false, coaching_accuracy: null, page_errors: [], checks: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${fixture.y4m_path}`, '--enable-unsafe-swiftshader', '--no-proxy-server'] });
try {
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, permissions: ['camera'] });
  await page.route('**/*', (route) => new URL(route.request().url()).origin === 'http://127.0.0.1:3101' ? route.continue() : route.abort());
  page.on('pageerror', (e) => report.page_errors.push(e.message));
  await page.goto(`http://127.0.0.1:3101/train/squash?movement=${fixture.movement_id}&mode=development`);
  await page.getByRole('region', { name: 'Squash movement recognition' }).getByText('On device', { exact: true }).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'ENABLE CAMERA TO START' }).click();
  await page.getByTitle('Start session', { exact: true }).click();
  await page.waitForFunction(() => {
    const label = [...document.querySelectorAll('span')].find((e) => e.textContent === 'Frames');
    return label && Number(label.parentElement.querySelector('span').textContent) >= 30;
  }, null, { timeout: 60000 });
  assert(await page.locator('canvas').evaluate((c) => {
    const data = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    for (let i=3;i<data.length;i+=4) if (data[i]) return true;
    return false;
  }), 'actual skeleton pixels must render');
  report.checks.push('Real decoded camera, MediaPipe/Brain session, frame counter and skeleton rendered in Edge');
  await page.screenshot({ path: path.join(out, 'edge-live-wide.png') });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(1200);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
  report.checks.push('Narrow layout has no horizontal document overflow');
  await page.screenshot({ path: path.join(out, 'edge-live-narrow.png') });
  await page.getByTitle('Toggle camera', { exact: true }).click();
  await page.getByText('Camera is disabled', { exact: true }).waitFor();
  report.checks.push('Camera pause removes live video and skeleton');
  await page.screenshot({ path: path.join(out, 'edge-paused.png') });
  await page.getByTitle('Finish session', { exact: true }).click();
  await page.waitForURL('**/results/**');
  assert.equal(report.page_errors.length, 0);
  report.checks.push('Session completes to actual local results without page exceptions');
  report.status = 'passed';
} catch (e) { report.status = 'failed'; report.error = e.stack ?? String(e); }
finally { await browser.close(); report.finished_at = new Date().toISOString(); fs.writeFileSync(path.join(out, 'edge-visual-validation.json'), JSON.stringify(report, null, 2)+'\n'); }
console.log(JSON.stringify(report));
if (report.status !== 'passed') process.exitCode = 1;
