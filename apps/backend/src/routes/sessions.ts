import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { GamificationEngine } from '../utils/gamification';
import logger from '../utils/logger';

const router = Router();
router.use(authenticateToken);

// POST /api/sessions
router.post(
  '/',
  [body('sport').isIn(['cricket', 'tennis', 'yoga', 'running'])],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, error: errors.array()[0].msg });

    try {
      const session = await prisma.trainingSession.create({
        data: { user_id: req.userId!, sport: req.body.sport },
      });
      return res.status(201).json({ success: true, data: session });
    } catch (e) {
      logger.error('Create session error:', e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }
);

// PATCH /api/sessions/:id
router.patch(
  '/:id',
  [
    body('duration_s').isInt({ min: 1 }),
    body('score').isFloat({ min: 0, max: 100 }),
    body('feedback_summary').isString(),
    body('frame_count').isInt({ min: 1 }),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, error: errors.array()[0].msg });

    const { id } = req.params;
    const { duration_s, score, feedback_summary, frame_count } = req.body;

    try {
      const session = await prisma.trainingSession.findUnique({ where: { id } });
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      if (session.user_id !== req.userId) return res.status(403).json({ success: false, error: 'Forbidden' });

      // Calculate XP
      const xpEarned = GamificationEngine.calculateSessionXp(duration_s, score);

      // Save session
      const updatedSession = await prisma.trainingSession.update({
        where: { id },
        data: { duration_s, score, feedback_summary, frame_count, xp_earned: xpEarned },
      });

      // Update global gamification stats securely via transaction
      const gamificationResult = await GamificationEngine.processSessionResult(req.userId!, xpEarned, score);

      return res.json({
        success: true,
        data: { session: updatedSession, gamification: gamificationResult },
      });
    } catch (e) {
      logger.error('Update session error:', e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }
);

// GET /api/sessions
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const sessions = await prisma.trainingSession.findMany({
      where: { user_id: req.userId! },
      orderBy: { created_at: 'desc' },
      take: 20, // get last 20
    });
    return res.json({ success: true, data: sessions });
  } catch (e) {
    logger.error('Get sessions error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/sessions/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const session = await prisma.trainingSession.findUnique({
      where: { id: req.params.id },
      include: { frames: true },
    });
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (session.user_id !== req.userId) return res.status(403).json({ success: false, error: 'Forbidden' });

    return res.json({ success: true, data: session });
  } catch (e) {
    logger.error('Get session info error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;
