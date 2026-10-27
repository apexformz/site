/** Browser regression for changing a saved static drill to dynamic training. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

const base = process.env.APEXFORMZ_WEB_TEST_URL || 'http://localhost:3000';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const env = dotenv.parse(fs.readFileSync(path.resolve('../Apexformz/apps/backend/.env')));
const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
let browser, userId;
try {
  const id = randomUUID();
  const response = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Selection Test', email: `selection-${id}@example.test`, password: `Test-${id}`, preferred_sport: 'squash' }) });
  const { data: auth } = await response.json();
  assert.ok(response.ok && auth?.user);
  userId = auth.user.id;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  await context.addInitScript(({ access, refresh }) => {
    localStorage.setItem('access_token', access);
    localStorage.setItem('refresh_token', refresh);
    if (!sessionStorage.getItem('selection-test-seeded')) {
      localStorage.setItem('brain_setup_squash', JSON.stringify({ movement_id: 'squash.static.0031', mode: 'development', calibration: { full_body_framing: true, camera_tilt_deg: null, nominal_view: 'front', handedness: 'right', handedness_assumed: false, floor_orientation_available: false, scale_known: false, scale_marker_m: null, athlete_context: 'unknown' } }));
      sessionStorage.setItem('selection-test-seeded', '1');
    }
  }, { access: auth.access_token, refresh: auth.refresh_token });
  const page = await context.newPage();
  await page.goto(`${base}/train/squash/setup`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('[data-testid="selected-training-type"]')?.textContent?.startsWith('Static position'));
  assert.equal(await page.getByRole('button', { name: /Enter training studio/ }).isEnabled(), true);
  await page.getByRole('button', { name: 'Dynamic movements', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /Enter training studio/ }).isDisabled(), true);
  assert.match(await page.getByTestId('selected-training-type').innerText(), /^Choose a dynamic movement$/i);
  await page.getByRole('textbox', { name: 'Search movements' }).fill('Backhand swing');
  await page.getByRole('button', { name: /^Backhand swing Dynamic movement/ }).first().click();
  assert.match(await page.getByTestId('camera-view-guidance').innerText(), /back view supports more/);
  assert.equal(await page.getByRole('button', { name: /Enter training studio/ }).isEnabled(), true);
  await page.getByRole('button', { name: /Enter training studio/ }).click();
  await page.waitForURL(/movement=squash.dynamic.0040/, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="selected-drill-name"]')?.textContent === 'Backhand swing');
  assert.equal(await page.getByTestId('selected-drill-name').innerText(), 'Backhand swing');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('brain_setup_squash')).movement_id), 'squash.dynamic.0040');
  console.log('Passed: changing Static to Dynamic clears the old selection, requires an explicit drill, and launches/persists Backhand swing.');
} finally {
  await browser?.close();
  if (userId) { await db.brainSession.deleteMany({ where: { athlete_id: userId } }); await db.user.delete({ where: { id: userId } }); }
  await db.$disconnect();
}
