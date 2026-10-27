/** Real PostgreSQL integration in a disposable schema. Never resets the supplied database. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { smokeBackendBundle } from './smoke_backend_bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connection = process.env.APEXFORMZ_TEST_DATABASE_URL;
if (!connection) throw new Error('APEXFORMZ_TEST_DATABASE_URL is required; PostgreSQL integration cannot be skipped');
const url = new URL(connection);
if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error('Integration requires a PostgreSQL connection');
const schema = `apexformz_it_${randomUUID().replaceAll('-', '')}`;
if (!/^apexformz_it_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid isolated schema name');
url.searchParams.set('schema', schema);
const directory = path.join(root, 'data', 'audit', 'postgres');
await mkdir(directory, { recursive: true });
const basename = new Date().toISOString().replaceAll(':', '-');
const testReport = path.join(directory, `${basename}.vitest.json`);
const reportPath = path.join(directory, `${basename}.json`);
const env = { ...process.env, DATABASE_URL: url.href, APEXFORMZ_INTEGRATION_SCHEMA: schema,
  NODE_ENV: 'test', ENABLE_JOB_DISPATCHER: 'false', JWT_SECRET: randomUUID() + randomUUID(),
  JWT_REFRESH_SECRET: randomUUID() + randomUUID() };
let admin;
const report = { schema, status: 'running', migrated: false, cleaned_up: false, tests: null, built_backend: null, backup_restore: null, error: null };
let created = false;
const command = (executable, args, childEnv = env) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd: root, env: childEnv, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}`)));
});
const run = (script, args) => command(process.execPath, [script, ...args]);
async function snapshot() {
  const tables = await admin.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = ${schema} ORDER BY tablename`;
  const result = {};
  for (const { tablename } of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablename)) throw new Error('Unexpected integration table name');
    const rows = await admin.$queryRawUnsafe(`SELECT row_to_json(t) AS row FROM "${schema}"."${tablename}" t`);
    const canonical = rows.map(r => JSON.stringify(r.row)).sort();
    result[tablename] = { rows: rows.length, sha256: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
  }
  return result;
}
try {
  // Generate before loading the native query engine, which Windows locks while connected.
  await run('node_modules/prisma/build/index.js', ['generate', '--schema', 'apps/backend/prisma/schema.prisma']);
  const { PrismaClient } = await import('@prisma/client');
  admin = new PrismaClient({ datasources: { db: { url: connection } } });
  await admin.$connect();
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  created = true;
  await run('node_modules/prisma/build/index.js', ['migrate', 'deploy', '--schema', 'apps/backend/prisma/schema.prisma']);
  report.migrated = true;
  // Re-running deploy must not change or replay any already applied migration.
  await run('node_modules/prisma/build/index.js', ['migrate', 'deploy', '--schema', 'apps/backend/prisma/schema.prisma']);
  await run('node_modules/vitest/vitest.mjs', ['run', '--config', 'apps/backend/vitest.postgres.config.ts',
    '--reporter=default', '--reporter=json', '--outputFile', testReport]);
  const tests = JSON.parse(await readFile(testReport, 'utf8'));
  if (!tests.success || !tests.numPassedTests || tests.numPendingTests || tests.numTodoTests || tests.numFailedTests) {
    throw new Error('PostgreSQL suite must pass without skipped or pending tests');
  }
  report.tests = { passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests };
  report.built_backend = await smokeBackendBundle(root, env);
  const before = await snapshot();
  const archive = path.join(directory, `${basename}.pgdump`);
  const pgEnv = { ...env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)) };
  const binary = name => process.env.APEXFORMZ_POSTGRES_BIN
    ? path.join(process.env.APEXFORMZ_POSTGRES_BIN, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  await command(binary('pg_dump'), ['--format=custom', '--no-owner', '--no-privileges', `--schema=${schema}`, `--file=${archive}`], pgEnv);
  await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await command(binary('pg_restore'), ['--exit-on-error', '--no-owner', '--no-privileges', `--dbname=${pgEnv.PGDATABASE}`, archive], pgEnv);
  const after = await snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Restored database content differs from backup snapshot');
  report.backup_restore = { status: 'passed', archive: path.relative(root, archive), tables: after };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      // This generated schema is the only destructive target. No public-schema or database reset.
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      report.cleaned_up = true;
    } catch (error) {
      report.status = 'failed';
      report.error = `isolated schema cleanup failed: ${error.message}`;
      process.exitCode = 1;
    }
  }
  await admin?.$disconnect();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, report: path.relative(root, reportPath) }, null, 2));
}
