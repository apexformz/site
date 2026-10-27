'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowUpRight,
  Activity,
  Flame,
  LogOut,
  Mail,
  ShieldCheck,
  Trophy,
  Zap,
  Target,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  User,
  UserStats,
  getBaseXpForLevel,
  getXpForNextLevel,
} from '@smartcoach/types';
import { AppShell } from '@/components/AppShell';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { Faq } from '@/components/ui/Faq';

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [identity, setIdentity] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  useEffect(() => {
    async function loadData() {
      try {
        const res = await api.get('/users/me');
        setUser(res.data.data);
        setStats(res.data.data.stats);
        setIdentity(res.data.data.enhanced_streak);
      } catch {
        router.push('/login');
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, [router]);
  const handleLogout = () => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('token');
    delete api.defaults.headers.common.Authorization;
    router.replace('/login');
  };
  if (isLoading) return <LoadingScreen label="Loading your athlete profile" />;
  const level = stats?.level || 1;
  const xp = stats?.xp || 0;
  const baseXp = getBaseXpForLevel(level);
  const nextXp = getXpForNextLevel(level);
  const progress =
    nextXp > baseXp
      ? Math.max(0, Math.min(100, ((xp - baseXp) / (nextXp - baseXp)) * 100))
      : 100;
  return (
    <AppShell userName={user?.name} active="progress" title="Your profile">
      <div className="mx-auto max-w-6xl space-y-7 sm:space-y-9">
        <div className="flex flex-wrap items-end justify-between gap-6 mb-9">
          <div>
            <p className="text-sm font-medium text-primary mb-3">
              Your athlete space
            </p>
            <h1 className="display-title text-3xl sm:text-4xl">
              Your athlete profile.
            </h1>
            <p className="mt-4 text-base text-muted max-w-lg leading-relaxed">
              Your training identity, the work you’ve put in, and where you’re
              headed next.
            </p>
          </div>
          <Link
            href="/sports"
            className="btn-primary inline-flex items-center gap-3 text-base"
          >
            Start training <ArrowUpRight size={19} />
          </Link>
        </div>
        <section className="glass-card p-6 sm:p-9 relative overflow-hidden">
          <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-primary/[.045] blur-3xl pointer-events-none" />
          <div className="relative flex flex-col sm:flex-row sm:items-center gap-6 sm:gap-8">
            <div className="relative shrink-0">
              <div className="clay-icon h-24 w-24 sm:h-28 sm:w-28 rounded-[28px] overflow-hidden">
                {user?.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-4xl font-semibold">
                    {user?.name?.charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
              <span className="absolute -bottom-2 -right-2 rounded-2xl p-2 border border-border bg-surface-raised text-primary shadow-sm">
                <ShieldCheck size={19} />
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <span className="inline-flex items-center rounded-full border border-primary/15 bg-primary/[.06] px-3.5 py-1.5 text-sm text-primary capitalize">
                {identity?.identity_tier || 'Novice'} athlete
              </span>
              <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight break-words mt-4">
                {user?.name}
              </h2>
              <p className="text-sm sm:text-base text-muted flex items-center gap-2.5 break-all mt-3">
                <Mail size={17} className="shrink-0 text-subtle" />
                {user?.email}
              </p>
            </div>
            <div className="flex items-center gap-5 sm:pl-7 sm:border-l border-border">
              <div>
                <p className="text-sm text-muted">Current level</p>
                <p className="text-5xl font-semibold tracking-tight text-primary mt-2">
                  {level}
                </p>
              </div>
            </div>
          </div>
        </section>
        <section
          className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5"
          aria-label="Lifetime training stats"
        >
          {[
            {
              label: 'Training streak',
              value: identity?.current_streak ?? stats?.streak ?? 0,
              unit: 'days',
              icon: Flame,
            },
            {
              label: 'Total experience',
              value: xp.toLocaleString(),
              unit: 'XP earned',
              icon: Zap,
            },
            {
              label: 'Sessions completed',
              value: stats?.total_sessions || 0,
              unit: 'sessions',
              icon: Trophy,
            },
            {
              label: 'Best form score',
              value: stats?.best_score || '—',
              unit: 'out of 100',
              icon: Target,
            },
          ].map(({ label, value, unit, icon: Icon }) => (
            <div className="glass-card p-5 sm:p-7 min-w-0" key={label}>
              <div className="clay-icon h-11 w-11 rounded-2xl mb-5">
                <Icon size={21} strokeWidth={1.7} />
              </div>
              <p className="text-sm text-muted min-h-10 sm:min-h-0 leading-relaxed">
                {label}
              </p>
              <p className="text-3xl sm:text-4xl font-semibold tracking-tight mt-3 break-words">
                {value}
              </p>
              <p className="text-sm text-subtle mt-2">{unit}</p>
            </div>
          ))}
        </section>
        <div className="grid lg:grid-cols-[1.25fr_1fr] gap-7">
          <section className="glass-card p-6 sm:p-8">
            <div className="flex flex-wrap justify-between items-center gap-4 mb-8">
              <h3 className="text-lg font-semibold flex items-center gap-2.5">
                <Activity size={20} className="text-primary" /> Your next level
              </h3>
              <span className="text-sm text-muted">
                Level {level} → {level + 1}
              </span>
            </div>
            <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
              <p className="text-4xl font-semibold tracking-tight">
                {Math.round(progress)}
                <span className="text-2xl text-muted">%</span>
              </p>
              <p className="text-sm text-muted">
                {Math.max(0, nextXp - xp).toLocaleString()} XP to go
              </p>
            </div>
            <div
              className="h-3 rounded-full bg-surface-inset overflow-hidden"
              role="progressbar"
              aria-label="Level progress"
              aria-valuenow={Math.round(progress)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary to-secondary"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-sm text-muted mt-5 leading-relaxed">
              Every completed session adds to your experience. Keep building at
              your own pace.
            </p>
            <div className="grid grid-cols-2 gap-5 mt-8 pt-6 border-t border-border">
              <div>
                <p className="text-sm text-muted mb-3">Streak saves</p>
                <p className="text-2xl font-semibold">
                  {identity?.save_tokens || 0}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted mb-3">Streak risk</p>
                <p className="text-2xl font-semibold">
                  {identity?.risk_score || 0}
                  <span className="text-sm text-subtle"> / 100</span>
                </p>
              </div>
            </div>
          </section>
          <section className="glass-card p-6 sm:p-8 flex flex-col">
            <h3 className="text-lg font-semibold mb-8">The details</h3>
            <dl className="space-y-6 text-sm sm:text-base">
              <div className="flex flex-wrap justify-between gap-3">
                <dt className="text-muted">Your discipline</dt>
                <dd className="capitalize font-medium">
                  {user?.preferred_sport || 'Not selected'}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-3">
                <dt className="text-muted">Athlete tier</dt>
                <dd className="font-medium capitalize">
                  {identity?.identity_tier || 'Novice'}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-3">
                <dt className="text-muted">Member since</dt>
                <dd className="font-medium">
                  {user?.created_at
                    ? new Date(user.created_at).toLocaleDateString('en-GB', {
                        month: 'short',
                        year: 'numeric',
                      })
                    : '—'}
                </dd>
              </div>
            </dl>
            <div className="mt-auto pt-8">
              <Link
                href={
                  user?.preferred_sport
                    ? `/train/${user.preferred_sport}/setup`
                    : '/sports'
                }
                className="flex justify-between items-center gap-3 rounded-2xl border border-primary/15 bg-primary/[.05] px-5 py-4 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
              >
                Train your discipline{' '}
                <ArrowUpRight size={18} className="shrink-0" />
              </Link>
              <button
                onClick={handleLogout}
                className="mt-6 py-1 flex items-center gap-2.5 text-sm text-muted hover:text-accent-danger transition-colors"
              >
                <LogOut size={17} /> Sign out of your account
              </button>
            </div>
          </section>
        </div>
        <section
          className="glass-card p-6 sm:p-8"
          aria-labelledby="profile-metrics-title"
        >
          <div className="max-w-2xl mb-2">
            <p className="text-sm font-medium text-primary mb-3">
              Know your numbers
            </p>
            <h2
              id="profile-metrics-title"
              className="text-2xl font-semibold tracking-tight"
            >
              The story behind your progress.
            </h2>
            <p className="text-base text-muted leading-relaxed mt-4">
              These measures describe your saved training activity. Use them to
              spot a pattern and choose what to work on next.
            </p>
          </div>
          <Faq
            items={[
              {
                question: 'How do XP and levels work?',
                answer:
                  'Completed sessions earn XP for training time. Squash Brain sessions without a technique score earn duration-based XP; an available form score can increase the multiplier. Your level comes from total XP, and the progress bar shows how far you are from the next level’s threshold.',
              },
              {
                question: 'What counts toward my training streak?',
                answer: identity
                  ? 'Your enhanced streak counts qualifying training days. A session must last at least 30 seconds and meet its sport’s score threshold: 70 for Cricket, Tennis, and Running; 75 for Yoga, Boxing, Taekwondo, and Squash. An unscored Brain session earns XP and counts in your basic streak, but cannot qualify for this score-based enhanced streak. Multiple sessions on the same day do not add extra streak days.'
                  : 'Until an enhanced streak profile is available, this page shows the basic streak from your completed sessions. Enhanced streaks also require at least 30 seconds of training and a minimum score for the selected sport.',
              },
              {
                question: 'What do streak saves, risk, and athlete tier mean?',
                answer:
                  'A streak save can automatically preserve an existing streak after a gap. The system awards a save at each 30-day streak milestone, up to three held at once. Streak risk reflects gaps in qualifying training and is updated when a session is saved; it is not a health or injury assessment. Athlete tiers follow enhanced streak milestones: Beginner at 7 days, Consistent at 30, Athlete at 100, and Elite at 365.',
              },
              {
                question: 'How should I read my best form score?',
                answer:
                  'Your best form score is the highest score from your saved sessions. A score compares tracked movement with the selected technique’s reference, so different exercises and camera views are not directly equivalent. Review the coaching notes alongside the number to understand what improved.',
              },
            ]}
          />
        </section>
      </div>
    </AppShell>
  );
}
