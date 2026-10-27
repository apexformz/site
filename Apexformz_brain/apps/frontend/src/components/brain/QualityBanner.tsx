"use client";

import React from 'react';
import { AlertTriangle, CheckCircle2, ScanLine } from 'lucide-react';
import type { FeedbackAction } from '@apexformz/contracts';

interface Props {
  /** Null means there is no current pose evidence, not a successful quality check. */
  ok: boolean | null;
  reasons: string[];
  instruction: FeedbackAction | null;
  sessionState: string;
  waitingMessage?: string;
}

const LABELS: Record<string, string> = {
  AMBIGUOUS_SUBJECT: 'Another person in frame',
  FRAMING_INVALID: 'Body not fully in frame',
  MISSING_JOINT: 'Joints hidden',
  TRACK_CHANGED: 'Lost track',
  LOW_CONFIDENCE: 'Low tracking confidence',
};

export const QualityBanner: React.FC<Props> = ({ ok, reasons, instruction, sessionState, waitingMessage }) => {
  if (ok === null || (sessionState !== 'ACTIVE' && sessionState !== 'DEGRADED')) {
    return (
      <div className="glass-card p-4 flex flex-col gap-2 border-l-4 border-l-white/20 bg-white/[0.02]" role="status">
        <div className="flex items-center gap-3"><ScanLine className="w-4 h-4 text-white/40 shrink-0" /><span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/50">Waiting for pose</span></div>
        <p className="text-xs text-white/50 leading-relaxed">{waitingMessage ?? 'Start a session with the camera enabled to check pose quality.'}</p>
      </div>
    );
  }
  if (ok && sessionState !== 'DEGRADED') {
    return (
      <div className="glass-card p-3 flex flex-col gap-2 border-l-4 border-l-sky-400 bg-sky-400/5">
        <div className="flex items-center gap-3"><CheckCircle2 className="w-4 h-4 text-sky-300 shrink-0" />
        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-sky-300">Body tracking available</span></div>
        <p className="text-xs text-white/50">Landmarks are visible. Technique correctness is assessed separately below.</p>
      </div>
    );
  }
  return (
    <div className="glass-card p-4 flex flex-col gap-2 border-l-4 border-l-accent-danger bg-accent-danger/5">
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-4 h-4 text-accent-danger shrink-0" />
        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-accent-danger">
          {sessionState === 'DEGRADED' ? 'Degraded: coaching paused' : 'Coaching suppressed'}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {reasons.map((r) => (
          <span key={r} className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border border-accent-danger/30 text-accent-danger/80">
            {LABELS[r] ?? r.replace(/_/g, ' ').toLowerCase()}
          </span>
        ))}
      </div>
      {instruction && (instruction.kind === 'setup_instruction' || instruction.kind === 'quality_instruction') && (
        <p className="text-xs text-white/70 leading-relaxed">{instruction.text}</p>
      )}
    </div>
  );
};
