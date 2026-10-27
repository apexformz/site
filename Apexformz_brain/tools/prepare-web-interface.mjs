/** Stage the maintained Brain web adapter and local inference assets in a host interface. */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const brainRoot = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(brainRoot, 'apps/frontend');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function preflightWebInterface() {
  for (const relative of [
    'src/components/brain/BrainSetup.tsx', 'src/components/brain/BrainTrainingPage.tsx',
    'src/lib/brain/config.ts', 'src/lib/brain/session.ts', 'src/lib/brain/ort-shim.mjs',
    'src/workers/brain.worker.ts', 'src/workers/movement_inference.worker.ts',
    'src/app/api/brain/sport-packs/_lib.ts',
    'scripts/prepare-brain-runtime-assets.mjs', 'scripts/prepare-pack-trust.mjs',
    'public/models/pose_landmarker_full.task', 'public/models/squash/index.json', 'public/models/reid/reid.json',
  ]) await stat(path.join(source, relative));
}

export async function prepareWebInterface(webRoot) {
  await preflightWebInterface();
  webRoot = path.resolve(webRoot);
  if (webRoot === brainRoot) throw new Error('The host interface must be a separate project.');
  const frontend = path.join(webRoot, 'apps/frontend');
  await stat(path.join(frontend, 'package.json'));
  const manifest = { source: 'Apexformz_brain', files: {} };
  async function copy(relative) {
    const origin = path.join(source, relative);
    const target = path.join(frontend, relative);
    const metadata = await stat(origin);
    if (metadata.isDirectory()) {
      for (const entry of await readdir(origin)) {
        // Generated runtime and signing metadata belong to the host build, not the source app.
        if (!entry.endsWith('.test.ts') && !entry.endsWith('.generated.json')) await copy(path.join(relative, entry));
      }
      return;
    }
    const bytes = await readFile(origin);
    const digest = sha(bytes);
    manifest.files[relative.replaceAll('\\', '/')] = { bytes: bytes.length, sha256: digest };
    try { if (sha(await readFile(target)) === digest) return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(origin, target);
  }
  for (const relative of [
    'src/components/brain', 'src/lib/brain', 'src/workers', 'src/app/api/brain',
    'src/hooks/useVoiceCoaching.ts',
    'src/components/BrainSessionResults.tsx',
    'src/components/PoseSkeleton.tsx', 'src/components/ActionableFeedback.tsx',
    'scripts/prepare-brain-runtime-assets.mjs', 'scripts/prepare-pack-trust.mjs',
    'public/models/pose_landmarker_full.task', 'public/models/squash', 'public/models/reid',
  ]) await copy(relative);
  await mkdir(path.join(frontend, 'public'), { recursive: true });
  await writeFile(path.join(frontend, 'public/brain-integration.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Brain interface prepared: ${Object.keys(manifest.files).length} adapter/model files, squash recognition and athlete tracking available.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--web-root');
  await prepareWebInterface(index < 0 ? path.join(brainRoot, '../Apexformz') : process.argv[index + 1]);
}
