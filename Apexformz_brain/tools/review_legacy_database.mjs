import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const env = dotenv.parse(readFileSync('data/audit/operations/compose.env'));
const target = 'apexformz-ops-postgres-1';
const database = 'apexformz_baseline_' + randomUUID().replaceAll('-', '');
const directory = 'data/audit/operations';
const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (r.status !== 0) throw new Error(cmd + ' failed: ' + (r.stderr || '').slice(-1800));
  return r.stdout;
};
const psql = (sql, db = database) => run('docker', ['exec', '-i', target, 'psql', '-U', 'apexformz', '-d', db, '-v', 'ON_ERROR_STOP=1'], { input: sql });
const schema = readFileSync(path.join(directory, 'legacy-schema-before.sql'), 'utf8');
const url = 'postgresql://apexformz:' + env.POSTGRES_PASSWORD + '@127.0.0.1:55433/' + database;
let created = false;
try {
  run('docker', ['exec', target, 'createdb', '-U', 'apexformz', database]); created = true;
  psql(schema);
  const sql = run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-url', url,
    '--to-schema-datamodel', 'apps/backend/prisma/schema.prisma', '--script']);
  writeFileSync(path.join(directory, 'legacy-additive-delta.sql'), sql);
  if (/(^|\n)\s*(DROP|TRUNCATE|DELETE)\b|ALTER[^;]*\bDROP\b/im.test(sql)) throw new Error('Non-additive migration requires manual review');
  psql(sql);
  const drift = run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-url', url,
    '--to-schema-datamodel', 'apps/backend/prisma/schema.prisma', '--exit-code']);
  const cloneEnv = { ...process.env, DATABASE_URL: url };
  for (const migration of ['0001_brain_init', '0002_event_scope_job_leases', '0003_durable_analysis_output', '0004_private_s3_assets']) {
    run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'resolve', '--schema', 'apps/backend/prisma/schema.prisma',
      '--applied', migration], { env: cloneEnv });
  }
  const deploy = run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'apps/backend/prisma/schema.prisma'], { env: cloneEnv });
  const receipt = { status: 'passed', source: 'smartcoach-db (read-only schema export)', disposable_database: database,
    additive_only: true, schema_drift: drift.trim(), baseline_deploy: deploy.trim(), source_database_modified: false,
    note: 'Reviewed schema delta on a disposable clone. Actual data and production cutover require a backed-up target and operational approval.' };
  writeFileSync(path.join(directory, 'legacy-baseline-review.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (created) run('docker', ['exec', target, 'dropdb', '-U', 'apexformz', database]);
}

