import { getLevel, getXpForNextLevel, AchievementType } from '../types';
import { prisma } from './prisma';
import logger from './logger';
import { StreakService } from '../services/streak.service';

export class GamificationEngine {
  /**
   * Calculate XP earned for a session based on duration and score
   */
  static calculateSessionXp(durationSeconds: number, score: number): number {
    // Base XP = 1 XP per 10 seconds active
    const baseXp = Math.max(10, Math.floor(durationSeconds / 10));
    
    // Multiplier based on score quality (0 to 2.5x)
    let modifier = 0.5;
    if (score >= 90) modifier = 2.5;
    else if (score >= 80) modifier = 1.5;
    else if (score >= 60) modifier = 1.0;
    
    return Math.floor(baseXp * modifier);
  }

  /**
   * Award XP to user, update stats, handle level-ups and streaks
   */
  static async processSessionResult(userId: string, xpEarned: number, score: number, durationSeconds: number, sport: string) {
    return await prisma.$transaction(async (tx) => {
      const stats = await tx.userStats.findUnique({ where: { user_id: userId } });
      if (!stats) throw new Error('User stats not found');

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const lastSessionDate = stats.last_session_date ? new Date(stats.last_session_date) : null;
      if (lastSessionDate) lastSessionDate.setHours(0, 0, 0, 0);

      let newStreak = stats.streak;
      let newLongestStreak = stats.longest_streak;

      // Handle streaks
      if (!lastSessionDate) {
        newStreak = 1;
        newLongestStreak = 1;
      } else if (lastSessionDate.getTime() < today.getTime()) {
        const diffDays = Math.floor((today.getTime() - lastSessionDate.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          newStreak += 1; // Continued streak
          if (newStreak > newLongestStreak) newLongestStreak = newStreak;
        } else if (diffDays > 1) {
          newStreak = 1; // Lost streak, reset
        }
      }

      // Add XP and level logic
      const newXp = stats.xp + xpEarned;
      const newLevel = getLevel(newXp);
      const leveledUp = newLevel > stats.level;

      // Update enhanced streak system
      const enhancedStreakProfile = await StreakService.updateEnhancedStreak(tx, userId, score, durationSeconds, sport);

      // Update basic stats
      const newBestScore = Math.max(stats.best_score, score);
      const newTotalSessions = stats.total_sessions + 1;

      await tx.userStats.update({
        where: { user_id: userId },
        data: {
          xp: newXp,
          level: newLevel,
          streak: newStreak,
          longest_streak: newLongestStreak,
          total_sessions: newTotalSessions,
          best_score: newBestScore,
          last_session_date: new Date(),
        },
      });

      // Update leaderboard cache
      await tx.leaderboardEntry.updateMany({
        where: { user_id: userId },
        data: {
          all_time_xp: newXp,
          weekly_xp: { increment: xpEarned },
        },
      });

      // Check achievements
      const earnedAchievements = await this.checkAchievements(
        tx,
        userId,
        newTotalSessions,
        newStreak,
        score,
        newLevel
      );

      return {
        xpEarned,
        newTotalXp: newXp,
        level: newLevel,
        leveledUp,
        newStreak,
        earnedAchievements,
      };
    });
  }

  /**
   * Evaluate conditions for achievements and award them
   */
  private static async checkAchievements(
    tx: any,
    userId: string,
    totalSessions: number,
    streak: number,
    score: number,
    level: number
  ): Promise<AchievementType[]> {
    const existing = await tx.achievement.findMany({ where: { user_id: userId } });
    const existingTypes = new Set(existing.map((a: any) => a.type as AchievementType));

    const newlyEarned: AchievementType[] = [];

    const checkAndAward = async (type: AchievementType, condition: boolean) => {
      if (condition && !existingTypes.has(type)) {
        await tx.achievement.create({ data: { user_id: userId, type } });
        newlyEarned.push(type);
      }
    };

    await checkAndAward('first_session', totalSessions >= 1);
    await checkAndAward('sessions_10', totalSessions >= 10);
    await checkAndAward('sessions_50', totalSessions >= 50);
    await checkAndAward('sessions_100', totalSessions >= 100);
    await checkAndAward('streak_7', streak >= 7);
    await checkAndAward('streak_30', streak >= 30);
    await checkAndAward('perfect_score', score >= 99);
    await checkAndAward('level_5', level >= 5);
    await checkAndAward('level_10', level >= 10);
    await checkAndAward('level_25', level >= 25);

    return newlyEarned;
  }
}
