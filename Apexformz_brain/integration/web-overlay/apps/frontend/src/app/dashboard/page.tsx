'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Award,
  ChevronRight,
  Clock,
  Crown,
  Flame,
  RotateCcw,
  ShieldHalf,
  Star,
  Target,
  Trophy,
  Users,
  Zap,
} from 'lucide-react';
import { getBaseXpForLevel, getXpForNextLevel } from '@smartcoach/types';
import { AppShell } from '@/components/AppShell';
import { BadgesModal } from '@/components/BadgesModal';
import { SportCard } from '@/components/SportCard';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { useAthleteData } from '@/hooks/useAthleteData';
import { SPORTS, AVAILABLE_SPORTS, LEGACY_SPORTS } from '@/lib/sports';

const badgeDefinitions = [
  {
    id: 'first_session',
    title: 'First session',
    description: 'Complete your first training session.',
    icon: Flame,
  },
  {
    id: 'perfect_score',
    title: 'Perfect form',
    description: 'Achieve a form score of 100.',
    icon: Target,
  },
  {
    id: 'streak_7',
    title: 'Seven-day streak',
    description: 'Train seven days in a row.',
    icon: Star,
  },
  {
    id: 'level_10',
    title: 'Level 10',
    description: 'Reach athlete level 10.',
    icon: Crown,
  },
  {
    id: 'sessions_50',
    title: '50 sessions',
    description: 'Complete 50 training sessions.',
    icon: Award,
  },
  {
    id: 'streak_30',
    title: 'Unstoppable',
    description: 'Build a 30-day training streak.',
    icon: ShieldHalf,
  },
];

