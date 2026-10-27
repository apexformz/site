import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './environment';

const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:pass@localhost/test',
  JWT_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), CORS_ORIGIN: 'https://app.example.org' };
describe('production startup configuration', () => {
  it('accepts independent secrets and a single HTTPS origin', () => expect(() => validateEnvironment(base)).not.toThrow());
  it('rejects missing, weak, reused and placeholder credentials without printing them', () => {
    for (const change of [{ JWT_SECRET: '' }, { JWT_SECRET: 'short' }, { JWT_REFRESH_SECRET: base.JWT_SECRET },
      { JWT_SECRET: 'your-super-secret-jwt-key-change-in-production' }]) {
      expect(() => validateEnvironment({ ...base, ...change })).toThrow();
    }
  });
  it('rejects wildcard, non-HTTPS remote and credential-bearing CORS origins', () => {
    for (const origin of ['*', 'http://remote.example.org', 'https://u:p@example.org', 'https://example.org/path']) {
      expect(() => validateEnvironment({ ...base, CORS_ORIGIN: origin })).toThrow();
    }
  });
  it('allows explicit loopback development and rejects non-PostgreSQL storage', () => {
    expect(() => validateEnvironment({ ...base, CORS_ORIGIN: 'http://localhost:3000' })).not.toThrow();
    expect(() => validateEnvironment({ ...base, DATABASE_URL: 'file:dev.db' })).toThrow();
  });
});
