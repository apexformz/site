import axios from 'axios';
import { AuthTokens, ApiResponse } from '@smartcoach/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

/**
 * Shared utility to refresh authentication tokens.
 * This can be used by both Axios interceptors and WebSocket connection handlers.
 */
export async function refreshAuthTokens(): Promise<AuthTokens | null> {
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
    console.error('❌ Token refresh failed:', err);
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    return null;
  }
}

/**
 * Helper to get the current access token.
 */
export function getAccessToken(): string | null {
  return typeof window !== 'undefined' ? localStorage.getItem('access_token') : null;
}
