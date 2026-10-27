/**
 * Deterministic, dependency-free identifier helpers.
 *
 * Event ids are `${session_id}:${sequence}` so that the cloud can enforce
 * unique(session_id, event_id) idempotency without coordination.
 */
export function makeEventId(sessionId: string, sequence: number): string {
  return `${sessionId}:${sequence.toString().padStart(8, '0')}`;
}

export function randomId(prefix = ''): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `${prefix}${g.crypto.randomUUID()}`;
  // Fallback for very old runtimes: not cryptographically strong, fine for local ids.
  const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${prefix}${rnd()}-${rnd().slice(0, 4)}-4${rnd().slice(1, 4)}-${rnd().slice(0, 4)}-${rnd()}${rnd().slice(0, 4)}`;
}

/** Simple string hash used for stable, non-cryptographic keys (e.g. cache keys). */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
