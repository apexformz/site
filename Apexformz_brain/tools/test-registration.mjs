import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';

const env = dotenv.parse(fs.readFileSync('../Apexformz/apps/backend/.env'));
const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
const email = `registration-check-${randomUUID()}@example.test`;
const password = `Check-${randomUUID()}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/register');
  await page.locator('#register-name').fill('Registration Check');
  await page.locator('#register-email').fill(email);
  await page.locator('#register-password').fill(password);
  await page.route('**/api/auth/register', route => route.fulfill({ status: 502, body: 'Bad Gateway' }));
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('The account service is unavailable.', { exact: false }).waitFor();
  console.log('PASS: service outage has an actionable message');
  await page.unroute('**/api/auth/register');
  const registered = page.waitForResponse(r => r.url().endsWith('/api/auth/register'));
  await page.getByRole('button', { name: 'Create account' }).click();
  assert.equal((await registered).status(), 201);
  await page.waitForURL('**/dashboard', { timeout: 60000 });
  assert.ok(await page.evaluate(() => localStorage.getItem('access_token')));
  assert.ok(await db.user.findUnique({ where: { email } }));
  console.log('PASS: browser registration through web proxy saves account and signs in');
} finally {
  await browser?.close();
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
}
