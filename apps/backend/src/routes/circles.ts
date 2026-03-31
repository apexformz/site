import { Router, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { prisma } from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { randomBytes } from 'crypto';
import logger from '../utils/logger';

const generateInviteCode = () => randomBytes(4).toString('hex').toUpperCase(); // 8 char hex

const router = Router();

// All routes require auth
router.use(authenticateToken);

// POST /api/circles
router.post(
  '/',
  [
    body('name').trim().isLength({ min: 3, max: 30 }).withMessage('Name must be between 3 and 30 characters'),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { name } = req.body;

    try {
      // Allow users to create multiple circles by removing the prior 1-circle limitation constraint.

      // Create new Circle and add user as anchor_user automatically
      const result = await prisma.$transaction(async (tx) => {
        const shortCode = generateInviteCode();
        const circle = await tx.circle.create({
          data: {
            id: shortCode,
            name,
            shared_streak: 0,
            circle_health: 100,
          }
        });

        const member = await tx.circleMember.create({
          data: {
            circle_id: circle.id,
            user_id: req.userId!,
            role: 'anchor_user', // Creator is anchor by default
          }
        });

        // Add an EnhancedStreak if they don't have one
        const streak = await tx.enhancedStreak.findUnique({ where: { user_id: req.userId! }});
        if (!streak) {
           await tx.enhancedStreak.create({
             data: { user_id: req.userId!, current_streak: 0, identity_tier: 'Novice' }
           });
        }

        return circle;
      });

      return res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Create circle error:', error);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }
);

// POST /api/circles/join
router.post(
  '/join',
  [
    body('circleId').trim().isLength({ min: 6 }).withMessage('Invalid invite code format'),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg });
    }

    const { circleId } = req.body; // now just a short code

    try {
      // Check if user is already in THIS specific circle
      const existingMember = await prisma.circleMember.findFirst({
        where: { user_id: req.userId, circle_id: circleId }
      });

      if (existingMember) {
        return res.status(400).json({ success: false, error: 'You are already in this circle' });
      }

      // Check if circle exists
      const circle = await prisma.circle.findUnique({
        where: { id: circleId }
      });

      if (!circle) {
        return res.status(404).json({ success: false, error: 'Circle not found' });
      }

      // Add user to circle
      const result = await prisma.$transaction(async (tx) => {
        const member = await tx.circleMember.create({
          data: {
            circle_id: circleId,
            user_id: req.userId!,
            role: 'member', 
          }
        });

        // Add an EnhancedStreak if they don't have one
        const streak = await tx.enhancedStreak.findUnique({ where: { user_id: req.userId! }});
        if (!streak) {
           await tx.enhancedStreak.create({
             data: { user_id: req.userId!, current_streak: 0, identity_tier: 'Novice' }
           });
        }

        return member;
      });

      // We should ideally call CircleService.updateCircleHealth(circleId) here
      // but to avoid cyclic imports or overhead, we'll let it recalculate on next cron/session.

      return res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('Join circle error:', error);
      if (error.code === 'P2002') return res.status(400).json({ success: false, error: 'Already joined this circle' });
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }
);

// GET /api/circles/:id
router.get(
  '/:id',
  async (req: AuthRequest, res: Response) => {
    try {
      const circleId = req.params.id;

      const circle = await prisma.circle.findUnique({
        where: { id: circleId },
        include: {
          members: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  avatar_url: true,
                  enhanced_streak: true
                }
              }
            }
          }
        }
      });

      if (!circle) {
        return res.status(404).json({ success: false, error: 'Circle not found' });
      }

      // Authorization Check - Only allow members to view
      const isMember = circle.members.some(m => m.user_id === req.userId);
      if (!isMember) {
        return res.status(403).json({ success: false, error: 'Access denied: You are not a member of this circle' });
      }

      return res.json({ success: true, data: circle });
    } catch (error) {
      logger.error('Fetch circle error:', error);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  }
);

export default router;
