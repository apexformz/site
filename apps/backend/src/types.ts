// Shared TypeScript types for all SmartCoach services

export type Sport = 'cricket' | 'tennis' | 'yoga' | 'running' | 'boxing' | 'football';

export interface Keypoint {
  x: number;
  y: number;
  score: number;
  name: string;
}

export interface PoseKeypoints {
  keypoints: Keypoint[];
  score: number;
  timestamp_ms: number;
}

export interface HandKeypoint extends Keypoint {}

export interface Hand {
  keypoints: HandKeypoint[];
  score: number;
  handedness: 'Left' | 'Right';
}

export interface HandDetectionResult {
  hands: Hand[];
  timestamp_ms: number;
}

export interface JointAngles {
  left_elbow: number;
  right_elbow: number;
  left_shoulder: number;
  right_shoulder: number;
  left_hip: number;
  right_hip: number;
  left_knee: number;
  right_knee: number;
  left_ankle: number;
  right_ankle: number;
  left_wrist: number;
  right_wrist: number;
}

export type FeedbackSeverity = 'good' | 'warning' | 'error';

export interface JointFeedback {
  joint: string;
  severity: FeedbackSeverity;
  message: string;
  angle_actual: number;
  angle_reference: number;
  error_degrees: number;
}

export interface CoachIssue {
  joint: string;
  problem: string;
  correction: string;
  severity: 'low' | 'medium' | 'high' | 'none';
}

export interface FrameAnalysis {
  score: number;           // 0-100 (Renamed from frame_score for consistency)
  joint_angles: JointAngles;
  issues: CoachIssue[];    // New structured feedback
  feedback?: JointFeedback[]; // Legacy support
  overall_severity: FeedbackSeverity;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  preferred_sport: Sport;
  created_at: string;
}

export interface UserStats {
  user_id: string;
  xp: number;
  level: number;
  streak: number;
  total_sessions: number;
  best_score: number;
}

export type AchievementType =
  | 'first_session'
  | 'streak_7'
  | 'streak_30'
  | 'perfect_score'
  | 'sessions_10'
  | 'sessions_50'
  | 'sessions_100'
  | 'level_5'
  | 'level_10'
  | 'level_25';

export interface Achievement {
  id: string;
  user_id: string;
  type: AchievementType;
  earned_at: string;
}

export interface TrainingSession {
  id: string;
  user_id: string;
  sport: Sport;
  duration_s: number;
  score: number;
  feedback_summary: string;
  xp_earned: number;
  created_at: string;
}

export interface PoseFrame {
  id: string;
  session_id: string;
  timestamp_ms: number;
  keypoints: PoseKeypoints;
  angles: JointAngles;
  feedback: JointFeedback[];
  frame_score: number;
  created_at?: string;
}

export interface LeaderboardEntry {
  rank: number;
  user_id: string;
  name: string;
  avatar_url: string | null;
  sport: Sport;
  weekly_xp: number;
  level: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
  preferred_sport: Sport;
}

export interface EnhancedStreak {
  id: string;
  user_id: string;
  current_streak: number;
  longest_streak: number;
  risk_score: number;
  save_tokens: number;
  identity_tier: string;
  last_valid_session: string | null;
  updated_at: string;
}

export interface Circle {
  id: string;
  name: string;
  shared_streak: number;
  circle_health: number;
  created_at: string;
  members?: CircleMember[];
  activities?: CircleActivity[];
}

export interface CircleMember {
  id: string;
  circle_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  user?: User;
}

export interface CircleActivity {
  id: string;
  circle_id: string;
  user_id: string;
  session_id: string;
  posture_score: number;
  improvement_delta: number;
  duration_s: number;
  created_at: string;
}

export const XP_THRESHOLDS = [0, 100, 250, 500, 900, 1500, 2300, 3300, 4600, 6200, 8200];

export function getLevel(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}

export function getBaseXpForLevel(level: number): number {
  return XP_THRESHOLDS[level - 1] ?? 0;
}

export function getXpForNextLevel(level: number): number {
  return XP_THRESHOLDS[level] ?? XP_THRESHOLDS[XP_THRESHOLDS.length - 1];
}

export const ACHIEVEMENT_META: Record<AchievementType, { title: string; description: string; icon: string }> = {
  first_session: { title: 'First Step', description: 'Complete your first training session', icon: '🏆' },
  streak_7: { title: '7-Day Warrior', description: 'Train for 7 consecutive days', icon: '🔥' },
  streak_30: { title: 'Monthly Master', description: 'Train for 30 consecutive days', icon: '⚡' },
  perfect_score: { title: 'Perfectionist', description: 'Score 100 in any session', icon: '💯' },
  sessions_10: { title: 'Dedicated', description: 'Complete 10 training sessions', icon: '🏅' },
  sessions_50: { title: 'Veteran', description: 'Complete 50 training sessions', icon: '🎖️' },
  sessions_100: { title: 'Elite Athlete', description: 'Complete 100 training sessions', icon: '👑' },
  level_5: { title: 'Rising Star', description: 'Reach Level 5', icon: '⭐' },
  level_10: { title: 'Pro Player', description: 'Reach Level 10', icon: '🌟' },
  level_25: { title: 'Legend', description: 'Reach Level 25', icon: '🦁' },
};

// ============================================================
// DYNAMIC MOVEMENT TYPES
// ============================================================

export interface DynamicPhase {
  name: string;
  duration_range_ms?: [number, number];
  weight?: number;
}

export interface KineticChainResult {
  score: number;
  order_expected: string[];
  order_actual: string[];
}

export interface DynamicFrameAnalysis extends FrameAnalysis {
  dynamic: true;
  current_phase: string;
  phase_index: number;
  phase_changed: boolean;
  phase_scores: Record<string, number>;
  rep_count: number;
  fluidity_score: number;
  kinetic_chain: KineticChainResult;
  total_phases: number;
  is_cyclical: boolean;
}
