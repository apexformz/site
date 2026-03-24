import { Router, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();
router.use(authenticateToken);

// GET /api/leaderboard/global
router.get('/global', async (req: AuthRequest, res: Response) => {
  try {
    const entries = await prisma.userStats.findMany({
      orderBy: { xp: 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, name: true, avatar_url: true, preferred_sport: true } },
      },
    });

    const formatted = entries.map((entry, index) => ({
      rank: index + 1,
      user_id: entry.user_id,
      name: entry.user.name,
      avatar_url: entry.user.avatar_url,
      sport: entry.user.preferred_sport,
      xp: entry.xp,
      level: entry.level,
    }));

    return res.json({ success: true, data: formatted });
  } catch (e) {
    logger.error('Global leaderboard error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/leaderboard/sport/:sport
router.get('/sport/:sport', async (req: AuthRequest, res: Response) => {
  try {
    const { sport } = req.params;
    const entries = await prisma.leaderboardEntry.findMany({
      where: { sport },
      orderBy: { all_time_xp: 'desc' },
      take: 100,
      include: {
        user: { select: { name: true, avatar_url: true } },
      },
    });

    const formatted = entries.map((entry, index) => ({
      rank: index + 1,
      user_id: entry.user_id,
      name: entry.user.name,
      avatar_url: entry.user.avatar_url,
      sport: entry.sport,
      xp: entry.all_time_xp,
    }));

    return res.json({ success: true, data: formatted });
  } catch (e) {
    logger.error('Sport leaderboard error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;
