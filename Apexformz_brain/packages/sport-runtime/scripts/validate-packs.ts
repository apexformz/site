/**
 * Validate every committed sport pack without modifying it (CI gate, TRD 05/14).
 *
 *   npx tsx packages/sport-runtime/scripts/validate-packs.ts [sport-packs-dir]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSportPack } from '../src/loader';
import { listPackDirs, readPackDir } from '../src/node';
import { signingKeysFromEnv } from '../src/dev_keys';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? path.resolve(here, '../../../sport-packs');

const dirs = await listPackDirs(root);
let failed = 0;
for (const dir of dirs) {
  const name = path.basename(dir);
  try {
    const bundle = await loadSportPack(await readPackDir(dir), { platform: 'web', hmac_keys: signingKeysFromEnv(process.env) });
    const prov = bundle.provenance.validation_summary;
    const approved = bundle.technique_criteria.criteria.filter((c) => c.validation_status === 'approved').length;
    const provisional = bundle.technique_criteria.criteria.filter((c) => c.validation_status === 'provisional').length;
    console.log(`OK   ${bundle.manifest.id}@${bundle.manifest.version} movements=${bundle.movement_catalog.movements.length} criteria(approved=${approved}, provisional=${provisional}) open_items=${bundle.provenance.open_items.length} summary=${JSON.stringify(prov)}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${(e as Error).message}`);
  }
}
console.log(failed ? `${failed} pack(s) failed` : `${dirs.length} pack(s) valid`);
if (failed) process.exit(1);
