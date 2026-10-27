import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshAuthTokens } from './auth';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('axios', () => ({ default: { post: mocks.post, isAxiosError: (error: any) => error?.isAxiosError === true } }));

beforeEach(() => {
  mocks.post.mockReset();
  const saved = new Map([['access_token', 'expired-access'], ['refresh_token', 'retained-refresh']]);
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());

describe('account refresh during Brain event sync', () => {
  it('rotates tokens only once for simultaneous expired requests', async () => {
    let resolve!: (value: unknown) => void;
    mocks.post.mockReturnValue(new Promise(r => { resolve = r; }));
    const first = refreshAuthTokens();
    const second = refreshAuthTokens();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    resolve({ data: { success: true, data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 900 } } });
    await Promise.all([first, second]);
    expect(localStorage.getItem('refresh_token')).toBe('new-refresh');
  });
  it('keeps account credentials when the network is temporarily unavailable', async () => {
    mocks.post.mockRejectedValue({ isAxiosError: true });
    expect(await refreshAuthTokens()).toBeNull();
    expect(localStorage.getItem('refresh_token')).toBe('retained-refresh');
  });
  it('clears credentials when the server rejects the refresh token', async () => {
    mocks.post.mockRejectedValue({ isAxiosError: true, response: { status: 401 } });
    expect(await refreshAuthTokens()).toBeNull();
    expect(localStorage.getItem('refresh_token')).toBeNull();
    expect(localStorage.getItem('access_token')).toBeNull();
  });
});
