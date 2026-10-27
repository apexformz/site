'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  User,
  UserStats,
  Achievement,
  TrainingSession,
} from '@smartcoach/types';
import { api } from '@/lib/api';
import { listBrainSessions } from '@/lib/brain/session';

export type SessionHistoryItem = Omit<TrainingSession, 'score'> & {
  score: number | null;
  movement_name?: string | null;
  source: 'brain' | 'legacy';
};

export type Athlete = User & {
  stats?: UserStats;
  achievements?: Achievement[];
  circle_members?: {
    role: string;
    circle: {
      id: string;
      name: string;
      shared_streak: number;
      circle_health: number;
    };
  }[];
};

export function useAthleteData(includeSessions = true) {
  const router = useRouter();
  const [user, setUser] = useState<Athlete | null>(null);
  const [sessions, setSessions] = useState<SessionHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [userResponse, sessionsResponse, brainSessions] = await Promise.all([
        api.get('/users/me'),
        includeSessions ? api.get('/sessions') : Promise.resolve(null),
        includeSessions ? listBrainSessions() : Promise.resolve([]),
      ]);
      if (!userResponse.data.success || !userResponse.data.data)
        throw new Error('Missing athlete data');
      setUser(userResponse.data.data);
      if (sessionsResponse) {
        const legacy = (sessionsResponse.data.data || []).map((session: TrainingSession) => ({ ...session, source: 'legacy' as const }));
        const brain: SessionHistoryItem[] = brainSessions.filter(session => session.ended_at && session.summary).map(session => ({
          id: session.session_id,
          user_id: userResponse.data.data.id,
          sport: session.sport as TrainingSession['sport'],
          score: session.summary?.last_score == null ? null : session.summary.last_score * 100,
          duration_s: session.duration_s ?? Math.max(0, Math.round((Date.parse(session.ended_at!) - Date.parse(session.started_at)) / 1000)),
          xp_earned: session.xp_earned ?? 0,
          frame_count: session.summary?.frames_processed ?? 0,
          feedback_summary: session.movement_name || session.movement_id,
          movement_name: session.movement_name,
          created_at: session.started_at,
          source: 'brain',
        }));
        setSessions([...brain, ...legacy].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 30));
      }
    } catch {
      setError(
        'We could not load your training data. Check your connection and try again.',
      );
    } finally {
      setLoading(false);
    }
  }, [includeSessions]);
  useEffect(() => {
    if (!localStorage.getItem('access_token')) {
      router.replace('/login');
      return;
    }
    void refresh();
  }, [refresh, router]);
  return { user, sessions, loading, error, refresh };
}
