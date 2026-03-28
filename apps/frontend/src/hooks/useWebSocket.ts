import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { FrameAnalysis, PoseKeypoints, Hand } from '@smartcoach/types';
import { refreshAuthTokens, getAccessToken } from '../lib/auth';

const getSocketUrl = () => {
  if (process.env.NEXT_PUBLIC_SOCKET_URL) return process.env.NEXT_PUBLIC_SOCKET_URL;
  if (typeof window !== 'undefined') {
    return `http://${window.location.hostname}:4000`;
  }
  return 'http://localhost:4000';
};

export function useWebSocket(onFeedback: (analysis: FrameAnalysis) => void) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const onFeedbackRef = useRef(onFeedback);
  
  const sessionStateRef = useRef<{ sessionId: string, sport: string, poseName?: string } | null>(null);
  
  useEffect(() => {
    onFeedbackRef.current = onFeedback;
  }, [onFeedback]);

  const connect = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      setConnectionError('No access token found');
      return;
    }

    const SOCKET_URL = getSocketUrl();
    console.log(`📡 Connecting to AI Feedback Relay: ${SOCKET_URL}`);

    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
    });

    socket.on('connect', () => {
      console.log('✅ Connected to AI Feedback Relay');
      setIsConnected(true);
      setConnectionError(null);
      if (sessionStateRef.current) {
        socket.emit('session:start', sessionStateRef.current);
      }
    });

    socket.on('connect_error', async (err) => {
      console.error('❌ WebSocket Auth Error:', err.message);
      
      // Handle Token Expiration
      if (err.message.includes('EXPIRED') || err.message.includes('Invalid token')) {
        console.log('🔄 Token expired. Attempting background refresh...');
        const tokens = await refreshAuthTokens();
        if (tokens) {
          console.log('✅ Token refreshed. Reconnecting...');
          socket.auth = { token: tokens.access_token };
          socket.connect();
          return;
        }
      }
      
      setIsConnected(false);
      setConnectionError(err.message.toUpperCase());
    });

    socket.on('feedback:result', (analysis: FrameAnalysis) => {
      onFeedbackRef.current(analysis);
    });

    socket.on('disconnect', (reason) => {
      console.warn('⚠️ Disconnected:', reason);
      setIsConnected(false);
    });

    socketRef.current = socket;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      socketRef.current?.disconnect();
    };
  }, [connect]);

  const startSession = useCallback((sessionId: string, sport: string, poseName?: string) => {
    sessionStateRef.current = { sessionId, sport, poseName };
    if (socketRef.current?.connected) {
      socketRef.current.emit('session:start', { sessionId, sport, poseName });
    }
  }, []);

  const submitFrame = useCallback((keypoints: PoseKeypoints, hands: Hand[] | null, sport: string, poseName?: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('frame:submit', { keypoints, hands, sport, poseName });
    }
  }, []);

  const stopSession = useCallback(() => {
    sessionStateRef.current = null;
    if (socketRef.current?.connected) {
      socketRef.current.emit('session:stop');
    }
  }, []);

  return { isConnected, connectionError, startSession, submitFrame, stopSession };
}
