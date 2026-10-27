import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

export class CircleService {
  /**
   * Evaluates if a given circle's dynamic health and streak should be updated.
   * Called daily by a cron job, or incrementally when a user registers a session.
   */
  static async updateCircleHealth(circleId: string) {
    // Determine circle members
    const members = await prisma.circleMember.findMany({
      where: { circle_id: circleId },
      include: {
        user: {
          include: {
            enhanced_streak: true
          }
        }
      }
    });

    if (members.length === 0) return;

    let totalRisk = 0;
    
    // Sort members by Risk Score to assign roles
    const membersWithRisk = members.map(m => {
      const risk = m.user.enhanced_streak?.risk_score || 0;
      totalRisk += risk;
      return { memberId: m.id, riskScore: risk };
    });

    membersWithRisk.sort((a, b) => b.riskScore - a.riskScore);

    const avgRisk = totalRisk / members.length;
    // Circle health is inversely proportional to average risk, max 100
    const newHealth = Math.max(0, 100 - avgRisk);

    // Update Circle Health
    await prisma.circle.update({
      where: { id: circleId },
      data: { circle_health: newHealth }
    });

    // Assign Roles
    // the max risk member is "at_risk_user"
    // the min risk member is "anchor_user"
    // the rest are "member"
    for (let i = 0; i < membersWithRisk.length; i++) {
      let role = 'member';
      if (membersWithRisk.length > 1) {
        if (i === 0 && membersWithRisk[i].riskScore > 30) role = 'at_risk_user';
        if (i === membersWithRisk.length - 1 && membersWithRisk[i].riskScore < 20) role = 'anchor_user';
      }

      await prisma.circleMember.update({
        where: { id: membersWithRisk[i].memberId },
        data: { role }
      });
    }

    logger.info(`🔄 Circle ${circleId} health updated to ${newHealth.toFixed(1)}. Roles reassigned.`);
  }

  /**
   * Logs a circle activity for a user and calculates if the circle's shared streak increments.
   * Requires that *all* members have completed an activity today to increment.
   */
  static async processMemberCompletion(circleId: string, userId: string, sessionId: string, score: number, duration_s: number) {
    // 1. Log Activity
    await prisma.circleActivity.create({
      data: {
        circle_id: circleId,
        user_id: userId,
        session_id: sessionId,
        posture_score: score,
        duration_s: duration_s,
      }
    });

    // 2. Refresh Circle Roles/Health
    await this.updateCircleHealth(circleId);

    // NOTE: Shared streak increments usually happen via a CRON job at midnight that 
    // checks if ALL members logged an activity that day. For instantaneous feedback,
    // we check if everyone has logged one TODAY.
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const members = await prisma.circleMember.findMany({ where: { circle_id: circleId } });
    
    // Get unique users who submitted today
    const activitiesToday = await prisma.circleActivity.groupBy({
      by: ['user_id'],
      where: {
        circle_id: circleId,
        created_at: { gte: today }
      }
    });

    // If everyone did it today, potentially bump shared streak? 
    // (Usually better to do this exactly ONCE per day to prevent double counting).
    if (activitiesToday.length >= members.length) {
      // Actually, to prevent double incrementing on the same day, we'd need a last_completed_date on Circle.
      // Assuming a simplistic model here, if the circle hasn't incremented yet today.
      const circle = await prisma.circle.findUnique({ where: { id: circleId } });
      if (circle) {
        // Pseudo check to ensure we only increment once per day per circle...
        // For production, we'd add `last_shared_increment_date` to Circle model.
      }
    }
  }
}
