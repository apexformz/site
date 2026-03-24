"use client";

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { FrameAnalysis, PoseKeypoints } from '@smartcoach/types';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:4000';

export function useWebSocket(onFeedback: (analysis: FrameAnalysis) => void) {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (!token) return;

    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      console.log('Connected to feedback relay');
      setIsConnected(true);
    });

    socket.on('feedback:result', (analysis: FrameAnalysis) => {
      onFeedback(analysis);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
    };
  }, []);

  const startSession = (sessionId: string, sport: string) => {
    socketRef.current?.emit('session:start', { sessionId, sport });
  };

  const submitFrame = (keypoints: PoseKeypoints, sport: string) => {
    socketRef.current?.emit('frame:submit', { keypoints, sport });
  };

  const stopSession = () => {
    socketRef.current?.emit('session:stop');
  };

  return { isConnected, startSession, submitFrame, stopSession };
}
