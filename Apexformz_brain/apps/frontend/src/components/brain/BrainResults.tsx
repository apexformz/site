"use client";

import React from 'react';
import { Activity, Cpu, ShieldAlert } from 'lucide-react';
import type { StoredBrainSession } from '@/lib/brain/session';

interface Props {
  session: StoredBrainSession;
}

const STATE_COLOR: Record<string, string> = {
  PASS: 'text-secondary border-secondary/40 bg-secondary/10',
  IMPROVE: 'text-accent-warning border-accent-warning/40 bg-accent-warning/10',
  UNCERTAIN: 'text-white/70 border-white/20 bg-white/5',
  NOT_ASSESSABLE: 'text-white/50 border-white/10 bg-white/5',
  NOT_APPLICABLE: 'text-white/30 border-white/10 bg-white/5',
};

export const BrainResults: React.FC<Props> = ({ session }) => {
  const s = session.summary;
  const lastScore = s?.last_score ?? null;
  return (
    <div className="flex flex-col gap-8">
      <section className="glass-card p-10 bg-gradient-to-br from-primary/10 to-transparent border-primary/20 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8"><Cpu className="w-24 h-24 text-primary opacity-20 rotate-12" /></div>
        <div className="relative z-10 flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary">On-device Brain session</span>
            <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border border-white/20 text-white/60">{session.pack ? `${session.pack.id}@${session.pack.version}` : session.sport}</span>
            <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${session.mode === 'strict' ? 'border-secondary/40 text-secondary' : 'border-accent-warning/40 text-accent-warning'}`}>{session.mode} mode</span>
            {!session.backend_backed && <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border border-white/20 text-white/40">local only</span>}
          </div>
          <div className="flex items-end gap-16">
            <div className="flex flex-col">
              <span className="text-7xl font-black italic tracking-tighter text-glow">{lastScore === null ? '—' : Math.round(lastScore * 100)}</span>
              <span className="text-xs font-bold text-white/30 uppercase tracking-[0.3em]">{lastScore === null ? 'Not scored: coverage or rubric gate' : 'Last aggregate score'}</span>
            </div>
            <div className="h-20 w-px bg-white/10" />
            <div className="grid grid-cols-3 gap-8">
              {[
                ['Movements completed', s?.executions_completed ?? 0],
                ['Aborted', s?.executions_aborted ?? 0],
                ['Assessments', s?.assessments ?? 0],
                ['Cues issued', s?.feedback_issued ?? 0],
                ['Frames', s?.frames_processed ?? 0],
                ['Pending sync', s?.outbox_pending ?? 0],
              ].map(([label, v]) => (
                <div key={String(label)} className="flex flex-col items-center">
                  <span className="text-2xl font-bold text-white">{String(v)}</span>
                  <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest text-center">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs text-white/50 uppercase tracking-wider">
            {session.movement_name ?? session.movement_id.split('.').slice(1).join(' ').replace(/_/g, ' ')}
            {session.pose_backend ? ` · pose ${session.pose_backend}` : ''}
          </p>
          {session.repetition && (
            <div className="flex items-center gap-6 text-xs text-white/60">
              <span className="text-[10px] font-black uppercase tracking-widest text-primary">Repetitions (class-agnostic)</span>
              <span>{session.repetition.rep_count} reps</span>
              <span>period {session.repetition.period_ms ? `${(session.repetition.period_ms / 1000).toFixed(2)} s` : '—'}</span>
              <span>periodicity {Math.round(session.repetition.periodicity * 100)}%</span>
              {session.repetition.dominant_feature && <span>dominant {session.repetition.dominant_feature.replace(/_/g, ' ')}</span>}
            </div>
          )}
        </div>
      </section>

      <div className="grid grid-cols-12 gap-8">
        <section className="col-span-12 lg:col-span-7 glass-card p-8">
          <h3 className="text-sm font-bold tracking-widest uppercase text-white/40 mb-6 flex items-center gap-2"><Activity className="w-4 h-4" /> Criterion outcomes</h3>
          <div className="flex flex-wrap gap-2 mb-6">
            {Object.entries(s?.criterion_state_counts ?? {}).map(([state, n]) => (
              <span key={state} className={`text-[10px] font-black uppercase tracking-wider px-3 py-1 rounded border ${STATE_COLOR[state] ?? STATE_COLOR.UNCERTAIN}`}>{state.replace(/_/g, ' ')} × {n}</span>
            ))}
            {!s && <span className="text-xs text-white/40">No summary stored for this session.</span>}
          </div>
          {session.last_assessment && (
            <div className="flex flex-col gap-2">
              <p className="text-[10px] uppercase tracking-widest text-white/40">Last assessment ({session.last_assessment.phase_id ?? 'execution'})</p>
              {session.last_assessment.criteria.map((c) => (
                <div key={c.criterion_id} className="flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs">
                  <span className="text-white/80">{c.criterion_id.split('.').slice(2).join(' ').replace(/_/g, ' ')}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-white/50">{c.measurement.value !== null ? `${c.measurement.value.toFixed(1)} ${c.measurement.unit}` : c.measurement.reason?.replace(/_/g, ' ').toLowerCase()}</span>
                    <span className={`text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${STATE_COLOR[c.state]}`}>{c.state.replace(/_/g, ' ')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="col-span-12 lg:col-span-5 flex flex-col gap-6">
          <div className="glass-card p-8">
            <h3 className="text-sm font-bold tracking-widest uppercase text-white/40 mb-4">Abstention reasons</h3>
            {Object.keys(s?.abstention_reasons ?? {}).length ? (
              <ul className="flex flex-col gap-1 text-xs text-white/60 font-mono">
                {Object.entries(s!.abstention_reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span>{v}</span></li>)}
              </ul>
            ) : (
              <p className="text-xs text-white/40">None recorded.</p>
            )}
          </div>
          <div className="glass-card p-6 border-l-4 border-l-accent-warning bg-accent-warning/5 flex gap-3">
            <ShieldAlert className="w-5 h-5 text-accent-warning shrink-0" />
            <p className="text-[11px] text-white/60 leading-relaxed">
              Every criterion in this sport pack is provisional (coach validation pending). Scores and cues are engineering seeds, not validated technique assessments, and never a medical or officiating judgment.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
};
