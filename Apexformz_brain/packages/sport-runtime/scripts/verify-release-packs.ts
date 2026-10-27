/** Public-key-only verification of a staged release. Approval/accuracy remain separate release gates. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSportPack } from '../src/loader';
import { listPackDirs, readPackDir } from '../src/node';
import { packTrustMode, validateTrustRegistry } from '../src/trust';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const option = (name: string, optional = false) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) { if (!optional) throw new Error(`required: ${name}`); return undefined; } return args[i + 1]; };
    const mode = packTrustMode(option('--trust-mode', true), true);
    if (mode === 'development') throw new Error('release verification requires production or test trust mode');
    const registry = validateTrustRegistry(JSON.parse(await fs.readFile(option('--registry')!, 'utf8')));
    const dirs = await listPackDirs(option('--pack-root')!);
    if (!dirs.length) throw new Error('no release sport packs found');
    const packs = [];
    for (const dir of dirs) {
      const bundle = await loadSportPack(await readPackDir(dir), { platform: 'web', trust_mode: mode, trust_registry: registry });
      if (bundle.manifest.id !== path.basename(dir)) throw new Error('pack directory must match manifest id');
      packs.push({ id: bundle.manifest.id, version: bundle.manifest.version, key_id: bundle.manifest.signature.key_id });
    }
    console.log(JSON.stringify({ status: 'verified', trust_mode: mode, packs, approval_status: 'not_changed_by_signature_verification' }));
  } catch (error) { console.error(error instanceof Error ? error.message : 'release verification failed'); process.exitCode = 1; }
}
