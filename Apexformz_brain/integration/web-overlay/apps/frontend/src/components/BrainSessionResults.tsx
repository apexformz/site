'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowLeft, ArrowUpRight, CheckCircle2, Clock, RotateCcw, Target } from 'lucide-react';
import { Brand } from '@/components/ui/Brand';
import { ThemeToggle } from '@/components/ui/ThemeProvider';
import { retryBrainSessionSync, type StoredBrainSession } from '@/lib/brain/session';

const readable = (value: string) => value.replace(/_/g, ' ').toLowerCase();
const stateClass: Record<string, string> = {
  PASS: 'text-secondary bg-secondary/10',
  IMPROVE: 'text-accent-warning bg-accent-warning/10',
  UNCERTAIN: 'text-muted bg-surface-inset',
  NOT_ASSESSABLE: 'text-muted bg-surface-inset',
  NOT_APPLICABLE: 'text-subtle bg-surface-inset',
};

export function BrainSessionResults({ initialSession }: { initialSession: StoredBrainSession }) {
  const [session, setSession] = useState(initialSession);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const summary = session.summary;
  const score = summary?.last_score ?? null;
  const duration = session.duration_s ?? Math.max(0, Math.round(((session.ended_at ? Date.parse(session.ended_at) : Date.parse(session.started_at)) - Date.parse(session.started_at)) / 1000));
  const movement = session.movement_name || session.movement_id.split('.').slice(1).join(' ').replace(/_/g, ' ');
  const syncPending = session.completion_sync === 'pending';
  const metrics = [
    { label: 'Form score', value: score === null ? 'Not scored' : `${Math.round(score * 100)}/100`, icon: Target },
    { label: 'Session time', value: `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')}`, icon: Clock },
    { label: 'Movements completed', value: summary?.executions_completed ?? 0, icon: Activity },
    { label: 'Coaching cues', value: summary?.feedback_issued ?? 0, icon: CheckCircle2 },
  ];
  async function retry() {
    setSaving(true);
    setError('');
    try {
      const updated = await retryBrainSessionSync(session);
      setSession(updated);
      if (updated.completion_sync === 'pending') setError('Your result is safe on this device. Saving to your account is still pending; try again when connected.');
    } catch {
      setError('Your result is safe on this device. We could not reach your account; please try again.');
    } finally { setSaving(false); }
  }
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="page-width flex flex-wrap items-center justify-between gap-4 border-b border-border py-5">
        <Brand />
        <div className="flex items-center gap-5"><Link href="/dashboard" className="text-sm text-muted">Training overview</Link><ThemeToggle /></div>
      </header>
      <main className="page-width space-y-8 py-10 sm:py-14">
        <Link href="/sports" className="inline-flex items-center gap-2 text-sm text-muted"><ArrowLeft size={17} /> Sports library</Link>
        <section className="glass-card p-7 sm:p-10">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div>
              <p className="mb-3 text-sm font-medium capitalize text-primary">{session.sport} · Session review</p>
              <h1 className="display-title text-3xl sm:text-4xl">{movement}</h1>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{session.mode === 'development' ? 'Preview coaching was enabled. Any technique scores and cues use provisional criteria.' : 'Reviewed coaching mode. The Brain withholds technique scores when the criteria or visible evidence do not support them.'}</p>
            </div>
            <Link href={`/train/${session.sport}/setup`} className="btn-primary">Train again <ArrowUpRight size={18} /></Link>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {metrics.map(({ label, value, icon: Icon }) => <div key={label} className="rounded-2xl border border-border bg-surface-inset/40 p-5"><Icon size={20} className="mb-4 text-primary" /><p className="text-sm text-muted">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p></div>)}
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm text-muted" role="status">
            <span>{syncPending ? 'Saved on this device · account save pending' : session.backend_backed ? 'Saved to your account' : 'Saved on this device'}{typeof session.xp_earned === 'number' ? ` · +${session.xp_earned} XP` : ''}</span>
            {syncPending && <button onClick={() => void retry()} disabled={saving} className="inline-flex items-center gap-2 font-medium text-primary"><RotateCcw size={16} className={saving ? 'animate-spin' : ''} />{saving ? 'Saving…' : 'Retry account save'}</button>}
          </div>
          {error && <p role="alert" className="mt-4 text-sm text-accent-warning">{error}</p>}
        </section>
        <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <section className="glass-card p-6 sm:p-8">
            <h2 className="text-xl font-semibold">Technique feedback</h2>
            <div className="my-5 flex flex-wrap gap-2">{Object.entries(summary?.criterion_state_counts ?? {}).map(([state, count]) => <span key={state} className={`rounded-full px-3 py-1.5 text-xs capitalize ${stateClass[state] || stateClass.UNCERTAIN}`}>{readable(state)} · {count}</span>)}</div>
            {session.last_assessment?.criteria.length ? <div className="divide-y divide-border">{session.last_assessment.criteria.map(criterion => <div key={criterion.criterion_id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><p className="text-sm font-medium capitalize">{readable(criterion.criterion_id.split('.').slice(2).join(' '))}</p><p className="mt-1 text-xs text-subtle">{criterion.measurement.value === null ? readable(criterion.measurement.reason || 'measurement unavailable') : `${criterion.measurement.value.toFixed(1)} ${criterion.measurement.unit}`}</p></div><span className={`rounded-full px-3 py-1.5 text-xs capitalize ${stateClass[criterion.state] || stateClass.UNCERTAIN}`}>{readable(criterion.state)}</span></div>)}</div> : <p className="text-sm leading-relaxed text-muted">No completed technique assessment was recorded. Keep your whole body in frame and complete a movement or hold in the next session.</p>}
          </section>
          <div className="space-y-6">
            <section className="glass-card p-6 sm:p-8"><h2 className="text-xl font-semibold">What the Brain observed</h2><dl className="mt-5 space-y-4 text-sm">{[['Frames analysed', summary?.frames_processed ?? 0], ['Assessments', summary?.assessments ?? 0], ['Movements interrupted', summary?.executions_aborted ?? 0], ['Estimated repetitions', session.repetition?.rep_count ?? 0]].map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt className="text-muted">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}</dl><p className="mt-5 text-xs leading-relaxed text-subtle">Repetition estimates count repeated motion. Completed movements follow the selected drill’s phase sequence.</p></section>
            <section className="glass-card p-6 sm:p-8"><h2 className="text-xl font-semibold">When feedback was withheld</h2>{Object.keys(summary?.abstention_reasons ?? {}).length ? <ul className="mt-5 space-y-3 text-sm text-muted">{Object.entries(summary!.abstention_reasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => <li key={reason} className="flex justify-between gap-4"><span className="capitalize">{readable(reason)}</span><span>{count}</span></li>)}</ul> : <p className="mt-4 text-sm text-muted">No reasons recorded.</p>}<p className="mt-5 text-xs leading-relaxed text-subtle">Recognition and technique scoring are separate. Squash technique criteria remain provisional until coach validation.</p></section>
          </div>
        </div>
      </main>
    </div>
  );
}
