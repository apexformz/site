/** Install the squash integration into the existing interface, preserving a backup of changed files. */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { preflightWebInterface, prepareWebInterface } from './prepare-web-interface.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const index = process.argv.indexOf('--web-root');
const web = path.resolve(index < 0 ? path.join(root, '../Apexformz') : process.argv[index + 1]);
const overlay = path.join(root, 'integration/web-overlay');
const frontend = path.join(web, 'apps/frontend');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const webPackage = await readJson(path.join(web, 'package.json'));
const frontPackage = await readJson(path.join(frontend, 'package.json'));
const backPackage = await readJson(path.join(web, 'apps/backend/package.json'));
const tsconfig = await readJson(path.join(frontend, 'tsconfig.json'));
const brainPackage = await readJson(path.join(root, 'apps/frontend/package.json'));
const files = new Map();
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative);
    else files.set(relative, await readFile(path.join(directory, entry.name)));
  }
}
await collect(overlay);
const stringify = value => `${JSON.stringify(value, null, 2)}\n`;
webPackage.scripts = {
  ...webPackage.scripts,
  dev: 'concurrently --kill-others-on-fail "npm run dev:backend" "npm run dev:frontend"',
  'dev:frontend': 'npm run dev --workspace=apps/frontend --',
  'dev:backend': 'node scripts/brain-backend.mjs dev',
  'build:frontend': 'npm run build --workspace=apps/frontend',
  'build:backend': 'node scripts/brain-backend.mjs build',
  build: 'npm run build:backend && npm run build:frontend',
  'db:generate': 'node scripts/brain-backend.mjs db:generate',
  'db:plan': 'node scripts/brain-backend.mjs db:plan',
  'db:prepare': 'node scripts/brain-backend.mjs db:prepare',
  'db:push': 'npm run db:prepare',
  postinstall: 'npm run db:generate',
  'prepare:brain': 'node scripts/prepare-brain.mjs',
  demo: 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-demo.ps1',
};
frontPackage.scripts = { ...frontPackage.scripts, 'prepare:brain': 'node ../../scripts/prepare-brain.mjs', predev: 'npm run prepare:brain', prebuild: 'npm run prepare:brain', pretypecheck: 'npm run prepare:brain', typecheck: 'tsc --noEmit' };
delete frontPackage.scripts.prestart;
for (const name of ['next', '@mediapipe/tasks-vision', 'onnxruntime-web']) frontPackage.dependencies[name] = brainPackage.dependencies[name];
for (const name of ['contracts', 'signal', 'features', 'perception', 'sport-runtime', 'analysis', 'scoring', 'coaching', 'runtime', 'brain-client']) {
  const location = path.relative(frontend, path.join(root, 'packages', name)).replaceAll('\\', '/');
  frontPackage.dependencies[`@apexformz/${name}`] = `file:${location}`;
  const metadata = await readJson(path.join(root, 'packages', name, 'package.json'));
  for (const [key, target] of Object.entries(metadata.exports ?? { '.': metadata.types })) {
    if (typeof target === 'string') tsconfig.compilerOptions.paths[`@apexformz/${name}${key === '.' ? '' : key.slice(1)}`] = [`${location}/${target.replace(/^\.\//, '')}`];
  }
}
tsconfig.compilerOptions.target = 'ES2022';
tsconfig.compilerOptions.lib = [...new Set([...tsconfig.compilerOptions.lib, 'webworker'])];
for (const action of ['dev', 'build', 'start', 'db:generate', 'db:prepare', 'db:plan']) backPackage.scripts[action] = `node ../../scripts/brain-backend.mjs ${action}`;
backPackage.scripts['db:migrate'] = 'node ../../scripts/brain-backend.mjs db:prepare';
for (const [file, content] of [['package.json', webPackage], ['apps/frontend/package.json', frontPackage], ['apps/backend/package.json', backPackage], ['apps/frontend/tsconfig.json', tsconfig]]) files.set(file, Buffer.from(stringify(content)));
// The legacy type shim extends the existing type contract without changing its fields.
files.set('packages/types/index.ts', await readFile(path.join(root, 'packages/legacy-types/index.ts')));
const ignore = await readFile(path.join(web, '.gitignore'), 'utf8');
const addition = '\n# Generated from the sibling Apexformz Brain by prepare:brain\n.brain-integration-backups/\napps/frontend/src/components/brain/\napps/frontend/src/lib/brain/\napps/frontend/src/workers/\napps/frontend/src/app/api/brain/\napps/frontend/public/runtime/\napps/frontend/public/models/squash/\napps/frontend/public/models/reid/\napps/frontend/public/models/pose_landmarker_full.task\napps/frontend/public/brain-integration.json\napps/frontend/public/pack-trust.json\napps/frontend/scripts/prepare-brain-runtime-assets.mjs\napps/frontend/scripts/prepare-pack-trust.mjs\n';
files.set('.gitignore', Buffer.from(ignore.includes('# Generated from the sibling Apexformz Brain') ? ignore : ignore + addition));
if (!process.argv.includes('--apply')) {
  console.log(stringify({ target: web, source: root, files: [...files.keys()], action: 'Pass --apply to back up and install these changes.' }));
} else {
  // Validate the complete local artifact set before the first write to the web project.
  await preflightWebInterface();
  const verification = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'tools/browser_model_artifacts.ts', 'verify'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (verification.status !== 0) throw new Error('Brain model verification failed. The web project was not changed.');
  const backup = path.join(web, '.brain-integration-backups', new Date().toISOString().replaceAll(':', '-'));
  const changed = [];
  for (const [relative, bytes] of files) {
    const target = path.resolve(web, relative);
    if (!target.startsWith(web + path.sep)) throw new Error('Integration target escaped the web project.');
    let previous;
    try { previous = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous?.equals(bytes)) continue;
    if (previous) {
      const saved = path.join(backup, relative);
      await mkdir(path.dirname(saved), { recursive: true });
      await copyFile(target, saved);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    changed.push({ path: relative, existed: Boolean(previous) });
  }
  if (changed.length) {
    await mkdir(backup, { recursive: true });
    await writeFile(path.join(backup, 'changes.json'), stringify(changed));
  }
  await prepareWebInterface(web);
  console.log(stringify({ target: web, changed: changed.length, backup: changed.length ? backup : null }));
}
