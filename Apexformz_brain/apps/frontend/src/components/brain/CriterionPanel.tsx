"use client";

import React from 'react';
import type { AssessmentSet, CriterionEvidence } from '@apexformz/contracts';
import { criterionExplanation } from '@/lib/brain/criterionPresentation';

interface Props {
  assessment: AssessmentSet | null;
}

const BADGE: Record<CriterionEvidence['state'], string> = {
  PASS: 'bg-secondary/20 text-secondary border-secondary/40',
  IMPROVE: 'bg-accent-warning/20 text-accent-warning border-accent-warning/40',
  UNCERTAIN: 'bg-white/10 text-white/60 border-white/20',
  NOT_ASSESSABLE: 'bg-white/5 text-white/40 border-white/10',
  NOT_APPLICABLE: 'bg-white/5 text-white/30 border-white/10',
};

function fmt(v: number, unit: string): string {
  const digits = unit === 'ms' ? 0 : Math.abs(v) >= 10 ? 1 : 3;
  return `${v.toFixed(digits)} ${unit === 'none' ? '' : unit}`.trim();
}

export const CriterionPanel: React.FC<Props> = ({ assessment }) => {
  if (!assessment) {
    return (
      <div className="glass-card p-4">
        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40 mb-2">Criteria</h3>
        <p className="text-xs text-white/40">Waiting for enough observable evidence. Posture checks evaluate your attempt; dynamic action checks need the relevant movement phase. No verdict means unassessed, not correct.</p>
      </div>
    );
  }
  const cov = assessment.coverage;
  return (
    <div className="glass-card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40">Criteria</h3>
        <span className="text-[9px] font-mono text-white/40">coverage {cov.evaluated}/{cov.required} (min {Math.round(cov.minimum * 100)}%)</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-black italic text-white">{assessment.score === null ? '—' : Math.round(assessment.score * 100)}</span>
        <span className="text-[9px] uppercase tracking-widest text-white/40">{assessment.score === null ? 'No overall score · see individual criteria' : assessment.criteria.some(c => c.provenance.provisional) ? 'Preview score · provisional criteria' : 'Form score'}</span>
      </div>
      <div className="flex flex-col gap-2">
        {assessment.criteria.map((c) => (
          <div key={c.criterion_id} className="rounded-lg border border-white/5 bg-white/[0.03] p-3 flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold text-white/80 truncate">{c.criterion_id.split('.').pop()?.replace(/_/g, ' ') || c.criterion_id}</span>
              <div className="flex items-center gap-1 shrink-0">
                {c.provenance.provisional && <span className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-accent-warning/40 text-accent-warning">provisional</span>}
                <span className={`text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${BADGE[c.state]}`}>{c.state.replace(/_/g, ' ')}</span>
              </div>
            </div>
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-mono text-white/60">
                {c.measurement.value !== null ? fmt(c.measurement.value, c.measurement.unit) : 'Measurement unavailable'}
              </span>
              {c.phase_id && <span className="text-white/30 uppercase tracking-wider">{c.phase_id}</span>}
            </div>
            {c.feedback && <p className="text-[11px] text-white/70">{c.feedback.cue}</p>}
            {criterionExplanation(c) && <p className="text-[11px] text-white/60">{criterionExplanation(c)}</p>}
          </div>
        ))}
      </div>
    </div>
  );
};
