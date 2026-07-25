import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { ApiResponse, User, UserStats } from '../types';
import logger from '../utils/logger';

const router = Router();

// All routes require auth
router.use(authenticateToken);

// GET /api/users/me
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { 
        stats: true, 
        achievements: true,
        enhanced_streak: true,
        circle_members: { include: { circle: true } }
      },
    });

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const { password_hash, ...safeUser } = user;
    return res.json({ success: true, data: safeUser });
  } catch (error) {
    logger.error('Get user error:', error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// PATCH /api/users/me
router.patch(
  '/me',
  [
    body('name').optional().trim().isLength({ min: 2 }),
    body('preferred_sport').optional().isIn(['cricket', 'tennis', 'yoga', 'running']),
    body('avatar_url').optional().isURL(),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { name, preferred_sport, avatar_url } = req.body;
    const updateData: Record<string, string> = {};
    if (name) updateData.name = name;
    if (preferred_sport) updateData.preferred_sport = preferred_sport;
    if (avatar_url) updateData.avatar_url = avatar_url;

    try {
      const user = await prisma.user.update({
        where: { id: req.userId },
        data: updateData,
      });

      const { password_hash, ...safeUser } = user;
      return res.json({ success: true, data: safeUser });
    } catch (error) {
      logger.error('Update user error:', error);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }
);

// GET /api/users/:id/stats
router.get('/:id/stats', async (req: AuthRequest, res: Response) => {
  try {
    const stats = await prisma.userStats.findUnique({ where: { user_id: req.params.id } });
    if (!stats) return res.status(404).json({ success: false, error: 'Stats not found' });
    return res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Get stats error:', error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;
