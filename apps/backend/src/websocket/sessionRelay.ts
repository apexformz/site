import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import axios from 'axios';
import http from 'http';
import https from 'https';
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
      const payload = jwt.verify(token, process.env.JWT_SECRET as string) as { userId: string };
      socket.data.userId = payload.userId;
      next();
    } catch (err) {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId;
    logger.info(`WebSocket connected: User ${userId} (${socket.id})`);

    let activeSessionId: string | null = null;
    let activeSport: string | null = null;
    let activePoseName: string | null = null;
    let frameBuffer: any[] = []; // In a real app we would buffer frames to save to DB at end

    socket.on('session:start', async ({ sessionId, sport, poseName }) => {
      activeSessionId = sessionId;
      activeSport = sport;
      activePoseName = poseName;
      socket.join(`session:${sessionId}`);
      logger.info(`Session started: ${sessionId} for Sport ${sport} (Pose: ${poseName})`);
    });

    socket.on('frame:submit', async (data: { keypoints: PoseKeypoints; sport: string; poseName?: string }) => {
      if (!activeSessionId) return;

      try {
        // Forward to AI Service with connection pooling
        const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
        const response = await aiHttpClient.post<FrameAnalysis>(`${aiServiceUrl}/analyze`, {
          keypoints: data.keypoints,
          sport: data.sport,
          pose_name: data.poseName || activePoseName,
        });

        const analysis = response.data;

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

        // Immediately send feedback back to client
        socket.emit('feedback:result', analysis);
      } catch (error) {
        logger.error(`AI Analysis failed for frame: ${(error as Error).message}`);
        // Optionally emit error back to client
      }
    });

    socket.on('session:stop', () => {
      if (activeSessionId) {
        socket.leave(`session:${activeSessionId}`);
        logger.info(`Session stopped: ${activeSessionId}`);
        activeSessionId = null;
        activeSport = null;
      }
    });

    socket.on('disconnect', () => {
      logger.info(`WebSocket disconnected: User ${userId}`);
    });
  });

  return io;
}
