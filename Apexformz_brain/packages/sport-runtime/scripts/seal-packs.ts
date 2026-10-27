/**
 * Seal every sport pack: compute sha256 asset digests, sign the manifest and
 * validate the result by loading it through the real loader.
 *
 *   npx tsx packages/sport-runtime/scripts/seal-packs.ts [sport-packs-dir]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSportPack } from '../src/loader';
import { listPackDirs, readPackDir, sealPackDir } from '../src/node';
import { signingKeysFromEnv } from '../src/dev_keys';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? path.resolve(here, '../../../sport-packs');

const dirs = await listPackDirs(root);
let failed = 0;
for (const dir of dirs) {
  const manifest = await sealPackDir(dir);
  try {
    const bundle = await loadSportPack(await readPackDir(dir), { platform: 'web', hmac_keys: signingKeysFromEnv(process.env) });
    const n = bundle.movement_catalog.movements.length;
    const c = bundle.technique_criteria.criteria.length;
    console.log(`sealed ${manifest.id}@${manifest.version}: ${Object.keys(manifest.asset_hashes).length} assets, ${n} movements, ${c} criteria`);
  } catch (e) {
    failed++;
    console.error(`FAILED ${manifest.id}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
