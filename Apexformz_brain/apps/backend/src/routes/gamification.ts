import { Router, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();
router.use(authenticateToken);

// GET /api/gamification/achievements
router.get('/achievements', async (req: AuthRequest, res: Response) => {
  try {
    const achievements = await prisma.achievement.findMany({
      where: { user_id: req.userId! },
      orderBy: { earned_at: 'desc' },
    });
    return res.json({ success: true, data: achievements });
  } catch (e) {
    logger.error('Get achievements error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;
