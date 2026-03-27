"use client";

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { FrameAnalysis, PoseKeypoints, Hand } from '@smartcoach/types';

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
  
  // Track current session for auto-reconnection
  const sessionStateRef = useRef<{ sessionId: string, sport: string, poseName?: string } | null>(null);
  
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
      reconnectionAttempts: 20,
      reconnectionDelay: 1000,
      timeout: 15000,
    });

    socket.on('connect', () => {
      console.log('✅ Connected to AI Feedback Relay');
      setIsConnected(true);
      setConnectionError(null);
      
      // Auto-restore session if we were recording
      if (sessionStateRef.current) {
        console.log('🔄 Restoring AI training session after reconnect...');
        socket.emit('session:start', sessionStateRef.current);
      }
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
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
    };
  }, []);

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
