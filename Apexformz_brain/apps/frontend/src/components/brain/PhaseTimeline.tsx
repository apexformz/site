"use client";

import React from 'react';
import type { PhaseGraph } from '@apexformz/contracts';
import type { TemporalUpdate } from '@apexformz/analysis';

interface Props {
  graph: PhaseGraph | null;
  temporal: TemporalUpdate | null;
}

const STATE_COLORS: Record<string, string> = {
  IDLE: 'text-white/40 border-white/10',
  CANDIDATE: 'text-accent-warning border-accent-warning/40',
  CONFIRMED: 'text-primary border-primary/40',
  EXECUTING: 'text-secondary border-secondary/40',
  COMPLETE: 'text-secondary border-secondary/60 bg-secondary/10',
  ABORTED: 'text-accent-danger border-accent-danger/40',
  UNKNOWN: 'text-accent-danger border-accent-danger/40',
};

export const PhaseTimeline: React.FC<Props> = ({ graph, temporal }) => {
  const state = temporal?.state ?? 'IDLE';
  const active = temporal?.phase_id ?? null;
  const done = new Set(temporal?.execution_phases.filter((p) => p.end_ms !== null).map((p) => p.phase_id) ?? []);
  return (
    <div className="glass-card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40">Movement phases</h3>
        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${STATE_COLORS[state] ?? STATE_COLORS.IDLE}`}>{state}</span>
      </div>
      {graph ? (
        <div className="flex flex-col gap-1">
          {graph.phases.map((p) => {
            const isActive = p.id === active;
            const isDone = done.has(p.id) && !isActive;
            return (
              <div key={p.id} className={`flex items-center justify-between px-3 py-2 rounded-lg border text-xs transition-colors ${isActive ? 'bg-primary/15 border-primary/50 text-white' : isDone ? 'bg-secondary/10 border-secondary/30 text-white/70' : 'bg-white/[0.03] border-white/5 text-white/40'}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-primary animate-pulse' : isDone ? 'bg-secondary' : 'bg-white/20'}`} />
                  <span className="font-bold">{p.name}</span>
                  <span className="text-[9px] uppercase tracking-wider text-white/30">{p.kind.replace(/_/g, ' ')}</span>
                </div>
                <div className="flex items-center gap-2">
                  {(p.contact_evidence === 'unobserved' || p.contact_evidence === 'estimated_contact') && (
                    <span className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-accent-warning/40 text-accent-warning" title="Contact is inferred from body pose; never confirmed">
                      {p.contact_evidence === 'unobserved' ? 'contact unobserved' : 'estimated contact'}
                    </span>
                  )}
                  {isActive && temporal?.phase_duration_ms != null && <span className="font-mono text-[10px] text-primary">{Math.round(temporal.phase_duration_ms)} ms</span>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-white/40">Phase graph loads when the session starts.</p>
      )}
      {temporal?.aborted_reason && <p className="text-[10px] text-accent-danger uppercase tracking-wider">Aborted: {temporal.aborted_reason.replace(/_/g, ' ').toLowerCase()}</p>}
    </div>
  );
};
