/** Run the canonical Brain API for the separate Apexformz web project. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const brainRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRoot = path.join(brainRoot, 'apps/backend');
const require = createRequire(path.join(brainRoot, 'package.json'));
const commands = new Set(['dev', 'build', 'start', 'typecheck', 'db:generate', 'db:plan', 'db:prepare']);

export function parseArguments(args) {
  let webRoot = path.resolve(brainRoot, '../Apexformz');
  let command;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--web-root') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--web-root requires a directory');
      webRoot = path.resolve(args[++i]);
    } else if (!command && commands.has(args[i])) command = args[i];
    else throw new Error('Usage: node tools/web-backend.mjs [--web-root <Apexformz directory>] dev|build|start|typecheck|db:generate|db:plan|db:prepare');
  }
  return { command: command ?? 'dev', webRoot };
}

export function resolveEnvironment(fileValues, inherited, webRoot, root = brainRoot) {
  // Do not override a supplied process environment, including empty values.
  const env = { ...fileValues, ...Object.fromEntries(Object.entries(inherited).filter(([, value]) => value !== undefined)) };
  env.NODE_ENV ??= 'development';
  env.PORT ??= '4000';
  env.CORS_ORIGIN ??= 'http://localhost:3000';
  env.SPORT_PACKS_DIR = env.SPORT_PACKS_DIR
    ? path.resolve(path.join(webRoot, 'apps/backend'), env.SPORT_PACKS_DIR)
    : path.join(root, 'sport-packs');
  // Live squash inference is entirely local. Retrospective jobs remain an explicit opt-in.
  env.ENABLE_JOB_DISPATCHER ??= 'false';
  return env;
}

export function validateConfiguration(env, command) {
  const required = ['dev', 'start'].includes(command)
    ? ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET']
    : command.startsWith('db:') && command !== 'db:generate' ? ['DATABASE_URL'] : [];
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}. Configure the web project's apps/backend/.env or the process environment.`);
  if (env.DATABASE_URL) {
    let database;
    try { database = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
}

/** Split Prisma-generated SQL without treating semicolons in quoted names/values as separators. */
function sqlStatements(sql) {
  const result = [];
  let current = '', quote = null, lineComment = false, blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (lineComment) { if (c === '\n') { lineComment = false; current += '\n'; } continue; }
    if (blockComment) { if (c === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (!quote && c === '-' && next === '-') { lineComment = true; i++; continue; }
    if (!quote && c === '/' && next === '*') { blockComment = true; i++; continue; }
    if (quote) {
      current += c;
      if (c === quote && next === quote) { current += next; i++; }
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"') { quote = c; current += c; }
    else if (c === ';') { if (current.trim()) result.push(current.trim()); current = ''; }
    else current += c;
  }
  if (quote || blockComment) throw new Error('Incomplete database plan');
  if (current.trim()) result.push(current.trim());
  return result;
}

/** Bootstrap only new tables and their indexes/foreign keys. Existing tables are never altered. */
export function assertAdditiveBootstrap(sql) {
  const statements = sqlStatements(sql);
  const created = new Set();
  const identifier = '(?:"[^"\\n]+"\\.)?"([^"\\n]+)"';
  const table = new RegExp(`^CREATE TABLE ${identifier}\\s*\\(`, 'i');
  for (const statement of statements) {
    const match = statement.match(table);
    if (match) created.add(match[1]);
  }
  for (const statement of statements) {
    if (table.test(statement)) continue;
    if (/^CREATE SCHEMA (?:IF NOT EXISTS )?"[^"\n]+"$/i.test(statement)) continue;
    const index = statement.match(new RegExp(`^CREATE (?:UNIQUE )?INDEX "[^"\\n]+" ON ${identifier}\\s*\\(`, 'i'));
    if (index && created.has(index[1])) continue;
    const foreignKey = statement.match(new RegExp(`^ALTER TABLE ${identifier} ADD CONSTRAINT "[^"\\n]+" FOREIGN KEY\\s*\\(`, 'i'));
    if (foreignKey && created.has(foreignKey[1]) && !/\b(?:DROP|ALTER COLUMN|ADD COLUMN)\b/i.test(statement)) continue;
    throw new Error('Database setup refused: the plan changes an existing table or contains unsupported SQL. Use db:plan and the reviewed migration workflow in apps/backend/prisma/migrations/README.md. No SQL was applied.');
  }
  return { statements: statements.length, tables: [...created] };
}

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  const found = candidates.find(candidate => /npm-cli\.(?:js|cjs)$/.test(candidate) && existsSync(candidate));
  if (!found) throw new Error('Cannot find npm-cli.js beside Node. Run this launcher through npm, or install Node with npm.');
  return found;
}

export async function main(args = process.argv.slice(2)) {
  const { command, webRoot } = parseArguments(args);
  if (!existsSync(path.join(webRoot, 'apps/backend/package.json'))) throw new Error('The web project must contain apps/backend/package.json');
  const dotenv = require('dotenv');
  let fileValues = {};
  try { fileValues = dotenv.parse(await readFile(path.join(webRoot, 'apps/backend/.env'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read the web backend environment file'); }
  const env = resolveEnvironment(fileValues, process.env, webRoot);
  validateConfiguration(env, command);
  const prisma = require.resolve('prisma/build/index.js');
  let activeChild = null, stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    if (!activeChild || activeChild.exitCode !== null) return;
    const child = activeChild;
    if (process.platform === 'win32') {
      // npm and the dev watcher both have descendants; terminate only this launcher's process tree.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    }
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const run = (script, childArgs, { capture = false, input } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...childArgs], {
      cwd: backendRoot, env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'pipe'],
    });
    activeChild = child;
    let stdout = '', pendingStderr = '';
    const emitStderr = text => {
      // Prisma sometimes includes the connection URL in diagnostics. Never emit credentials.
      let safe = text;
      for (const key of ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET']) if (env[key]) safe = safe.replaceAll(env[key], `[${key}]`);
      safe = safe.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[DATABASE_URL]');
      if (safe) process.stderr.write(safe);
    };
    child.stdout?.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => {
      pendingStderr += bytes;
      const lastNewline = pendingStderr.lastIndexOf('\n');
      if (lastNewline >= 0) {
        emitStderr(pendingStderr.slice(0, lastNewline + 1));
        pendingStderr = pendingStderr.slice(lastNewline + 1);
      }
    });
    if (input !== undefined) child.stdin.end(input);
    child.on('error', error => { activeChild = null; reject(new Error(`Could not start backend command (${error.code ?? 'process error'})`)); });
    child.on('close', code => {
      activeChild = null;
      emitStderr(pendingStderr);
      if (code === 0 || stopping) resolve(stdout);
      else reject(new Error(`Brain backend ${command} failed (exit ${code ?? 'signal'}).`));
    });
  });
  try {
    if (command === 'db:plan' || command === 'db:prepare') {
      // Connection secrets travel through the environment, never command-line arguments.
      const sql = await run(prisma, ['migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'], { capture: true });
      if (stopping) return;
      if (command === 'db:plan') { process.stdout.write(sql); return; }
      const plan = assertAdditiveBootstrap(sql);
      if (!plan.statements) { console.log('Database already matches the Brain schema.'); return; }
      console.log(`Adding ${plan.tables.length} missing tables in one transaction; existing tables are preserved.`);
      await run(prisma, ['db', 'execute', '--stdin', '--schema', 'prisma/schema.prisma'], { input: `BEGIN;\n${sql}\nCOMMIT;\n` });
      if (!stopping) console.log('Brain database tables prepared. Existing migration history was not modified.');
    } else {
      console.log(`Using the Brain backend for ${path.basename(webRoot)} (${command}).`);
      await run(npmCli(), ['run', command]);
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
