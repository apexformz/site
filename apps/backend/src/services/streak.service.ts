import { prisma } from '../utils/prisma';
import logger from '../utils/logger';

export class StreakService {
  // DYNAMIC THRESHOLDS BASED ON SPORT (or exercise_type)
  private static SCORE_THRESHOLDS: Record<string, number> = {
    yoga: 75,
    squats: 80,
    plank: 85,
    cricket: 70,
    tennis: 70,
    running: 70,
    boxing: 75,
    football: 70,
    default: 75,
  };

  private static MIN_DURATION_SECONDS = 30;

  /**
   * Evaluates if a session counts towards an Enhanced Streak
   * Rule A: Duration must be >= 30 seconds
   * Rule B: Score must be >= Dynamic Threshold for the sport
   */
  static validateSession(duration_s: number, score: number, sport: string): boolean {
    if (duration_s < this.MIN_DURATION_SECONDS) return false;
    
    const threshold = this.SCORE_THRESHOLDS[sport.toLowerCase()] || this.SCORE_THRESHOLDS.default;
    return score >= threshold;
  }

  /**
   * Determines Identity Tier based on validated streak
   */
  static computeIdentity(streak: number): string {
    if (streak >= 365) return "Elite";
    if (streak >= 100) return "Athlete";
    if (streak >= 30) return "Consistent";
    if (streak >= 7) return "Beginner";
    return "Novice";
  }

  /**
   * Updates or Creates the EnhancedStreak Profile in the DB
   * Should be called in a transaction context if possible, but handles its own updates.
   */
  static async updateEnhancedStreak(tx: any, userId: string, score: number, duration_s: number, sport: string): Promise<any> {
    const isValid = this.validateSession(duration_s, score, sport);
    
    // Ensure profile exists
    let profile = await tx.enhancedStreak.findUnique({ where: { user_id: userId } });
    
    if (!profile) {
      profile = await tx.enhancedStreak.create({
        data: { user_id: userId, current_streak: 0, longest_streak: 0, risk_score: 0, save_tokens: 0 }
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const lastValidDate = profile.last_valid_session ? new Date(profile.last_valid_session) : null;
    if (lastValidDate) lastValidDate.setHours(0, 0, 0, 0);

    let newStreak = profile.current_streak;
    let newLongest = profile.longest_streak;
    let newSaveTokens = profile.save_tokens;
    let newRiskScore = profile.risk_score;

    let diffDays = 0;
    if (lastValidDate) {
      diffDays = Math.floor((today.getTime() - lastValidDate.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Check degradation (missed days)
    if (lastValidDate && lastValidDate.getTime() < today.getTime()) {
      if (diffDays === 1 && isValid) {
        // Perfect continuation
        newStreak += 1;
        if (newStreak > newLongest) newLongest = newStreak;
        newRiskScore = Math.max(0, newRiskScore - 10);
      } else if (diffDays > 1) {
        // Missed at least one day
        if (newSaveTokens > 0) {
          // Consume a save token!
          newSaveTokens -= 1;
          logger.info(`🛡️ User ${userId} consumed a Streak Save Token. Current Streak saved at ${newStreak}`);
          if (isValid) {
            newStreak += 1; // Used token to bridge gap + did activity today
          }
          newRiskScore = Math.min(100, newRiskScore + 20); // Still increase risk since they almost lost it
        } else {
          // No save tokens, streak broken
          logger.info(`💔 User ${userId} lost their enhanced streak of ${newStreak}.`);
          newStreak = isValid ? 1 : 0;
          newRiskScore = Math.min(100, newRiskScore + 50);
        }
      }
    } else if (!lastValidDate && isValid) {
      // First ever valid session
      newStreak = 1;
      newLongest = 1;
    }

    // Award Save Tokens (Every 30 perfect days earns 1 token, max 3)
    if (newStreak > 0 && newStreak % 30 === 0 && isValid && (!lastValidDate || diffDays > 0)) {
      newSaveTokens = Math.min(3, newSaveTokens + 1);
      logger.info(`🪙 User ${userId} earned a Streak Save Token!`);
    }

    // Identity update
    const newIdentity = this.computeIdentity(newStreak);

    // Persist
    return await tx.enhancedStreak.update({
      where: { user_id: userId },
      data: {
        current_streak: newStreak,
        longest_streak: newLongest,
        risk_score: newRiskScore,
        save_tokens: newSaveTokens,
        identity_tier: newIdentity,
        last_valid_session: isValid ? new Date() : profile.last_valid_session
      }
    });
  }
}
