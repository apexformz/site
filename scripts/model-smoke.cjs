/* Targeted, read-only WebGL athlete checks against the local frontend. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
function loadPlaywright() {
  for (const candidate of [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    path.join(
      os.homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
    ),
  ].filter(Boolean)) {
    try {
      return require(candidate);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Install Playwright or set PLAYWRIGHT_MODULE.');
}
const { chromium } = loadPlaywright();
const BASE = process.env.UI_BASE_URL || 'http://127.0.0.1:3000';

const output = path.resolve(
  __dirname,
  '../outputs/reference-athlete/ui-checks',
);
const hash = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const report = { checks: [], errors: [] };
  async function context(options = {}) {
    const result = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ...options,
    });
    await result.addInitScript(() =>
      localStorage.setItem('apexformz-theme', 'light'),
    );
    return result;
  }
  try {
    const desktop = await context();
    const page = await desktop.newPage();
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.screenshot({
      path: path.join(output, 'model-before-load.png'),
      fullPage: false,
    });
    report.initialPage = {
      url: page.url(),
      text: (await page.locator('body').innerText()).slice(0, 1200),
    };
    const model = page.locator('[data-render-state]');
    await model.waitFor();
    await model.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-render-state]')?.dataset.renderState ===
        'ready',
      null,
      { timeout: 120000 },
    );
    await page.waitForTimeout(1000);
    assert.equal(
      await model.getAttribute('data-model-source'),
      '/models/apex-athlete-reference.glb',
    );
    const asset = await page.request.get(
      `${BASE}/models/apex-athlete-reference.glb`,
    );
    assert.equal(asset.status(), 200);
    const binary = await asset.body();
    assert.equal(binary.toString('ascii', 0, 4), 'glTF');
    const provenance = JSON.parse(
      await fs.readFile(
        path.resolve(__dirname, '../assets/apex-athlete-reference.json'),
        'utf8',
      ),
    );
    assert.equal(hash(binary), provenance.model.sha256);
    report.checks.push('Homepage loads the generated reference GLB');
    await page.screenshot({
      path: path.join(output, 'model-initial.png'),
      fullPage: false,
    });
    const canvas = model.locator('canvas');
    await canvas.evaluate((element) => {
      element.style.background = '#eef2f8';
    });
    const moving1 = hash(
      await canvas.screenshot({
        path: path.join(output, 'model-loop-a.png'),
      }),
    );
    await page.waitForTimeout(450);
    const moving2 = hash(
      await canvas.screenshot({
        path: path.join(output, 'model-loop-b.png'),
      }),
    );
    assert.notEqual(
      moving1,
      moving2,
      'The spatial presentation loop should change the rendered frames',
    );
    report.checks.push('Reference model loop changes rendered frames');
    await page.getByRole('button', { name: 'Pause athlete animation' }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-render-state]')?.dataset.motion ===
        'paused',
    );
    const paused1 = hash(await canvas.screenshot());
    await page.waitForTimeout(400);
    const paused2 = hash(await canvas.screenshot());
    assert.equal(paused1, paused2, 'Paused WebGL frames should be identical');
    report.checks.push('Pause freezes exact frame');
    await canvas.evaluate((element) => {
      element.style.background = '';
    });
    await page.getByRole('button', { name: 'Play athlete animation' }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-render-state]')?.dataset.motion ===
        'playing',
    );
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(
      () =>
        document.querySelector('[data-render-state]')?.dataset.motion ===
        'paused',
    );
    report.checks.push('Offscreen animation pauses');
    await model.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-render-state]')?.dataset.motion ===
        'playing',
    );
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await model.getAttribute('data-motion'), 'paused');
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    report.checks.push('Visibility change pauses animation');
    await canvas.evaluate((element) =>
      element
        .getContext('webgl2')
        .getExtension('WEBGL_lose_context')
        .loseContext(),
    );
    await page.waitForFunction(
      () =>
        document.querySelector('[data-render-state]')?.dataset.renderState ===
        'unavailable',
    );
    await page.getByText('Athlete illustration', { exact: false }).waitFor();
    assert.equal(await model.locator('canvas').count(), 0);
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-render-state] img'))
          .opacity === '1',
    );
    assert.equal(
      await model
        .locator('img')
        .evaluate((element) => getComputedStyle(element).opacity),
      '1',
    );
    report.checks.push('Context loss restores illustration and removes canvas');
    const fallback = await page.request.get(
      `${BASE}/images/apex-athlete-reference.png`,
    );
    assert.equal(hash(await fallback.body()), provenance.reference.sha256);
    report.checks.push('Fallback is the exact supplied picture');
    const reduced = await context({
      reducedMotion: 'reduce',
      viewport: { width: 390, height: 844 },
    });
    const reducedPage = await reduced.newPage();
    reducedPage.on('pageerror', (error) => report.errors.push(error.message));
    await reducedPage.goto(BASE, {
      waitUntil: 'domcontentloaded',
    });
    const reducedModel = reducedPage.locator('[data-render-state]');
    await reducedModel.scrollIntoViewIfNeeded();
    await reducedPage.waitForFunction(
      () =>
        document.querySelector('[data-render-state]')?.dataset.renderState ===
        'ready',
      null,
      { timeout: 120000 },
    );
    await reducedPage.waitForTimeout(600);
    assert.equal(await reducedModel.getAttribute('data-motion'), 'reduced');
    const reducedCanvas = reducedModel.locator('canvas');
    await reducedCanvas.evaluate((element) => {
      element.style.background = '#eef2f8';
    });
    const static1 = hash(await reducedCanvas.screenshot());
    await reducedPage.waitForTimeout(400);
    assert.equal(static1, hash(await reducedCanvas.screenshot()));
    await reducedCanvas.evaluate((element) => {
      element.style.background = '';
    });
    await reducedPage.screenshot({
      path: path.join(output, 'model-mobile-reduced.png'),
      fullPage: false,
    });
    report.checks.push('Reduced motion remains static on mobile');
    assert.equal(
      await reducedPage
        .getByRole('button', { name: 'Pause athlete animation' })
        .count(),
      0,
    );
    report.checks.push('Reduced motion hides pause control');
    for (const width of [390, 320]) {
      await reducedPage.setViewportSize({ width, height: 844 });
      await reducedModel.scrollIntoViewIfNeeded();
      await reducedPage.waitForTimeout(300);
      const stage = await reducedPage
        .locator('.performance-model-stage')
        .boundingBox();
      const caption = await reducedPage.locator('.scene-caption').boundingBox();
      assert(
        caption.y >= stage.y + stage.height,
        'Caption must remain outside the athlete viewport',
      );
      assert(
        await reducedPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await reducedPage
        .getByRole('button', { name: 'Switch to night theme' })
        .click();
      await reducedModel.scrollIntoViewIfNeeded();
      await reducedPage.waitForTimeout(300);
      await reducedPage.screenshot({
        path: path.join(output, `model-mobile-${width}-dark.png`),
      });
      await reducedPage
        .getByRole('button', { name: 'Switch to day theme' })
        .click();
    }
    report.checks.push('Mobile day/night framing keeps the caption clear');
    const missingContext = await context({ reducedMotion: 'reduce' });
    await missingContext.route(
      '**/models/apex-athlete-reference.glb',
      (route) =>
        route.fulfill({ status: 503, body: 'Fixture: unavailable model' }),
    );
    const missingPage = await missingContext.newPage();
    missingPage.on('pageerror', (error) => report.errors.push(error.message));
    await missingPage.goto(BASE, { waitUntil: 'domcontentloaded' });
    const missingModel = missingPage.locator('[data-render-state]');
    await missingModel.scrollIntoViewIfNeeded();
    await missingPage.waitForFunction(
      () =>
        document.querySelector('[data-render-state]')?.dataset.renderState ===
        'unavailable',
    );
    assert.equal(await missingModel.locator('canvas').count(), 0);
    await missingModel.locator('img').waitFor({ state: 'visible' });
    assert.equal(
      await missingPage
        .getByRole('button', { name: 'Pause athlete animation' })
        .count(),
      0,
    );
    report.checks.push(
      'A failed model download keeps the supplied picture visible',
    );
    assert.deepEqual(report.errors, []);
  } catch (error) {
    report.failure = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    await fs.writeFile(
      path.join(output, 'model-report.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    await browser.close();
  }
})();
