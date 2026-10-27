'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  Flame,
  HeartPulse,
  Plus,
  RotateCcw,
  Users,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { CircleModal } from '@/components/CircleModal';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { useAthleteData } from '@/hooks/useAthleteData';

export default function CirclesPage() {
  const { user, loading, error, refresh } = useAthleteData(false);
  const [modalOpen, setModalOpen] = useState(false);
  if (loading) return <LoadingScreen label="Loading your training circles" />;
  const memberships = user?.circle_members || [];
  const highestStreak = Math.max(
    0,
    ...memberships.map(({ circle }) => circle.shared_streak || 0),
  );
  const meanHealth = memberships.length
    ? Math.round(
        memberships.reduce(
          (total, { circle }) =>
            total + Math.min(100, Math.max(0, circle.circle_health || 0)),
          0,
        ) / memberships.length,
      )
    : 0;

  return (
    <AppShell userName={user?.name} active="circle" title="Training circles">
      <div className="mb-10 flex flex-wrap items-end justify-between gap-6 sm:mb-12">
        <div>
          <p className="mb-3 text-sm font-medium text-primary">
            A shared commitment
          </p>
          <h1 className="display-title text-[34px] leading-[1.15] tracking-[-.045em] sm:text-[46px]">
            Your training circles.
          </h1>
          <p className="mt-4 max-w-lg text-base leading-[1.75] text-muted">
            Bring your training team together. Find your people, share an
            invite, and follow their individual streaks.
          </p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="btn-primary !px-6 !py-4"
        >
          <Plus size={18} />
          Join or create a circle
        </button>
      </div>

      {error ? (
        <section className="glass-card mx-auto max-w-lg p-8 text-center sm:p-10">
          <Users size={30} className="mx-auto mb-6 text-primary" />
          <h2 className="text-2xl font-semibold tracking-tight">
            Your circles are unavailable.
          </h2>
          <p role="alert" className="my-5 text-base leading-relaxed text-muted">
            {error}
          </p>
          <button onClick={() => void refresh()} className="btn-primary">
            <RotateCcw size={17} />
            Try again
          </button>
        </section>
      ) : memberships.length ? (
        <>
          <div className="rounded-[24px] border border-primary/15 bg-primary/[.035] p-6 mb-7">
            <p className="text-base leading-relaxed text-muted">
              <strong className="font-semibold text-foreground">
                A note on shared metrics.
              </strong>{' '}
              Circle health and shared streak are preview values. They do not
              currently update from completed sessions. Open a circle to see its
              members and their individual training streaks.
            </p>
          </div>
          <section
            aria-label="Circle statistics and preview metrics"
            className="mb-9 grid gap-4 sm:grid-cols-3 sm:gap-5"
          >
            {[
              {
                label: 'Your circles',
                value: memberships.length,
                unit: 'teams',
                icon: Users,
              },
              {
                label: 'Shared streak · Preview',
                value: highestStreak,
                unit: 'days',
                icon: Flame,
              },
              {
                label: 'Circle health · Preview',
                value: meanHealth,
                unit: '%',
                icon: HeartPulse,
              },
            ].map(({ label, value, unit, icon: Icon }) => (
              <div
                className="glass-card !rounded-[28px] p-6 sm:p-7"
                key={label}
              >
                <div className="mb-6 flex items-center justify-between gap-3 text-sm font-medium text-muted">
                  <span>{label}</span>
                  <Icon
                    size={20}
                    strokeWidth={1.6}
                    className="shrink-0 text-primary"
                  />
                </div>
                <p className="text-[42px] font-semibold leading-none tracking-[-.055em] tabular-nums">
                  {value}
                  <span className="ml-3 text-sm font-normal tracking-normal text-subtle">
                    {unit}
                  </span>
                </p>
              </div>
            ))}
          </section>
          <div className="grid gap-5 md:grid-cols-2 xl:gap-6">
            {memberships.map(({ circle, role }) => {
              const health = Math.min(
                100,
                Math.max(0, circle.circle_health || 0),
              );
              return (
                <Link
                  href={`/circle/${circle.id}`}
                  key={circle.id}
                  className="glass-card group relative overflow-hidden !rounded-[28px] p-6 transition duration-300 hover:-translate-y-1 hover:border-primary/30 sm:p-8"
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-16 -top-16 h-52 w-52 rounded-full bg-primary/[.035] blur-2xl"
                  />
                  <div className="relative mb-7 flex items-center justify-between gap-4">
                    <span className="clay-icon flex h-16 w-16 items-center justify-center !rounded-[22px]">
                      <Users size={29} strokeWidth={1.5} />
                    </span>
                    <span className="rounded-full border border-border bg-surface/60 px-3.5 py-2 text-sm font-medium text-muted">
                      {role === 'anchor_user' ? 'Circle leader' : 'Member'}
                    </span>
                  </div>
                  <h2 className="relative mb-3 break-words text-2xl font-semibold tracking-[-.035em]">
                    {circle.name}
                  </h2>
                  <p className="relative flex items-center gap-2 text-sm text-primary">
                    <Flame size={16} />
                    {circle.shared_streak || 0} day shared streak · Preview
                  </p>
                  <div className="relative mb-3 mt-8 flex items-center justify-between text-sm text-muted">
                    <span>Circle health · Preview</span>
                    <span className="font-semibold text-foreground">
                      {Math.round(health)}%
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={`${circle.name} preview health`}
                    aria-valuenow={health}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="relative h-2 overflow-hidden rounded-full bg-surface-inset"
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${health}%` }}
                    />
                  </div>
                  <div className="relative mt-7 flex items-center justify-between border-t border-border pt-6 text-sm font-medium text-muted transition group-hover:text-primary">
                    <span>Open circle</span>
                    <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-raised text-primary">
                      <ArrowUpRight size={17} />
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      ) : (
        <section className="glass-card relative overflow-hidden !rounded-[32px] px-6 py-12 sm:py-16">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-0 h-96 w-96 -translate-x-1/2 rounded-full bg-primary/[.03] blur-3xl"
          />
          <div className="relative mx-auto max-w-xl text-center">
            <div
              aria-hidden="true"
              className="relative mx-auto mb-8 h-40 w-full max-w-[280px]"
            >
              <svg
                viewBox="0 0 280 160"
                className="absolute inset-0 h-full w-full text-primary"
                fill="none"
              >
                <path
                  d="M50 110 140 45 230 110"
                  stroke="currentColor"
                  strokeOpacity=".2"
                  strokeWidth="1.4"
                />
                <path
                  d="M50 110h180"
                  stroke="currentColor"
                  strokeOpacity=".14"
                  strokeWidth="1.4"
                  strokeDasharray="4 6"
                />
                <ellipse
                  cx="140"
                  cy="85"
                  rx="100"
                  ry="64"
                  stroke="currentColor"
                  strokeOpacity=".06"
                />
              </svg>
              <span className="clay-icon absolute bottom-3 left-0 flex h-16 w-16 rotate-[-9deg] items-center justify-center !rounded-[23px] text-muted">
                <Users size={26} strokeWidth={1.5} />
              </span>
              <span className="clay-icon absolute bottom-3 right-0 flex h-16 w-16 rotate-[9deg] items-center justify-center !rounded-[23px] text-muted">
                <Users size={26} strokeWidth={1.5} />
              </span>
              <span
                className="absolute left-1/2 top-0 flex h-[84px] w-[84px] -translate-x-1/2 items-center justify-center rounded-[28px] border border-primary/15 bg-primary/[.08] text-primary"
                style={{ boxShadow: 'var(--shadow-card)' }}
              >
                <Users size={34} strokeWidth={1.4} />
              </span>
            </div>
            <h2 className="text-[28px] font-semibold tracking-[-.04em] sm:text-[34px]">
              Build your training team.
            </h2>
            <p className="mx-auto mt-5 max-w-md text-base leading-[1.8] text-muted">
              Create a circle for your teammates or join with an invite code. A
              shared routine makes it easier to keep showing up.
            </p>
            <button
              onClick={() => setModalOpen(true)}
              className="btn-primary mt-8 !px-7 !py-4"
            >
              Find your circle <ArrowRight size={17} />
            </button>
          </div>
        </section>
      )}

      <div className="mt-10 grid gap-7 border-t border-border pt-8 sm:grid-cols-3 sm:gap-8">
        {[
          {
            number: '1',
            title: 'Connect your team',
            text: 'Create a circle and share its invite code, or join a team you know.',
          },
          {
            number: '2',
            title: 'Keep your own routine',
            text: 'Choose your techniques and build your individual training record.',
          },
          {
            number: '3',
            title: 'Know who’s training with you',
            text: 'Open a circle to see its roster and each member’s individual streak.',
          },
        ].map((item) => (
          <div key={item.number}>
            <span className="mb-4 flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-surface-raised text-sm font-medium text-primary">
              {item.number}
            </span>
            <h3 className="text-base font-semibold tracking-tight">
              {item.title}
            </h3>
            <p className="mt-3 text-sm leading-[1.75] text-muted">
              {item.text}
            </p>
          </div>
        ))}
      </div>
      <CircleModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSuccess={() => void refresh()}
      />
    </AppShell>
  );
}
