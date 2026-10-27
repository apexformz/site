import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { checkUpload } from './assets';

describe('private asset upload boundary', () => {
  const bytes = Buffer.from('[]');
  const hash = createHash('sha256').update(bytes).digest('hex');
  it('accepts bytes whose checksum, content type and consent match', () => {
    expect(() => checkUpload(bytes, 'application/json', hash, 'deep_analysis')).not.toThrow();
  });
  it.each([
    [bytes, 'text/html', hash, 'deep_analysis'],
    [bytes, 'application/json', '0'.repeat(64), 'deep_analysis'],
    [bytes, 'application/json', hash, 'marketing'],
    [Buffer.alloc(0), 'application/json', hash, 'deep_analysis'],
  ])('rejects invalid uploads before S3 or database writes', (body, mime, digest, consent) => {
    expect(() => checkUpload(body as Buffer, mime as string, digest as string, consent as string)).toThrow();
  });
});
