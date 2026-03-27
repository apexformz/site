"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { FrameAnalysis, PoseKeypoints } from '@smartcoach/types';

const getSocketUrl = () => {
  if (process.env.NEXT_PUBLIC_SOCKET_URL) return process.env.NEXT_PUBLIC_SOCKET_URL;
  // Fallback to origin hostname if localhost fails or for remote access
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
  
  useEffect(() => {
    onFeedbackRef.current = onFeedback;
  }, [onFeedback]);

  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (!token) {
      setConnectionError('No access token found');
      return;
    }

    const SOCKET_URL = getSocketUrl();
    console.log(`📡 Connecting to AI Feedback Relay: ${SOCKET_URL}`);

    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 10000,
    });

    socket.on('connect', () => {
      console.log('✅ Connected to AI Feedback Relay');
      setIsConnected(true);
      setConnectionError(null);
    });

    socket.on('connect_error', (err) => {
      console.error('❌ Connection Error:', err.message);
      setIsConnected(false);
      setConnectionError(err.message);
    });

    socket.on('feedback:result', (analysis: FrameAnalysis) => {
      onFeedbackRef.current(analysis);
    });

    socket.on('disconnect', (reason) => {
      console.warn('⚠️ Disconnected from AI Relay:', reason);
      setIsConnected(false);
      if (reason === 'io server disconnect') {
        // the disconnection was initiated by the server, you need to reconnect manually
        socket.connect();
      }
    });

    socketRef.current = socket;

    return () => {
      console.log('🔌 Cleaning up WebSocket connection');
      socket.disconnect();
    };
  }, []);

  const startSession = useCallback((sessionId: string, sport: string, poseName?: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('session:start', { sessionId, sport, poseName });
    } else {
      console.warn('Cannot start session: WebSocket not connected');
    }
  }, []);

  const submitFrame = useCallback((keypoints: PoseKeypoints, sport: string, poseName?: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('frame:submit', { keypoints, sport, poseName });
    }
  }, []);

  const stopSession = useCallback(() => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('session:stop');
    }
  }, []);

  return { isConnected, connectionError, startSession, submitFrame, stopSession };
}
