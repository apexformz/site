import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { ApiResponse, AuthTokens, RegisterRequest, LoginRequest } from '@smartcoach/types';
import logger from '../utils/logger';
import crypto from 'crypto';

const router = Router();

function generateTokens(userId: string, email: string) {
  const access_token = jwt.sign(
    { userId, email },
    process.env.JWT_SECRET as string,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refresh_token = jwt.sign(
    { userId, email },
    process.env.JWT_REFRESH_SECRET as string,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
  return { access_token, refresh_token };
}

// POST /api/auth/register
router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('name').trim().isLength({ min: 2 }),
    body('preferred_sport').isIn(['cricket', 'tennis', 'yoga', 'running', 'boxing', 'football']),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const response: ApiResponse<null> = { success: false, error: errors.array()[0].msg };
      return res.status(400).json(response);
    }

    const { email, password, name, preferred_sport } = req.body as RegisterRequest;

    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ success: false, error: 'Email already registered' });
      }

      const password_hash = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: { email, password_hash, name, preferred_sport },
      });

      // Create stats row
      await prisma.userStats.create({
        data: { user_id: user.id },
      });

      // Create leaderboard entry
      await prisma.leaderboardEntry.create({
        data: { user_id: user.id, sport: preferred_sport },
      });

      const { access_token, refresh_token } = generateTokens(user.id, user.email);

      // Store refresh token
      await prisma.refreshToken.create({
        data: {
          token: crypto.createHash('sha256').update(refresh_token).digest('hex'),
          user_id: user.id,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      logger.info(`New user registered: ${email}`);
      const response: ApiResponse<AuthTokens & { user: { id: string; name: string; email: string } }> = {
        success: true,
        data: {
          access_token,
          refresh_token,
          expires_in: 900,
          user: { id: user.id, name: user.name, email: user.email },
        },
      };
      return res.status(201).json(response);
    } catch (error: any) {
      logger.error('Register error:', error);
      return res.status(500).json({ success: false, error: `Server error: ${error.message}` });
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { email, password } = req.body as LoginRequest;

    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const { access_token, refresh_token } = generateTokens(user.id, user.email);

      await prisma.refreshToken.create({
        data: {
          token: crypto.createHash('sha256').update(refresh_token).digest('hex'),
          user_id: user.id,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      const stats = await prisma.userStats.findUnique({ where: { user_id: user.id } });
      logger.info(`User logged in: ${email}`);

      return res.json({
        success: true,
        data: {
          access_token,
          refresh_token,
          expires_in: 900,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            preferred_sport: user.preferred_sport,
            avatar_url: user.avatar_url,
            stats,
          },
        },
      });
    } catch (error) {
      logger.error('Login error:', error);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }
);

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    return res.status(401).json({ success: false, error: 'Refresh token required' });
  }

  try {
    const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET as string) as {
      userId: string;
      email: string;
    };

    const hashed = crypto.createHash('sha256').update(refresh_token).digest('hex');
    const stored = await prisma.refreshToken.findUnique({ where: { token: hashed } });

    if (!stored || stored.expires_at < new Date()) {
      return res.status(401).json({ success: false, error: 'Refresh token expired or invalid' });
    }

    // Rotate token
    await prisma.refreshToken.delete({ where: { id: stored.id } });
    const { access_token, refresh_token: new_refresh } = generateTokens(payload.userId, payload.email);

    await prisma.refreshToken.create({
      data: {
        token: crypto.createHash('sha256').update(new_refresh).digest('hex'),
        user_id: payload.userId,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return res.json({ success: true, data: { access_token, refresh_token: new_refresh, expires_in: 900 } });
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid refresh token' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticateToken, async (req: AuthRequest, res: Response) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    const hashed = crypto.createHash('sha256').update(refresh_token).digest('hex');
    await prisma.refreshToken.deleteMany({ where: { token: hashed } });
  }
  return res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
