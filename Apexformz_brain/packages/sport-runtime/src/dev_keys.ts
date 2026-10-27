/**
 * Development signing material. NOT FOR PRODUCTION.
 *
 * Production packs are signed with an ed25519 key held in the secret manager and
 * verified against a key registry delivered with the core build (TRD 13/14).
 * The HMAC dev key lets local builds and tests exercise the full verification
 * path (signature + digest) without that infrastructure.
 */
export const DEV_SIGNING_KEY_ID = 'dev-local-2026';
export const DEV_SIGNING_SECRET = 'apexformz-dev-pack-signing-secret-not-for-production';

export function signingKeysFromEnv(env: Record<string, string | undefined> = {}): Record<string, string> {
  const keys: Record<string, string> = { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET };
  const prodId = env.APEXFORMZ_PACK_SIGNING_KEY_ID;
  const prodSecret = env.APEXFORMZ_PACK_SIGNING_SECRET;
  if (prodId && prodSecret) keys[prodId] = prodSecret;
  return keys;
}
