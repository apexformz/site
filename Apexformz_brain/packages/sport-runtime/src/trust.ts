import { BrainError, type SportPackManifest } from '@apexformz/contracts';

export type PackTrustMode = 'development' | 'test' | 'production';
export interface PackTrustRegistry {
  schema_version: '1.0.0';
  keys: Array<{ key_id: string; algorithm: 'ed25519'; public_key: string; status: 'active' | 'revoked'; purpose: 'test' | 'production' }>;
}

const fail = (message: string): never => { throw new BrainError('SIGNATURE_INVALID', message, { recoverable: false }); };
const keyId = /^[A-Za-z0-9._-]{1,80}$/;

export function validateTrustRegistry(value: unknown): PackTrustRegistry {
  const r = value as PackTrustRegistry;
  if (!r || r.schema_version !== '1.0.0' || !Array.isArray(r.keys) || Object.keys(r).some(k => !['schema_version', 'keys'].includes(k))) return fail('invalid pack trust registry');
  const seen = new Set<string>();
  for (const k of r.keys) {
    if (!k || !keyId.test(k.key_id) || seen.has(k.key_id) || k.algorithm !== 'ed25519' || !/^[a-f0-9]{64}$/.test(k.public_key)
      || !['active', 'revoked'].includes(k.status) || !['test', 'production'].includes(k.purpose)
      || Object.keys(k).some(name => !['key_id', 'algorithm', 'public_key', 'status', 'purpose'].includes(name))) return fail('invalid or duplicate public signing key');
    seen.add(k.key_id);
  }
  return r;
}

export function packTrustMode(value: string | undefined, production = false): PackTrustMode {
  const mode = value ?? (production ? 'production' : 'development');
  if (!['production', 'development', 'test'].includes(mode)) return fail('invalid pack trust mode');
  return mode as PackTrustMode;
}

/** RFC 8785 JSON serialization: sorted UTF-16 keys, ECMAScript numbers, valid Unicode only. */
export function canonicalSigningJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return fail('unpaired Unicode surrogate in signed content'); }
      else if (c >= 0xdc00 && c <= 0xdfff) return fail('unpaired Unicode surrogate in signed content');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) return fail('non-finite number in signed content'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalSigningJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${canonicalSigningJson(k)}:${canonicalSigningJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return fail('non-JSON value in signed content');
}

/** Domain-separated payload binds key identity and every manifest field except signature itself. */
export function manifestSigningPayload(manifest: SportPackManifest, signingKeyId: string): string {
  if (!keyId.test(signingKeyId)) return fail('invalid signing key id');
  const { signature: _ignored, ...unsigned } = manifest;
  return `ApexFormz sport-pack Ed25519 v1\n${canonicalSigningJson({ key_id: signingKeyId, manifest: unsigned })}`;
}

export function trustedSigningKey(registry: PackTrustRegistry | undefined, signingKeyId: string | undefined, mode: PackTrustMode) {
  if (!registry) return fail('Ed25519 public-key registry is required');
  const entry = validateTrustRegistry(registry).keys.find(k => k.key_id === signingKeyId);
  if (!entry) return fail('unknown pack signing key');
  if (entry.status !== 'active') return fail('pack signing key is revoked');
  if (mode === 'production' && entry.purpose !== 'production') return fail('test signing keys are forbidden in production');
  return entry;
}

export async function verifyManifestEd25519(manifest: SportPackManifest, registry: PackTrustRegistry | undefined, mode: PackTrustMode): Promise<void> {
  const sig = manifest.signature;
  if (sig.algorithm !== 'ed25519' || !sig.value || !/^[a-f0-9]{128}$/.test(sig.value) || sig.signed_fields !== undefined) return fail('invalid Ed25519 signature envelope');
  const entry = trustedSigningKey(registry, sig.key_id, mode);
  const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16));
  try {
    const key = await crypto.subtle.importKey('raw', fromHex(entry.public_key), { name: 'Ed25519' }, false, ['verify']);
    const valid = await crypto.subtle.verify('Ed25519', key, fromHex(sig.value), new TextEncoder().encode(manifestSigningPayload(manifest, entry.key_id)));
    if (!valid) return fail('manifest Ed25519 signature mismatch');
  } catch (error) {
    if (error instanceof BrainError) throw error;
    return fail('Ed25519 verification failed or is unavailable');
  }
}
