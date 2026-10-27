import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);

/** @param {string} phase @param {Record<string, string | undefined>} env */
export function packTrustBuildMetadata(phase, env = process.env) {
  const mode = env.NEXT_PUBLIC_PACK_TRUST_MODE ?? (phase === 'phase-production-build' ? 'production' : 'development');
  if (!['development', 'test', 'production'].includes(mode)) throw new Error('Invalid NEXT_PUBLIC_PACK_TRUST_MODE');
  const registry = env.NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON ? JSON.parse(env.NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON) : { schema_version: '1.0.0', keys: [] };
  if (!registry || registry.schema_version !== '1.0.0' || !Array.isArray(registry.keys) || Object.keys(registry).some(k => !['schema_version', 'keys'].includes(k))) throw new Error('Invalid public pack registry');
  const ids = new Set();
  for (const k of registry.keys) {
    if (!k || !/^[A-Za-z0-9._-]{1,80}$/.test(k.key_id) || ids.has(k.key_id) || k.algorithm !== 'ed25519' || !/^[a-f0-9]{64}$/.test(k.public_key)
      || !['active', 'revoked'].includes(k.status) || !['test', 'production'].includes(k.purpose)
      || Object.keys(k).some(name => !['key_id', 'algorithm', 'public_key', 'status', 'purpose'].includes(name))) throw new Error('Invalid public signing key entry');
    ids.add(k.key_id);
  }
  if (mode !== 'development' && !registry.keys.some(k => k.status === 'active' && (mode !== 'production' || k.purpose === 'production'))) throw new Error('Production/test builds require an active trusted public signing key');
  return { schema_version: 1, mode, registry, registry_sha256: createHash('sha256').update(canonical(registry)).digest('hex'), key_ids: [...ids].sort() };
}

/** Called at build/dev time only. Production startup must never rewrite the compiled trust decision. */
export async function preparePackTrust(phase) {
  if (!['phase-production-build', 'phase-development-server'].includes(phase)) return;
  const metadata = packTrustBuildMetadata(phase);
  const text = JSON.stringify(metadata, null, 2) + '\n';
  for (const name of ['src/lib/brain/pack-trust.generated.json', 'public/pack-trust.json']) {
    const target = path.join(frontend, name);
    try { if (await readFile(target, 'utf8') === text) continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text);
  }
  console.log(`Pack trust build policy: ${metadata.mode}; public registry SHA-256 ${metadata.registry_sha256}`);
}
