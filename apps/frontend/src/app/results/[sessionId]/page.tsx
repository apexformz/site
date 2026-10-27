'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock,
  Focus,
  Lightbulb,
  RotateCcw,
  Share2,
  Sparkles,
  Target,
  TrendingUp,
  Trophy,
  Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { TrainingSession, PoseFrame } from '@smartcoach/types';
import { Brand } from '@/components/ui/Brand';
import { ThemeToggle } from '@/components/ui/ThemeProvider';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { getBrainSession, type StoredBrainSession } from '@/lib/brain/session';
import { BrainSessionResults } from '@/components/BrainSessionResults';

export default function ResultsPage() {
  const { sessionId } = useParams();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [frames, setFrames] = useState<PoseFrame[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState('');
  const [shareError, setShareError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [brainSession, setBrainSession] = useState<StoredBrainSession | null>(null);

  useEffect(() => {
    let active = true;
    async function loadSession() {
      setIsLoading(true);
      setError('');
      setBrainSession(null);
      try {
        const brain = await getBrainSession(String(sessionId));
        if (brain) {
          if (active) setBrainSession(brain);
          return;
        }
        const { data } = await api.get(`/sessions/${sessionId}`);
        if (!data.data) throw new Error('Session not found');
        if (active) {
          setSession(data.data);
          setFrames(data.data.frames || []);
        }
      } catch (err) {
        if (active)
          setError(
            'We could not load this session. Check your connection and try again.',
          );
      } finally {
        if (active) setIsLoading(false);
      }
    }
    loadSession();
    return () => {
      active = false;
    };
  }, [sessionId, attempt]);

  const handleShare = async () => {
    if (!session) return;
    setShareError('');
    const shareText = `My Apexformz session\n\nSport: ${session.sport}\nForm score: ${Math.round(session.score)}/100\nXP earned: +${session.xp_earned}\nDuration: ${Math.floor(session.duration_s / 60)}:${(session.duration_s % 60).toString().padStart(2, '0')}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'My Apexformz training session',
          text: shareText,
          url: window.location.href,
        });
      } else {
        await navigator.clipboard.writeText(
          `${shareText}\n\n${window.location.href}`,
        );
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 3000);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        setShareError(
          'Sharing is unavailable in this browser. You can copy the page address to keep your session link.',
        );
    }
  };

  if (isLoading) return <LoadingScreen label="Loading session analysis" />;
  if (brainSession) return <BrainSessionResults key={brainSession.session_id} initialSession={brainSession} />;
  if (error || !session)
    return (
      <main className="min-h-screen bg-background text-foreground p-6 flex items-center justify-center">
        <div className="absolute top-5 right-5">
          <ThemeToggle />
        </div>
        <section className="glass-card max-w-lg p-8 sm:p-12 text-center">
          <Focus className="w-10 h-10 text-primary mx-auto mb-6" />
          <h1 className="text-2xl font-semibold tracking-tight mb-3">
            Session analysis unavailable
          </h1>
          <p role="alert" className="text-base text-muted leading-relaxed mb-8">
            {error || 'This session is unavailable.'}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              onClick={() => setAttempt((value) => value + 1)}
              className="btn-primary flex items-center gap-2 text-sm"
            >
              <RotateCcw className="w-4 h-4" />
              Try again
            </button>
            <Link href="/dashboard" className="btn-secondary text-sm">
              Back to overview
            </Link>
          </div>
        </section>
      </main>
    );

  const score = Math.max(0, Math.min(100, session.score));
  const duration = `${Math.floor(session.duration_s / 60)}:${(session.duration_s % 60).toString().padStart(2, '0')}`;
  const consistency = frames.length
    ? Math.round(
        (frames.filter((frame) => frame.frame_score >= 70).length /
          frames.length) *
          100,
      )
    : null;
  const parts = (session.feedback_summary || '').split(
    'Detailed Form Analysis:',
  );
  const summary = parts[0]
    .replace('Technical Summary:', '')
    .split('\n')
    .filter((line) => line.trim());
  const detailed =
    parts.length > 1 ? parts[1].split('\n').filter((line) => line.trim()) : [];
  const formLevel =
    score >= 85
      ? 'Excellent'
      : score >= 70
        ? 'Strong'
        : score >= 50
          ? 'Developing'
          : 'Needs refinement';
  const sessionDate = new Date(session.created_at);
  const dateLabel = Number.isNaN(sessionDate.getTime())
    ? ''
    : sessionDate.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

  const renderFeedback = (line: string, index: number) => {
    const positive = line.includes('✅');
    const correction = line.includes('💡');
    const warning = line.includes('❌');
    const Icon = positive
      ? CheckCircle2
      : correction
        ? Lightbulb
        : warning
          ? Focus
          : Target;
    return (
      <div
        key={`${index}-${line}`}
        className="flex items-start gap-4 py-5 border-b border-border last:border-b-0"
      >
        <div
          className={`w-11 h-11 rounded-[17px] flex items-center justify-center shrink-0 ${positive ? 'bg-secondary/10 text-secondary' : correction ? 'bg-primary/10 text-primary' : warning ? 'bg-accent-warning/10 text-accent-warning' : 'bg-surface-inset text-primary'}`}
        >
          <Icon className="w-5 h-5" />
        </div>
        <p className="text-base text-muted leading-relaxed pt-1.5">
          {line
            .replace(/[✅❌💡]/g, '')
            .replace('•', '')
            .trim()}
        </p>
      </div>
    );
  };

  return (
    <div className="min-h-screen text-foreground bg-background pb-16">
      <header className="border-b border-border bg-surface/75 backdrop-blur-xl">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-8 py-5 flex items-center justify-between gap-3">
          <div className="sm:hidden">
            <Brand compact />
          </div>
          <div className="hidden sm:block">
            <Brand />
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/dashboard"
              aria-label="Back to overview"
              className="text-sm text-muted hover:text-foreground hover:bg-surface-raised rounded-2xl p-3 sm:px-4 flex items-center gap-2"
            >
              <ArrowLeft className="w-5 h-5" />
              <span className="hidden sm:inline">Back to overview</span>
            </Link>
          </div>
        </div>
      </header>
      <main className="max-w-[1280px] mx-auto px-5 sm:px-8 pt-10 sm:pt-12">
        <div className="flex flex-wrap items-end justify-between gap-6 mb-10">
          <div>
            <p className="text-base text-primary font-medium flex items-center gap-2.5 mb-3">
              <CheckCircle2 className="w-5 h-5" /> Training complete
            </p>
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-[-0.04em]">
              Session analysis
            </h1>
            <p className="text-base text-muted mt-4">
              <span className="capitalize">{session.sport}</span>
              {dateLabel && (
                <span>
                  <span className="mx-3 text-subtle">·</span>
                  {dateLabel}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={handleShare}
            className="btn-secondary flex items-center gap-3 text-base px-5 py-3.5"
          >
            {isCopied ? (
              <Check className="w-5 h-5 text-primary" />
            ) : (
              <Share2 className="w-5 h-5" />
            )}
            {isCopied ? 'Copied to clipboard' : 'Share session'}
          </button>
        </div>
        {shareError && (
          <p role="status" className="text-sm text-accent-warning mb-6">
            {shareError}
          </p>
        )}
        <motion.section
          initial={{ opacity: 0, y: reduceMotion ? 0 : 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="glass-card overflow-hidden mb-8"
          style={{ borderRadius: 28 }}
        >
          <div className="grid md:grid-cols-[320px_1fr]">
            <div className="relative bg-gradient-to-br from-primary/[0.065] via-transparent to-secondary/[0.04] px-7 py-9 sm:py-10">
              <div className="relative w-52 h-52 sm:w-56 sm:h-56 mx-auto flex flex-col items-center justify-center">
                <svg
                  viewBox="0 0 224 224"
                  className="absolute inset-0 w-full h-full -rotate-90"
                  aria-hidden="true"
                >
                  <circle
                    cx="112"
                    cy="112"
                    r="102"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="7"
                    className="text-primary/10"
                  />
                  <motion.circle
                    cx="112"
                    cy="112"
                    r="102"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="7"
                    strokeLinecap="round"
                    strokeDasharray={640.89}
                    initial={{ strokeDashoffset: 640.89 }}
                    animate={{ strokeDashoffset: 640.89 * (1 - score / 100) }}
                    transition={{
                      duration: reduceMotion ? 0 : 1.1,
                      ease: 'easeOut',
                    }}
                    className="text-primary"
                  />
                </svg>
                <span className="text-sm text-muted mb-2">Form score</span>
                <span className="text-7xl font-semibold tracking-[-0.05em] tabular-nums">
                  {Math.round(score)}
                </span>
                <span className="text-sm text-subtle mt-2">out of 100</span>
              </div>
              <div className="flex justify-center mt-6">
                <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
                  <TrendingUp className="w-4 h-4" />
                  {formLevel}
                </span>
              </div>
            </div>
            <div className="p-7 sm:p-9 flex flex-col justify-center">
              <h2 className="text-2xl font-semibold tracking-tight mb-6">
                Your session at a glance
              </h2>
              <div className="grid lg:grid-cols-3 gap-4 lg:gap-6">
                {[
                  { icon: Clock, label: 'Duration', value: duration },
                  {
                    icon: Zap,
                    label: 'XP earned',
                    value: `+${session.xp_earned}`,
                  },
                  {
                    icon: Target,
                    label: 'Consistency',
                    value: consistency === null ? '—' : `${consistency}%`,
                  },
                ].map(({ icon: Icon, label, value }) => (
                  <div
                    key={label}
                    className="flex lg:flex-col items-center lg:items-start justify-between lg:justify-start gap-4 rounded-[22px] bg-surface-inset p-4 sm:p-5"
                  >
                    <div className="flex lg:flex-col items-center lg:items-start gap-3">
                      <Icon className="w-5 h-5 text-primary" />
                      <p className="text-sm text-muted">{label}</p>
                    </div>
                    <p className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums">
                      {value}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-sm text-muted leading-relaxed mt-6">
                {frames.length
                  ? `Based on ${frames.length.toLocaleString()} analysed frames from your session.`
                  : 'Frame-level details were not available for this session.'}
              </p>
            </div>
          </div>
        </motion.section>
        <div className="grid lg:grid-cols-[1.55fr_1fr] gap-7 items-start">
          <div className="space-y-7">
            <section className="glass-card p-6 sm:p-8">
              <div className="flex items-center gap-3 mb-3">
                <Target className="w-6 h-6 text-primary" />
                <h2 className="text-2xl font-semibold tracking-tight">
                  Technical summary
                </h2>
              </div>
              {summary.length > 0 ? (
                summary.map(renderFeedback)
              ) : (
                <p className="text-base text-muted leading-relaxed py-5">
                  No summary was captured. Keep your full body in frame and the
                  coach connected during your next session.
                </p>
              )}
            </section>
            {detailed.length > 0 && (
              <section className="glass-card p-6 sm:p-8">
                <div className="flex items-center gap-3 mb-3">
                  <Focus className="w-6 h-6 text-primary" />
                  <h2 className="text-2xl font-semibold tracking-tight">
                    Form corrections
                  </h2>
                </div>
                {detailed.map(renderFeedback)}
              </section>
            )}
          </div>
          <aside className="space-y-7">
            <section className="glass-card p-6 sm:p-8">
              <div className="clay-icon w-14 h-14 mb-6">
                <Target className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-semibold mb-5">
                Consistency breakdown
              </h2>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-5">
                <span className="text-4xl font-semibold tabular-nums">
                  {consistency === null ? '—' : `${consistency}%`}
                </span>
                <span className="text-sm text-muted">of frames scored 70+</span>
              </div>
              <div className="h-2.5 bg-surface-inset rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${consistency || 0}%` }}
                  transition={{ duration: reduceMotion ? 0 : 0.7 }}
                  className="h-full rounded-full bg-primary"
                />
              </div>
              <p className="text-sm text-muted leading-relaxed mt-5">
                {consistency === null
                  ? 'Frame-level data was not available for this session.'
                  : 'This measures how often you held a form score of 70 or higher during your session.'}
              </p>
            </section>
            <section className="glass-card p-6 sm:p-8">
              <p className="text-primary text-sm font-medium mb-3">
                Your next session
              </p>
              <h2 className="text-2xl font-semibold tracking-tight">
                Put your feedback into practice.
              </h2>
              <p className="text-base text-muted leading-relaxed mt-4 mb-7">
                Review your corrections, then repeat the movement with a clear
                focus.
              </p>
              <button
                onClick={() => router.push(`/train/${session.sport}/setup`)}
                className="btn-primary w-full flex items-center justify-between text-base py-4"
              >
                Train again <ArrowUpRight className="w-5 h-5" />
              </button>
              <Link
                href="/dashboard"
                className="flex justify-center text-sm text-muted hover:text-foreground mt-5 py-1"
              >
                Return to overview
              </Link>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
