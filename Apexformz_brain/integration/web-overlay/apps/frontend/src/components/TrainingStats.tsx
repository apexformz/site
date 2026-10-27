'use client';
import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Activity, Radio, Timer, Zap, Target } from 'lucide-react';

interface TrainingStatsProps {
  score: number | null;
  duration: number;
  frameCount: number;
  isConnected: boolean;
  connectionError?: string | null;
  repCount?: number;
  repLabel?: string;
  /** False means the Brain has withheld a technique score. */
  scoreAvailable?: boolean;
  scoreLabel?: string;
  /** Camera overlays use a compact layout; legacy pages keep the metric cards. */
  compact?: boolean;
}
export function TrainingStats({
  score,
  duration,
  frameCount,
  isConnected,
  connectionError,
  repCount,
  repLabel = 'Reps',
  scoreAvailable,
  scoreLabel = 'Form score',
  compact = scoreAvailable !== undefined,
}: TrainingStatsProps) {
  const reduceMotion = useReducedMotion();
  const hasScore = scoreAvailable !== false && score !== null && Number.isFinite(score);
  const safeScore = hasScore ? Math.max(0, Math.min(100, score!)) : 0;
  const time = `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}`;
  if (compact) {
    return (
      <div className="w-[196px] max-w-full rounded-[20px] border border-white/15 bg-black/65 p-3 text-white backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="relative h-16 w-16 shrink-0" aria-label={hasScore ? `${scoreLabel} ${Math.round(safeScore)} out of 100` : 'Technique not scored'}>
            <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90" aria-hidden="true">
              <circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="4" className="text-white/15" />
              <motion.circle cx="32" cy="32" r="28" fill="none" stroke="currentColor" strokeWidth="4" strokeDasharray={176} initial={false} animate={{ strokeDashoffset: 176 - 176 * safeScore / 100 }} transition={{ duration: reduceMotion ? 0 : 0.3 }} className="text-primary" />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-xl font-semibold tabular-nums">{hasScore ? Math.round(safeScore) : '—'}</span>
          </div>
          <div>
            <p className="text-xs font-medium text-white/85">{hasScore ? scoreLabel : 'Not scored'}</p>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-white/60">
              <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-300' : 'bg-amber-300'}`} />
              {isConnected ? 'Brain ready' : 'Brain unavailable'}
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/15 pt-3 text-center">
          {[[time, 'Time'], [repCount ?? 0, repLabel], [frameCount, 'Frames']].map(([value, label]) => (
            <div key={label}>
              <p className="text-sm font-medium tabular-nums">{value}</p>
              <p className="mt-0.5 text-[10px] text-white/55">{label}</p>
            </div>
          ))}
        </div>
        {!isConnected && connectionError && <p role="status" className="mt-2 text-[11px] leading-relaxed text-amber-200">{connectionError}</p>}
      </div>
    );
  }
  const metrics = [
    {
      label: hasScore ? scoreLabel : 'Not scored',
      value: hasScore ? Math.round(safeScore) : '—',
      suffix: hasScore ? '/100' : undefined,
      icon: Target,
      primary: true,
    },
    {
      label: 'Session time',
      value: time,
      icon: Timer,
    },
    { label: repLabel, value: repCount || 0, icon: Activity },
    { label: 'Frames analysed', value: frameCount, icon: Zap },
  ];
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {metrics.map(({ label, value, suffix, icon: Icon, primary }) => (
          <div
            key={label}
            className="glass-card relative px-4 sm:px-5 py-5 sm:py-6 overflow-hidden"
            style={{ borderRadius: 24 }}
          >
            <div
              className={`w-10 h-10 rounded-[15px] flex items-center justify-center mb-4 ${primary ? 'bg-primary/10 text-primary' : 'bg-surface-inset text-muted'}`}
            >
              <Icon className="w-5 h-5" />
            </div>
            <p className="text-sm text-muted mb-2">{label}</p>
            <p
              className={`text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums ${primary ? 'text-primary' : 'text-foreground'}`}
            >
              {value}
              {suffix && (
                <span className="text-sm text-subtle ml-1 font-normal">
                  {suffix}
                </span>
              )}
            </p>
            {primary && (
              <div className="absolute bottom-0 inset-x-0 h-[3px] bg-primary/5">
                <motion.div
                  initial={false}
                  animate={{ width: `${safeScore}%` }}
                  transition={{ duration: reduceMotion ? 0 : 0.3 }}
                  className="h-full bg-primary/70"
                />
              </div>
            )}
          </div>
        ))}
      </div>
      {!isConnected && connectionError && (
        <div
          className="mt-4 rounded-[22px] border border-border bg-surface px-5 py-4 text-sm text-muted flex flex-wrap items-center justify-between gap-3"
          role="status"
        >
          <span className="flex items-center gap-2.5">
            <Radio className="w-4 h-4 text-accent-warning shrink-0" />
            {connectionError}
          </span>
          <button
            onClick={() => window.location.reload()}
            className="text-primary underline underline-offset-4"
          >
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}
