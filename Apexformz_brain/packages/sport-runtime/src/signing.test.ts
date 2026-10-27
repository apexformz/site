import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SportPackManifest } from '@apexformz/contracts';
import { canonicalSigningJson, manifestSigningPayload, validateTrustRegistry, verifyManifestEd25519, type PackTrustRegistry } from './trust';
import { loadSportPack } from './loader';
import { packLoadOptionsFromEnv, readPackDir } from './node';
import { signReleasePacks } from '../scripts/sign-release-packs';
import { DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET } from './dev_keys';

// Parse actual JSON bytes: bundlers can turn a JSON __proto__ key into object-literal prototype syntax.
const vector = JSON.parse(readFileSync(path.resolve(__dirname, '../../../tests/fixtures/pack_signing.json'), 'utf8')) as {
  registry: unknown; manifest: SportPackManifest; payload_sha256: string; canonical_cases: Array<{ input: unknown; expected: string }>;
};
const registry = validateTrustRegistry(vector.registry);
const manifest = vector.manifest as SportPackManifest;
const packs = path.resolve(__dirname, '../../../sport-packs');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function productionTestKey() {
  const pair = generateKeyPairSync('ed25519');
  const publicJwk = createPublicKey(pair.privateKey).export({ format: 'jwk' });
  const trust: PackTrustRegistry = { schema_version: '1.0.0', keys: [{ key_id: 'ephemeral-unit-test', algorithm: 'ed25519', public_key: Buffer.from(publicJwk.x!, 'base64url').toString('hex'), status: 'active', purpose: 'production' }] };
  return { pair, trust };
}

describe('Ed25519 pack trust', () => {
  it('matches Python RFC 8785 canonical bytes and its independently signed public test vector', async () => {
    for (const c of vector.canonical_cases) expect(canonicalSigningJson(c.input)).toBe(c.expected);
    expect(sha(manifestSigningPayload(manifest, registry.keys[0].key_id))).toBe(vector.payload_sha256);
    await expect(verifyManifestEd25519(manifest, registry, 'test')).resolves.toBeUndefined();
    expect(() => canonicalSigningJson('\ud800')).toThrow(/surrogate/);
    expect(() => canonicalSigningJson(NaN)).toThrow(/non-finite/);
  });

  it('rejects test keys in production, absent/unknown/revoked keys, tamper and partial signatures', async () => {
    await expect(verifyManifestEd25519(manifest, registry, 'production')).rejects.toThrow(/test signing keys/);
    await expect(verifyManifestEd25519(manifest, undefined, 'test')).rejects.toThrow(/registry/);
    await expect(verifyManifestEd25519(manifest, { schema_version: '1.0.0', keys: [] }, 'test')).rejects.toThrow(/unknown/);
    await expect(verifyManifestEd25519(manifest, { ...registry, keys: [{ ...registry.keys[0], status: 'revoked' }] }, 'test')).rejects.toThrow(/revoked/);
    await expect(verifyManifestEd25519({ ...manifest, version: '9.9.9' }, registry, 'test')).rejects.toThrow(/mismatch/);
    await expect(verifyManifestEd25519({ ...manifest, signature: { ...manifest.signature, signed_fields: ['id'] } }, registry, 'test')).rejects.toThrow(/envelope/);
    expect(() => validateTrustRegistry({ ...registry, keys: [registry.keys[0], registry.keys[0]] })).toThrow(/duplicate/);
    expect(() => validateTrustRegistry({ ...registry, keys: [{ ...registry.keys[0], private_key: 'must never be accepted' }] })).toThrow(/invalid/);
  });

  it('production rejects HMAC and unsigned packs even if development overrides are supplied', async () => {
    const input = await readPackDir(path.join(packs, 'badminton'));
    const opts = { platform: 'web' as const, trust_mode: 'production' as const, allow_unsigned: true, hmac_keys: { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET } };
    await expect(loadSportPack(input, opts)).rejects.toThrow(/Ed25519/);
    await expect(loadSportPack({ ...input, manifest: { ...(input.manifest as SportPackManifest), signature: { algorithm: 'none' } } }, opts)).rejects.toThrow(/Ed25519/);
  });

  it('loads a production-policy Ed25519 pack and cannot disable its asset hashes', async () => {
    const { pair, trust } = productionTestKey();
    const input = await readPackDir(path.join(packs, 'badminton'));
    const m = input.manifest as SportPackManifest;
    m.signature = { algorithm: 'ed25519', key_id: trust.keys[0].key_id, value: sign(null, Buffer.from(manifestSigningPayload(m, trust.keys[0].key_id)), pair.privateKey).toString('hex') };
    const options = { platform: 'web' as const, trust_mode: 'production' as const, trust_registry: trust, verify_hashes: false };
    expect((await loadSportPack(input, options)).manifest.id).toBe('badminton');
    input.assets[m.feedback_templates] += ' ';
    await expect(loadSportPack(input, options)).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH' });
  });

  it('server production configuration requires an independent public root with no HMAC fallback', async () => {
    await expect(packLoadOptionsFromEnv({ NODE_ENV: 'production' })).rejects.toThrow(/registry/);
    const opts = await packLoadOptionsFromEnv({ NODE_ENV: 'production', APEXFORMZ_PACK_TRUST_REGISTRY_JSON: JSON.stringify(registry) });
    expect(opts.trust_mode).toBe('production'); expect(opts.hmac_keys).toBeUndefined();
    expect((await packLoadOptionsFromEnv({ NODE_ENV: 'production', APEXFORMZ_PACK_TRUST_MODE: 'development' })).trust_mode).toBe('development');
  });

  it('offline signing writes an isolated verified release and preserves source bytes', async () => {
    const temp = await fs.mkdtemp(path.join(tmpdir(), 'apex-signing-'));
    const source = path.join(temp, 'source'); const output = path.join(temp, 'release');
    await fs.mkdir(source); await fs.cp(path.join(packs, 'badminton'), path.join(source, 'badminton'), { recursive: true });
    const before = await fs.readFile(path.join(source, 'badminton/manifest.json'), 'utf8');
    const { pair, trust } = productionTestKey();
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const result = await signReleasePacks({ source, out: output, keyId: trust.keys[0].key_id, privateKeyPem, registry: trust });
    expect(result.packs).toHaveLength(1);
    expect(await fs.readFile(path.join(source, 'badminton/manifest.json'), 'utf8')).toBe(before);
    const release = await readPackDir(path.join(output, 'badminton'));
    expect((await loadSportPack(release, { platform: 'web', trust_mode: 'production', trust_registry: trust })).manifest.signature.algorithm).toBe('ed25519');
    await expect(signReleasePacks({ source, out: output, keyId: trust.keys[0].key_id, privateKeyPem, registry: trust })).rejects.toThrow(/already exists/);
    const wrong = productionTestKey();
    await expect(signReleasePacks({ source, out: path.join(temp, 'wrong'), keyId: trust.keys[0].key_id, privateKeyPem: wrong.pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), registry: trust })).rejects.toThrow(/does not match/);
  });
});