export default function DashboardPage() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const { user, sessions, loading, error, refresh } = useAthleteData();
  const [badgesOpen, setBadgesOpen] = useState(false);
  if (loading)
    return <LoadingScreen label="Loading your performance overview" />;
  if (error)
    return (
      <AppShell title="Overview">
        <section className="glass-card mx-auto max-w-lg p-8 text-center sm:p-10">
          <Activity className="mx-auto mb-6 text-primary" size={28} />
          <h1 className="text-2xl font-semibold tracking-tight">
            Your overview is unavailable.
          </h1>
          <p className="my-5 text-base leading-relaxed text-muted" role="alert">
            {error}
          </p>
          <button className="btn-primary" onClick={() => void refresh()}>
            <RotateCcw size={17} />
            Try again
          </button>
        </section>
      </AppShell>
    );

  const stats = user?.stats;
  const xp = stats?.xp || 0;
  const level = stats?.level || 1;
  const base = getBaseXpForLevel(level);
  const next = getXpForNextLevel(level);
  const atMaxLevel = next <= base;
  const progress = atMaxLevel
    ? 100
    : Math.min(100, Math.max(0, ((xp - base) / (next - base)) * 100));
  const preferred =
    [...AVAILABLE_SPORTS, ...LEGACY_SPORTS].find((sport) => sport.id === user?.preferred_sport) || AVAILABLE_SPORTS[0];
  const featured = SPORTS;
  const badges = badgeDefinitions.map((badge) => ({
    ...badge,
    unlocked: Boolean(
      user?.achievements?.some((achievement) => achievement.type === badge.id),
    ),
    color: 'bg-primary/10 border border-primary/20 text-primary',
  }));
  const recentMinutes = Math.round(
    sessions.reduce((total, session) => total + session.duration_s, 0) / 60,
  );
  const circles = user?.circle_members || [];

  return (
    <AppShell
      userName={user?.name}
      active="overview"
      title="Performance overview"
    >
      <div className="mb-9 flex flex-wrap items-end justify-between gap-6 sm:mb-11">
        <div>
          <p className="mb-3 text-sm font-medium text-primary">
            Your training overview
          </p>
          <h1 className="display-title text-[32px] leading-[1.15] tracking-[-.045em] sm:text-[44px]">
            Welcome back, {user?.name?.split(' ')[0] || 'athlete'}.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted">
            Your progress, your next session, and everything in between.
          </p>
        </div>
        <Link
          href={`/train/${preferred.id}/setup`}
          className="btn-primary !px-6 !py-4"
        >
          <Zap size={18} />
          Start training <ArrowUpRight size={17} />
        </Link>
      </div>

      <section
        aria-label="Training statistics"
        className="mb-10 grid gap-4 sm:grid-cols-3 sm:gap-5"
      >
        {[
          {
            label: 'Sessions completed',
            value: stats?.total_sessions || 0,
            detail: 'Across your training journey',
            icon: Activity,
          },
          {
            label: 'Best form score',
            value: stats?.best_score || sessions.some(session => session.score !== null)
              ? Math.round(stats?.best_score || 0)
              : '—',
            detail: 'Scored sessions only, out of 100',
            icon: Target,
          },
          {
            label: 'Training streak',
            value: stats?.streak || 0,
            detail: 'Consecutive days of training',
            icon: Flame,
          },
        ].map(({ label, value, detail, icon: Icon }) => (
          <div key={label} className="glass-card !rounded-[28px] p-6 sm:p-7">
            <div className="mb-5 flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-muted">{label}</span>
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/[.07] text-primary">
                <Icon size={19} strokeWidth={1.6} />
              </span>
            </div>
            <p className="text-[44px] font-semibold leading-none tracking-[-.06em] tabular-nums sm:text-[48px]">
              {value}
            </p>
            <p className="mt-4 text-sm leading-relaxed text-subtle">{detail}</p>
          </div>
        ))}
      </section>

      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1.65fr)_minmax(280px,.75fr)] xl:gap-9">
        <section aria-labelledby="discipline-title" className="min-w-0">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2
                id="discipline-title"
                className="text-2xl font-semibold tracking-[-.035em] sm:text-[28px]"
              >
                Choose your discipline
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Make your next session count.
              </p>
            </div>
            <Link
              href="/sports"
              className="flex items-center gap-2 text-sm font-medium text-primary transition hover:text-secondary"
            >
              All sports <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            {featured.map((sport) => (
              <SportCard
                key={sport.id}
                {...sport}
                onClick={() => router.push(`/train/${sport.id}/setup`)}
              />
            ))}
          </div>
        </section>

        <aside className="grid gap-6 sm:grid-cols-2 lg:grid-cols-1 lg:pt-[84px]">
          <section className="glass-card relative overflow-hidden !rounded-[28px] p-6 sm:p-7">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-primary/[.035] blur-2xl"
            />
            <div className="relative flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold tracking-tight">
                Athlete progression
              </h2>
              <Link
                href="/profile"
                aria-label="View athlete profile"
                className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition hover:bg-primary/10 hover:text-primary"
              >
                <ArrowUpRight size={17} />
              </Link>
            </div>
            <div className="relative mx-auto my-7 flex h-[164px] w-[164px] items-center justify-center">
              <svg
                className="absolute inset-0 h-full w-full -rotate-90 text-primary"
                viewBox="0 0 164 164"
                aria-hidden="true"
              >
                <circle
                  cx="82"
                  cy="82"
                  r="72"
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity=".1"
                  strokeWidth="7"
                />
                <motion.circle
                  cx="82"
                  cy="82"
                  r="72"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray="452.39"
                  initial={reduce ? false : { strokeDashoffset: 452.39 }}
                  animate={{ strokeDashoffset: 452.39 * (1 - progress / 100) }}
                  transition={{ duration: reduce ? 0 : 0.9 }}
                />
              </svg>
              <div className="text-center">
                <span className="text-sm text-muted">Level</span>
                <p className="mt-1 text-[52px] font-semibold leading-none tracking-[-.06em]">
                  {String(level).padStart(2, '0')}
                </p>
              </div>
            </div>
            <div className="relative mb-3 flex items-baseline justify-between gap-3">
              <p className="text-base font-semibold">
                {xp.toLocaleString()}{' '}
                <span className="text-sm font-normal text-muted">XP</span>
              </p>
              <span className="text-sm font-medium text-primary">
                {Math.round(progress)}%
              </span>
            </div>
            <div
              className="relative h-2 overflow-hidden rounded-full bg-surface-inset"
              role="progressbar"
              aria-label="Progress to next level"
              aria-valuenow={Math.round(progress)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <motion.div
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: reduce ? 0 : 0.8 }}
                className="h-full rounded-full bg-primary"
              />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-subtle">
              {atMaxLevel
                ? 'Maximum level reached'
                : `${Math.max(0, next - xp).toLocaleString()} XP to level ${level + 1}`}
            </p>
            <div className="mt-6 border-t border-border pt-5">
              <p className="mb-3 text-sm text-muted">Your primary discipline</p>
              <Link
                href={`/train/${preferred.id}/setup`}
                className="flex items-center justify-between gap-3 text-base font-semibold transition hover:text-primary"
              >
                <span className="flex items-center gap-3">
                  <preferred.icon size={19} className="text-primary" />
                  {preferred.title}
                </span>
                <ChevronRight size={17} className="text-subtle" />
              </Link>
            </div>
          </section>

          <section className="glass-card !rounded-[28px] p-6 sm:p-7">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold tracking-tight">
                Achievements
              </h2>
              <Trophy size={19} className="text-primary" />
            </div>
            <div className="mb-5 grid grid-cols-4 gap-2">
              {badges.slice(0, 4).map((badge) => (
                <div
                  key={badge.id}
                  title={`${badge.title} · ${badge.unlocked ? 'Unlocked' : 'Locked'}`}
                  className={`flex h-14 items-center justify-center rounded-[18px] border ${badge.unlocked ? 'border-primary/20 bg-primary/[.07] text-primary' : 'border-border bg-surface-inset text-subtle/60'}`}
                >
                  <badge.icon size={24} strokeWidth={1.5} />
                </div>
              ))}
            </div>
            <p className="mb-5 text-sm text-muted">
              {badges.filter((badge) => badge.unlocked).length} of{' '}
              {badges.length} milestones reached
            </p>
            <button
              onClick={() => setBadgesOpen(true)}
              className="flex w-full items-center justify-between gap-2 text-sm font-medium text-primary transition hover:text-secondary"
            >
              View all achievements <ArrowRight size={16} />
            </button>
          </section>

          <section className="glass-card !rounded-[28px] p-6 sm:col-span-2 sm:p-7 lg:col-span-1">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-base font-semibold tracking-tight">
                Training circles
              </h2>
              <Users size={20} className="text-primary" />
            </div>
            {circles.length ? (
              <div className="mb-5 space-y-3">
                {circles.slice(0, 2).map(({ circle }) => (
                  <Link
                    href={`/circle/${circle.id}`}
                    key={circle.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface-inset/60 px-4 py-4 transition hover:border-primary/30"
                  >
                    <span className="truncate text-sm font-medium">
                      {circle.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-primary">
                      <Flame size={13} />
                      {circle.shared_streak}d
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <>
                <span
                  aria-hidden="true"
                  className="clay-icon mb-5 flex h-14 w-14 items-center justify-center !rounded-[20px]"
                >
                  <Users size={25} strokeWidth={1.5} />
                </span>
                <p className="mb-6 text-sm leading-[1.75] text-muted">
                  A shared routine goes further. Build a training streak with
                  your team.
                </p>
              </>
            )}
            <Link
              href="/circles"
              className="flex items-center justify-between gap-2 text-sm font-medium text-primary hover:text-secondary"
            >
              {circles.length ? 'View your circles' : 'Find your circle'}
              <ArrowUpRight size={16} />
            </Link>
          </section>
        </aside>
      </div>

      <section aria-labelledby="history-title" className="mt-10 sm:mt-12">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2
              id="history-title"
              className="text-2xl font-semibold tracking-[-.035em] sm:text-[28px]"
            >
              Recent sessions
            </h2>
            <p className="mt-2 text-sm text-muted">
              Review your technique and see how far you’ve come.
            </p>
          </div>
          <span className="flex items-center gap-2 text-sm text-subtle">
            <Clock size={16} />
            {recentMinutes} minutes in recent sessions
          </span>
        </div>
        <div className="glass-card overflow-hidden !rounded-[28px]">
          {sessions.length ? (
            <>
              <div className="hidden grid-cols-[1fr_130px_130px_85px_20px] gap-5 border-b border-border px-7 py-5 text-sm font-medium text-muted md:grid">
                <span>Discipline</span>
                <span>Duration</span>
                <span>Form score</span>
                <span>XP earned</span>
                <span />
              </div>
              {sessions.slice(0, 5).map((session) => {
                const discipline = [...SPORTS, ...LEGACY_SPORTS].find(
                  (sport) => sport.id === session.sport,
                );
                const Icon = discipline?.icon || Activity;
                const date = new Date(session.created_at);
                return (
                  <Link
                    key={session.id}
                    href={`/results/${session.id}`}
                    className="grid grid-cols-[1fr_auto_16px] items-center gap-3 border-b border-border px-5 py-5 transition last:border-0 hover:bg-primary/[.035] md:grid-cols-[1fr_130px_130px_85px_20px] sm:gap-5 sm:px-7 sm:py-6"
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-raised text-primary">
                        <Icon size={20} strokeWidth={1.5} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold capitalize sm:text-base">
                          {session.movement_name || session.sport}
                        </p>
                        <p className="mt-1.5 text-xs text-subtle sm:text-sm">
                          {Number.isNaN(date.getTime())
                            ? 'Recent session'
                            : date.toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                              })}
                        </p>
                      </div>
                    </div>
                    <span className="hidden text-base tabular-nums text-muted md:block">
                      {Math.round(session.duration_s / 60)} min
                    </span>
                    <span className="text-xl font-semibold tabular-nums">
                      {session.score === null ? <span className="text-sm text-muted">Not scored</span> : Math.round(session.score)}
                      {session.score !== null && <span className="ml-1 text-xs font-normal text-subtle">
                        /100
                      </span>}
                    </span>
                    <span className="hidden text-sm font-medium tabular-nums text-primary md:block">
                      +{session.xp_earned}
                    </span>
                    <ChevronRight size={17} className="text-subtle" />
                  </Link>
                );
              })}
            </>
          ) : (
            <div className="px-6 py-14 text-center">
              <span className="clay-icon mx-auto mb-6 flex h-16 w-16 items-center justify-center !rounded-[22px]">
                <Activity size={28} strokeWidth={1.5} />
              </span>
              <p className="text-xl font-semibold tracking-tight">
                No sessions recorded yet.
              </p>
              <p className="mx-auto mt-3 max-w-md text-sm leading-[1.75] text-muted">
                Choose a sport to start training. Your completed sessions and
                form scores will appear here.
              </p>
              <Link
                href="/sports"
                className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary"
              >
                Explore disciplines <ArrowRight size={16} />
              </Link>
            </div>
          )}
        </div>
      </section>
      <BadgesModal
        isOpen={badgesOpen}
        onClose={() => setBadgesOpen(false)}
        badges={badges}
      />
    </AppShell>
  );
}
