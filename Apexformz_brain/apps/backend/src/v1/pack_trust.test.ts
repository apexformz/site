import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listPacks, readAsset, readManifest } from './packs';
import { signReleasePacks } from '../../../../packages/sport-runtime/scripts/sign-release-packs';
import type { PackTrustRegistry } from '@apexformz/sport-runtime';

const packs = path.resolve(__dirname, '../../../../sport-packs');
afterEach(() => vi.unstubAllEnvs());

describe('server pack distribution trust', () => {
  it('does not serve local HMAC packs in production or fall back when roots are missing', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('APEXFORMZ_PACK_TRUST_MODE', 'production');
    vi.stubEnv('APEXFORMZ_PACK_TRUST_REGISTRY_PATH', ''); vi.stubEnv('APEXFORMZ_PACK_TRUST_REGISTRY_JSON', '');
    expect(await readManifest('badminton', packs)).toBeNull();
    expect(await readAsset('badminton', 'feedback_templates.json', packs)).toBeNull();
    expect(await listPacks(packs)).toEqual([]);
  });

  it('serves verified Ed25519 packs and withholds modified assets and revoked keys', async () => {
    const temp = await fs.mkdtemp(path.join(tmpdir(), 'apex-server-trust-'));
    const source = path.join(temp, 'source'); const output = path.join(temp, 'release');
    await fs.mkdir(source); await fs.cp(path.join(packs, 'badminton'), path.join(source, 'badminton'), { recursive: true });
    const { privateKey } = generateKeyPairSync('ed25519');
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    const registry: PackTrustRegistry = { schema_version: '1.0.0', keys: [{ key_id: 'ephemeral-server-test', algorithm: 'ed25519', public_key: Buffer.from(jwk.x!, 'base64url').toString('hex'), status: 'active', purpose: 'production' }] };
    await signReleasePacks({ source, out: output, keyId: registry.keys[0].key_id, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), registry });
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('APEXFORMZ_PACK_TRUST_MODE', 'production');
    vi.stubEnv('APEXFORMZ_PACK_TRUST_REGISTRY_PATH', ''); vi.stubEnv('APEXFORMZ_PACK_TRUST_REGISTRY_JSON', JSON.stringify(registry));
    expect((await readManifest('badminton', output))?.manifest.id).toBe('badminton');
    expect(await readAsset('badminton', 'feedback_templates.json', output)).not.toBeNull();
    registry.keys[0].status = 'revoked'; vi.stubEnv('APEXFORMZ_PACK_TRUST_REGISTRY_JSON', JSON.stringify(registry));
    expect(await readManifest('badminton', output)).toBeNull();
    registry.keys[0].status = 'active'; vi.stubEnv('APEXFORMZ_PACK_TRUST_REGISTRY_JSON', JSON.stringify(registry));
    await fs.appendFile(path.join(output, 'badminton/feedback_templates.json'), ' ');
    expect(await readAsset('badminton', 'feedback_templates.json', output)).toBeNull();
  });
});
