import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Exercise the actual distributable server against the caller's disposable schema. */
export async function smokeBackendBundle(root, env) {
  const bundle = path.join(root, 'apps/backend/dist/server.cjs');
  if (!existsSync(bundle)) throw new Error('Build the backend before PostgreSQL integration');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [bundle], { cwd: root, windowsHide: true,
    env: { ...env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      CORS_ORIGIN: 'http://127.0.0.1:3000', APEXFORMZ_PACK_TRUST_MODE: 'development',
      SPORT_PACKS_DIR: path.join(root, 'sport-packs') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', data => { logs = (logs + data).slice(-4000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-4000); });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const base = `http://127.0.0.1:${port}`;
  const checks = [];
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnError || child.exitCode !== null) throw new Error(`Built backend exited before readiness: ${spawnError?.message ?? logs}`);
      try { ready = (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Built backend never became database-ready');
    checks.push('built-server-database-readiness');
    if (!(await fetch(`${base}/health`)).ok) throw new Error('Built backend health failed');
    checks.push('built-server-liveness');
    if ((await fetch(`${base}/api/v1/sport-packs`)).status !== 401) throw new Error('Built backend accepted anonymous v1 request');
    checks.push('built-server-authentication');
    const registration = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `bundle-${randomUUID()}@example.invalid`, password: randomUUID() + randomUUID(), name: 'Isolated bundle check', preferred_sport: 'squash' }) });
    if (registration.status !== 201) throw new Error(`Built backend registration failed (${registration.status}): ${await registration.text()}`);
    const account = await registration.json();
    const token = account.data?.tokens?.access_token ?? account.data?.access_token;
    if (!token) throw new Error('Built backend omitted registration access token');
    checks.push('built-server-register-and-persist');
    const packs = await fetch(`${base}/api/v1/sport-packs`, { headers: { Authorization: `Bearer ${token}` } });
    if (!packs.ok || !JSON.stringify(await packs.json()).includes('squash')) throw new Error('Built server cannot resolve and verify packaged sport packs');
    checks.push('built-server-authenticated-pack-verification');
    return { status: 'passed', checks };
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 12000).unref())]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}
