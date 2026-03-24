import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import axios from 'axios';
import { PoseKeypoints, FrameAnalysis } from '@smartcoach/types';

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
    let frameBuffer: any[] = []; // In a real app we would buffer frames to save to DB at end

    socket.on('session:start', async ({ sessionId, sport }) => {
      activeSessionId = sessionId;
      activeSport = sport;
      socket.join(`session:${sessionId}`);
      logger.info(`Session started: ${sessionId} for User ${userId}`);
    });

    socket.on('frame:submit', async (data: { keypoints: PoseKeypoints; sport: string }) => {
      if (!activeSessionId) return;

      try {
        // Forward to AI Service
        const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
        const response = await axios.post<FrameAnalysis>(`${aiServiceUrl}/analyze`, {
          keypoints: data.keypoints,
          sport: data.sport,
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
