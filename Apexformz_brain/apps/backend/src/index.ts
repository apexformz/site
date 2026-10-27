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
import circleRoutes from './routes/circles';
import v1Routes from './v1/router';
import { startJobDispatcher } from './v1/prismaJobs';
import { prisma } from './utils/prisma';
import { validateEnvironment } from './config/environment';
import { assetRouter, startAssetRetention, storageReady } from './v1/assets';
import { operationsRouter, recordOperations } from './v1/operations';
import { packLoadOptionsFromEnv } from '../../../packages/sport-runtime/src/node';

validateEnvironment(process.env);

const app: Express = express();
const httpServer = createServer(app);

// Initialize real-time WebSocket server
initializeWebSocket(httpServer);

app.use(helmet());
app.use(recordOperations);
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(morgan('combined', { stream: { write: (msg) => logger.http(msg.trim()) } }));

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ success: true, message: 'SmartCoach Backend is running' });
});
app.get('/ready', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    if (process.env.APEXFORMZ_S3_BUCKET) await storageReady();
    res.json({ success: true, database: 'ready' });
  } catch {
    res.status(503).json({ success: false, database: 'unavailable' });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/circles', circleRoutes);
// ApexFormz Brain v1 API (TRD 13)
app.use('/api/v1', v1Routes);
app.use('/api/v1/assets', assetRouter);
app.use('/internal', operationsRouter);

// Error Handler
app.use((err: Error, req: Request, res: Response, next: express.NextFunction) => {
  logger.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

const PORT = Number(process.env.PORT || 4000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be an integer from 1 to 65535');

async function start(): Promise<void> {
  await packLoadOptionsFromEnv();
  await prisma.$connect();
  const dispatcher = startJobDispatcher();
  const retention = startAssetRetention();
  httpServer.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    logger.info(`ApexFormz Backend running on port ${PORT}`);
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    dispatcher?.stop();
    if (retention) clearInterval(retention);
    httpServer.close(() => { void prisma.$disconnect().finally(() => process.exit(0)); });
    setTimeout(() => { void prisma.$disconnect().finally(() => process.exit(0)); }, 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
void start().catch(() => {
  logger.error('Backend startup failed; check database availability and deployment configuration');
  process.exitCode = 1;
  void prisma.$disconnect();
});
