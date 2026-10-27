import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAuthTokens, verifyToken } from './auth.utils';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('refresh token issuance', () => {
  it('keeps repeated sign-ins distinct within the same second', () => {
    vi.stubEnv('JWT_SECRET', 'test-access-secret');
    vi.stubEnv('JWT_REFRESH_SECRET', 'test-refresh-secret');
    vi.spyOn(Date, 'now').mockReturnValue(1_793_078_781_000);

    const first = generateAuthTokens('athlete-id', 'athlete@example.com');
    const second = generateAuthTokens('athlete-id', 'athlete@example.com');
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const firstClaims = verifyToken(first.refresh_token, process.env.JWT_REFRESH_SECRET!);
    const secondClaims = verifyToken(second.refresh_token, process.env.JWT_REFRESH_SECRET!);
    expect(firstClaims).toMatchObject({ userId: 'athlete-id', email: 'athlete@example.com' });
    expect(secondClaims).toMatchObject({ userId: 'athlete-id', email: 'athlete@example.com', iat: firstClaims.iat, exp: firstClaims.exp });
    expect(firstClaims.jti).toEqual(expect.any(String));
    expect(secondClaims.jti).not.toBe(firstClaims.jti);
  });
});
