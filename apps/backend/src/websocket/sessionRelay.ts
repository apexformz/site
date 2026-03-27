import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import axios from 'axios';
import http from 'http';
import https from 'https';
import { verifyToken } from '../utils/auth.utils';
import { PoseKeypoints, FrameAnalysis } from '@smartcoach/types';

// Optimize for high-frequency frame analysis with persistent connections
const aiHttpClient = axios.create({
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100 }),
  timeout: 1000,
});

export function initializeWebSocket(server: HttpServer) {
  const io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Authentication Middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error: Token required'));

    try {
      const payload = verifyToken(token, process.env.JWT_SECRET as string) as { userId: string };
      socket.data.userId = payload.userId;
      next();
    } catch (err: any) {
      logger.warn(`WebSocket Auth Failed: ${err.message}`);
      next(new Error(`Authentication error: ${err.message.toUpperCase()}`));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId;
    logger.info(`🔌 WebSocket connected: User ${userId} (${socket.id})`);

    let activeSessionId: string | null = null;
    let activeSport: string | null = null;
    let activePoseName: string | null = null;
    let lastLogTime = 0;

    socket.on('session:start', async ({ sessionId, sport, poseName }) => {
      activeSessionId = sessionId;
      activeSport = sport;
      activePoseName = poseName;
      socket.join(`session:${sessionId}`);
      logger.info(`🚀 Starting AI session: ${sessionId} | Sport: ${sport} | Pose: ${poseName || 'default'}`);
    });

    socket.on('frame:submit', async (data: { keypoints: PoseKeypoints; sport: string; poseName?: string }) => {
      if (!activeSessionId) return;

      // Server-side console visibility (Sampled at 1Hz to show it's working)
      const now = Date.now();
      if (now - lastLogTime > 1000) {
        logger.info(`📸 Analyzed Frame for ${activeSessionId.slice(0, 8)}... | Points: ${data.keypoints.keypoints.length} | Score: ${data.keypoints.score.toFixed(2)}`);
        lastLogTime = now;
      }

      try {
        const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
        const response = await aiHttpClient.post<FrameAnalysis>(`${aiServiceUrl}/analyze`, {
          keypoints: data.keypoints.keypoints,
          sport: data.sport,
          pose_name: data.poseName || activePoseName,
        });

        const analysis = response.data;

        if (now - lastLogTime > 950) {
          logger.info(`📊 AI Feedback Code: ${analysis.overall_severity.toUpperCase()} | Score: ${analysis.frame_score}`);
        }

        // Save to Database Fire-and-Forget
        prisma.poseFrame.create({
          data: {
            session_id: activeSessionId,
            timestamp_ms: data.keypoints.timestamp_ms,
            keypoints: data.keypoints as any,
            angles: analysis.joint_angles as any,
            feedback: analysis.feedback as any,
            frame_score: analysis.frame_score,
          },
        }).catch((e) => logger.error('Failed to save frame async:', e));

        // Send feedback back to client
        socket.emit('feedback:result', analysis);
      } catch (error: any) {
        logger.error(`❌ AI Analysis failed: ${error.message}`);
        socket.emit('feedback:error', { 
          message: 'AI Service currently unreachable. Ensure the AI backend is running on port 8000.' 
        });
      }
    });

    socket.on('session:stop', () => {
      if (activeSessionId) {
        logger.info(`🏁 Session stopped: ${activeSessionId}`);
        socket.leave(`session:${activeSessionId}`);
        activeSessionId = null;
      }
    });

    socket.on('disconnect', () => {
      logger.info(`🔌 WebSocket disconnected: User ${userId}`);
    });
  });

  return io;
}
