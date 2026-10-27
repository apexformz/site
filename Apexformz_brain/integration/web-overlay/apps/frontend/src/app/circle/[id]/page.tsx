'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Users,
  Flame,
  ShieldAlert,
  Award,
  Copy,
  Check,
  Activity,
  ArrowUpRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import { AppShell } from '@/components/AppShell';
import { LoadingScreen } from '@/components/ui/LoadingScreen';

export default function CircleDetailsPage() {
  const params = useParams<{ id: string }>();
  const [circle, setCircle] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const timeout = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const fetchCircle = async () => {
      try {
        const res = await api.get(`/circles/${params.id}`);
        setCircle(res.data.data);
      } catch (err: any) {
        setError(
          err.response?.data?.error ||
            'We could not load your circle. Please try again.',
        );
      } finally {
        setIsLoading(false);
      }
    };
    fetchCircle();
    return () => clearTimeout(timeout.current);
  }, [params.id]);
  const handleCopy = async () => {
    if (!circle?.id) return;
    try {
      await navigator.clipboard.writeText(circle.id);
      setCopyStatus('Invite code copied');
    } catch {
      setCopyStatus(
        'Could not copy automatically. Select and copy the code below.',
      );
    }
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setCopyStatus(''), 4000);
  };
  if (isLoading) return <LoadingScreen label="Loading your training circle" />;
  if (error || !circle)
    return (
      <AppShell active="circle" title="Training circle">
        <div className="glass-card max-w-lg mx-auto p-8 sm:p-10 text-center">
          <span className="clay-icon w-16 h-16 rounded-2xl mx-auto mb-6">
            <ShieldAlert size={28} />
          </span>
          <h1 className="display-title text-3xl mb-4">Circle unavailable</h1>
          <p className="text-base text-muted leading-relaxed">
            {error || 'This circle could not be found.'}
          </p>
          <Link
            href="/circles"
            className="btn-primary inline-flex mt-8 text-base"
          >
            Back to circles
          </Link>
        </div>
      </AppShell>
    );
  const sortedMembers = [...(circle.members || [])].sort((a, b) => {
    if (a.role === 'anchor_user') return -1;
    if (b.role === 'anchor_user') return 1;
    return (
      (b.user.enhanced_streak?.current_streak || 0) -
      (a.user.enhanced_streak?.current_streak || 0)
    );
  });
  const leader = sortedMembers.find(
    (member: any) => member.role === 'anchor_user',
  )?.user?.name;
  const health = Math.max(0, Math.min(100, Number(circle.circle_health) || 0));
  return (
    <AppShell active="circle" title="Training circle">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/circles"
          className="inline-flex items-center gap-2 text-sm text-muted hover:text-primary transition-colors mb-8"
        >
          <ArrowLeft size={17} /> All training circles
        </Link>
        <div className="flex flex-wrap justify-between items-end gap-6 mb-9">
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary mb-3">
              Your training circle
            </p>
            <h1 className="display-title text-3xl sm:text-4xl [overflow-wrap:anywhere]">
              {circle.name}
            </h1>
            <p className="text-base text-muted mt-4 leading-relaxed max-w-lg">
              A place for your training team. See who’s here, follow individual
              streaks, and invite someone to join you.
            </p>
          </div>
          <Link
            href="/sports"
            className="btn-primary inline-flex items-center gap-3 text-base"
          >
            Start a session <ArrowUpRight size={19} />
          </Link>
        </div>
        <section
          className="grid sm:grid-cols-3 gap-5 mb-8"
          aria-label="Circle summary and preview metrics"
        >
          <div className="glass-card p-6 sm:p-7">
            <div className="flex items-center gap-3 text-sm text-muted">
              <span className="clay-icon w-11 h-11 rounded-2xl">
                <Activity size={21} />
              </span>
              Circle health · Preview
            </div>
            <p className="text-4xl font-semibold tracking-tight mt-6">
              {Math.round(health)}
              <span className="text-lg text-subtle ml-1">%</span>
            </p>
            <p className="text-sm text-muted mt-3">Saved preview value</p>
          </div>
          <div className="glass-card p-6 sm:p-7">
            <div className="flex items-center gap-3 text-sm text-muted">
              <span className="clay-icon w-11 h-11 rounded-2xl">
                <Flame size={21} />
              </span>
              Shared streak · Preview
            </div>
            <p className="text-4xl font-semibold tracking-tight mt-6">
              {circle.shared_streak || 0}
              <span className="text-base font-normal text-subtle ml-2">
                days
              </span>
            </p>
            <p className="text-sm text-muted mt-3">
              Session updates are not active yet
            </p>
          </div>
          <div className="glass-card p-6 sm:p-7">
            <div className="flex items-center gap-3 text-sm text-muted">
              <span className="clay-icon w-11 h-11 rounded-2xl">
                <Users size={21} />
              </span>
              Athletes
            </div>
            <p className="text-4xl font-semibold tracking-tight mt-6">
              {sortedMembers.length}
            </p>
            <p className="text-sm text-muted mt-3 truncate">
              {leader ? `Led by ${leader}` : 'Your training team'}
            </p>
          </div>
        </section>
        <div className="rounded-[24px] border border-primary/15 bg-primary/[.035] p-6 mb-8">
          <p className="text-base text-muted leading-relaxed">
            <strong className="font-semibold text-foreground">
              Shared metrics are in preview.
            </strong>{' '}
            Circle health and shared streak do not currently update from your
            sessions. Member streaks below come from each athlete’s own training
            record.
          </p>
        </div>
        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-7">
          <section className="glass-card p-6 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-6 border-b border-border">
              <h2 className="text-xl font-semibold">Your team</h2>
              <span className="text-sm px-3 py-1.5 rounded-full bg-primary/[.06] text-primary">
                {sortedMembers.length} members
              </span>
            </div>
            <div className="divide-y divide-border">
              {sortedMembers.map((member: any) => {
                const u = member.user;
                const streak = u.enhanced_streak || {};
                const isAnchor = member.role === 'anchor_user';
                return (
                  <div
                    key={member.id}
                    className="flex items-center gap-3 sm:gap-4 py-6"
                  >
                    <div className="relative shrink-0">
                      {u.avatar_url ? (
                        <img
                          src={u.avatar_url}
                          alt=""
                          className="w-12 h-12 rounded-2xl object-cover"
                        />
                      ) : (
                        <div className="clay-icon w-12 h-12 rounded-2xl font-semibold text-lg">
                          {u.name?.charAt(0).toUpperCase()}
                        </div>
                      )}
                      {isAnchor && (
                        <span
                          title="Circle leader"
                          className="absolute -bottom-1 -right-1 bg-surface-raised text-primary p-1 rounded-lg border border-border"
                        >
                          <Award size={13} />
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-semibold truncate">
                        {u.name}
                      </p>
                      <p className="text-sm text-muted mt-1 capitalize">
                        {isAnchor
                          ? 'Circle leader'
                          : `${streak.identity_tier || 'Novice'} athlete`}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xl font-semibold flex gap-1.5 items-center justify-end">
                        <Flame size={16} className="text-primary" />
                        {streak.current_streak || 0}
                      </p>
                      <p className="text-sm text-subtle mt-1">days</p>
                    </div>
                  </div>
                );
              })}
            </div>
            {sortedMembers.length === 0 && (
              <p className="py-12 text-base text-center text-muted leading-relaxed">
                Share your invite code to add the first athlete.
              </p>
            )}
          </section>
          <div className="space-y-7">
            <section className="glass-card p-6 sm:p-8">
              <h2 className="text-xl font-semibold mb-5">
                Your own pace. Your people.
              </h2>
              <p className="text-base leading-relaxed text-muted">
                Train the techniques that fit your goals, and use this roster to
                stay connected with the people doing the same.
              </p>
              <div className="mt-6 pt-5 border-t border-border">
                <h3 className="text-base font-semibold">
                  About member streaks
                </h3>
                <p className="text-sm leading-relaxed text-muted mt-3">
                  These are individual qualifying training days, not a team
                  score. Sessions must meet the duration and score requirements
                  for the selected sport.
                </p>
                <Link
                  href="/profile"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-primary mt-4"
                >
                  How your streak works <ArrowUpRight size={16} />
                </Link>
              </div>
            </section>
            <section className="glass-card p-6 sm:p-8">
              <h2 className="text-xl font-semibold">Room for one more?</h2>
              <p className="text-sm text-muted leading-relaxed mt-4 mb-6">
                Share this code with a teammate. They can enter it under “Join a
                circle” to connect.
              </p>
              <div className="flex items-center gap-3 bg-surface-inset border border-border p-3.5 rounded-2xl">
                <code className="flex-1 min-w-0 break-all text-sm text-foreground select-all">
                  {circle.id}
                </code>
                <button
                  onClick={handleCopy}
                  aria-label="Copy circle invite code"
                  className="p-3 shrink-0 rounded-xl bg-surface-raised border border-border hover:bg-primary/5 text-primary transition-colors"
                >
                  {copyStatus === 'Invite code copied' ? (
                    <Check size={18} />
                  ) : (
                    <Copy size={18} />
                  )}
                </button>
              </div>
              <p
                aria-live="polite"
                className="text-sm text-primary min-h-5 mt-3"
              >
                {copyStatus}
              </p>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
