import { afterEach, describe, expect, it, vi } from 'vitest';
import { packTrustBuildMetadata } from '../../../scripts/prepare-pack-trust.mjs';

const registry = { schema_version: '1.0.0', keys: [{ key_id: 'public-test-policy', algorithm: 'ed25519', public_key: 'a'.repeat(64), status: 'active', purpose: 'production' }] };
afterEach(() => { vi.doUnmock('./pack-trust.generated.json'); vi.resetModules(); });

describe('frontend pack trust binding', () => {
  it('a production build requires public production roots and records the compiled policy digest', () => {
    expect(() => packTrustBuildMetadata('phase-production-build', {})).toThrow(/active trusted/);
    expect(() => packTrustBuildMetadata('phase-production-build', { NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON: JSON.stringify({ ...registry, keys: [{ ...registry.keys[0], purpose: 'test' }] }) })).toThrow(/active trusted/);
    const metadata = packTrustBuildMetadata('phase-production-build', { NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON: JSON.stringify(registry) });
    expect(metadata.mode).toBe('production'); expect(metadata.registry_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.key_ids).toEqual(['public-test-policy']);
    expect(packTrustBuildMetadata('phase-production-build', { NEXT_PUBLIC_PACK_TRUST_MODE: 'development' }).mode).toBe('development');
  });

  it('coaching development mode cannot enable HMAC when the build requires production signatures', async () => {
    vi.doMock('./pack-trust.generated.json', () => ({ default: { schema_version: 1, mode: 'production', registry, registry_sha256: 'a'.repeat(64), key_ids: ['public-test-policy'] } }));
    const { runtimeConfig } = await import('./config');
    const config = runtimeConfig('development');
    expect(config.pack_trust_mode).toBe('production'); expect(config.hmac_keys).toBeUndefined();
    expect(config.allow_unsigned_packs).toBe(false);
  });
});
