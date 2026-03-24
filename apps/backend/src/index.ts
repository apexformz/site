import 'dotenv/config';
import express, { Express, Request, Response } from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import logger from './utils/logger';
import { initializeWebSocket } from './websocket/sessionRelay';

import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import sessionRoutes from './routes/sessions';
import gamificationRoutes from './routes/gamification';
import leaderboardRoutes from './routes/leaderboard';

const app: Express = express();
const httpServer = createServer(app);

// Initialize real-time WebSocket server
initializeWebSocket(httpServer);

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(morgan('combined', { stream: { write: (msg) => logger.http(msg.trim()) } }));

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ success: true, message: 'SmartCoach Backend is running' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

// Error Handler
app.use((err: Error, req: Request, res: Response, next: express.NextFunction) => {
  logger.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, () => {
  logger.info(`🚀 SmartCoach Backend running on port ${PORT}`);
});
