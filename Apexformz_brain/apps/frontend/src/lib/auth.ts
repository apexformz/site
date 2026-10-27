import axios from 'axios';
import { AuthTokens, ApiResponse } from '@smartcoach/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

/**
 * Shared utility to refresh authentication tokens.
 * This can be used by both Axios interceptors and WebSocket connection handlers.
 */
let pendingRefresh: Promise<AuthTokens | null> | null = null;

// Event sync, history and profile requests may expire together. Rotate once.
export function refreshAuthTokens(): Promise<AuthTokens | null> {
  if (!pendingRefresh) pendingRefresh = requestRefresh().finally(() => { pendingRefresh = null; });
  return pendingRefresh;
}

async function requestRefresh(): Promise<AuthTokens | null> {
  const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refresh_token') : null;
  
  if (!refreshToken) {
    return null;
  }

  try {
    const { data } = await axios.post<ApiResponse<AuthTokens>>(`${API_URL}/auth/refresh`, {
      refresh_token: refreshToken,
    });
    
    if (data.success && data.data) {
      localStorage.setItem('access_token', data.data.access_token);
      localStorage.setItem('refresh_token', data.data.refresh_token);
      return data.data;
    }
    return null;
  } catch (err) {
    // A connection loss must not sign out an athlete with pending session evidence.
    if (axios.isAxiosError(err) && [400, 401, 403].includes(err.response?.status ?? 0)) {
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
    }
    return null;
  }
}

/**
 * Helper to get the current access token.
 */
export function getAccessToken(): string | null {
  return typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;
}
