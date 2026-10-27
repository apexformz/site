import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assertAdditiveBootstrap, parseArguments, resolveEnvironment, validateConfiguration } from './web-backend.mjs';

test('web configuration preserves process overrides and resolves the canonical pack directory', () => {
  const root = path.resolve('brain'), web = path.resolve('web');
  const env = resolveEnvironment({ PORT: '4000', JWT_SECRET: 'file', DATABASE_URL: 'postgresql://file/db' }, { PORT: '4100', JWT_SECRET: 'caller' }, web, root);
  assert.equal(env.PORT, '4100');
  assert.equal(env.JWT_SECRET, 'caller');
  assert.equal(env.SPORT_PACKS_DIR, path.join(root, 'sport-packs'));
  assert.equal(env.ENABLE_JOB_DISPATCHER, 'false');
  assert.equal(env.DATABASE_URL, 'postgresql://file/db');
});

test('explicit relative pack paths are interpreted from the web backend environment location', () => {
  const web = path.resolve('web');
  assert.equal(resolveEnvironment({ SPORT_PACKS_DIR: '../../packs' }, {}, web).SPORT_PACKS_DIR, path.join(web, 'packs'));
});

test('configuration errors identify missing keys without revealing values', () => {
  assert.throws(() => validateConfiguration({ DATABASE_URL: 'secret-value' }, 'db:plan'), { message: 'DATABASE_URL must be a PostgreSQL URL' });
  assert.throws(() => validateConfiguration({ DATABASE_URL: 'postgresql://local/db', JWT_SECRET: 'private' }, 'dev'), /Missing JWT_REFRESH_SECRET/);
  assert.doesNotThrow(() => validateConfiguration({}, 'build'));
});

test('CLI accepts a path with spaces without shell interpolation', () => {
  const parsed = parseArguments(['--web-root', 'a folder/web', 'db:plan']);
  assert.equal(parsed.command, 'db:plan');
  assert.equal(parsed.webRoot, path.resolve('a folder/web'));
  assert.throws(() => parseArguments(['db:reset']), /Usage/);
  assert.throws(() => parseArguments(['--web-root']), /requires a directory/);
});

test('bootstrap permits new tables and their indexes and foreign keys', () => {
  const sql = `-- new table only\nCREATE TABLE "BrainSession" ("id" TEXT PRIMARY KEY, "name" TEXT DEFAULT 'a; b');\nCREATE UNIQUE INDEX "BrainSession_id_key" ON "BrainSession"("id");\nALTER TABLE "BrainSession" ADD CONSTRAINT "example" FOREIGN KEY ("id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;`;
  assert.deepEqual(assertAdditiveBootstrap(sql), { statements: 3, tables: ['BrainSession'] });
});

test('bootstrap refuses destructive SQL and any change to an existing table', () => {
  for (const sql of [
    'DROP TABLE "User";',
    'TRUNCATE TABLE "User";',
    'ALTER TABLE "User" DROP COLUMN "email";',
    'ALTER TABLE "User" ADD COLUMN "extra" TEXT;',
    'CREATE UNIQUE INDEX "User_email_key" ON "User"("email");',
    'DELETE FROM "User";',
    'CREATE TABLE "New" ("id" TEXT); DROP TABLE "User";',
  ]) assert.throws(() => assertAdditiveBootstrap(sql), /No SQL was applied/);
});

test('an already prepared database is a no-op', () => {
  assert.deepEqual(assertAdditiveBootstrap('-- This is an empty migration.\n'), { statements: 0, tables: [] });
});
