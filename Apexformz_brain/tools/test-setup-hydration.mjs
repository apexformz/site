import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error' && /hydrat|server rendered/i.test(message.text())) errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('brain_setup_squash', JSON.stringify({
    movement_id: 'squash.dynamic.0014', mode: 'development', pose_backend: 'mediapipe',
    calibration: { full_body_framing: true, camera_tilt_deg: 5, nominal_view: 'left', handedness: 'left', handedness_assumed: false, floor_orientation_available: false, scale_known: false, scale_marker_m: null, athlete_context: 'advanced' },
  })));
  for (let visit = 0; visit < 2; visit++) {
    await page.goto('http://localhost:3000/train/squash/setup', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Enter training studio/ }).waitFor();
    assert.equal(await page.locator('select').nth(0).inputValue(), 'left');
    assert.equal(await page.locator('select').nth(1).inputValue(), 'left');
    assert.match(await page.getByRole('button', { name: /Coaching preview/ }).getAttribute('class'), /border-accent-warning\/60/);
    assert.deepEqual(errors, []);
  }
  console.log('PASS: saved preview mode and calibration restored across full page loads without hydration or runtime errors');
} finally { await browser.close(); }
