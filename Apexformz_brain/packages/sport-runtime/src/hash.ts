/**
 * SHA-256 and HMAC helpers using WebCrypto (available in browsers, workers and Node >= 19).
 */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function subtle(): SubtleCrypto {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto subtle API unavailable');
  return c.subtle;
}

export async function sha256Hex(text: string | Uint8Array): Promise<string> {
  const data = typeof text === 'string' ? utf8(text) : text;
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return hex(await subtle().digest('SHA-256', ab));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await subtle().importKey('raw', utf8(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle().sign('HMAC', key, utf8(message) as BufferSource));
}

/** Stable JSON serialization (sorted keys) for signing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sortKeys(o[k]);
      return acc;
    }, {});
  }
  return v;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
