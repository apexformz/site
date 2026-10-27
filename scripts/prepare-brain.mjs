import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { brainRoot, webRoot } from './brain-paths.mjs';

const { prepareWebInterface } = await import(pathToFileURL(path.join(brainRoot, 'tools/prepare-web-interface.mjs')));
await prepareWebInterface(webRoot);
const runtime = spawnSync(process.execPath, ['scripts/prepare-brain-runtime-assets.mjs'], {
  cwd: path.join(webRoot, 'apps/frontend'), stdio: 'inherit',
});
if (runtime.status !== 0) process.exit(runtime.status ?? 1);
// Initial typecheck needs a registry; an existing build's trust policy is never overwritten here.
try { await access(path.join(webRoot, 'apps/frontend/src/lib/brain/pack-trust.generated.json')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const { preparePackTrust } = await import(pathToFileURL(path.join(webRoot, 'apps/frontend/scripts/prepare-pack-trust.mjs')));
  await preparePackTrust('phase-development-server');
}
