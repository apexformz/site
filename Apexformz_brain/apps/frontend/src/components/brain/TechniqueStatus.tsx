"use client";

import React from 'react';
import type { TechniqueSummary } from '@/lib/brain/techniqueSummary';

export function TechniqueStatus({ summary, compact = false }: { summary: TechniqueSummary; compact?: boolean }) {
  const color = summary.state === 'adjust' ? 'border-[#ff4757]/70 bg-[#ff4757]/10' : 'border-[#00d4ff]/40 bg-black/70';
  return (
    <section className={`rounded-xl border-l-4 ${color} p-4 backdrop-blur-md`} aria-label={compact ? 'Camera coaching cue' : 'Live technique feedback'} data-testid={compact ? 'camera-coaching-cue' : 'live-technique-feedback'}>
      <div className="flex items-center justify-between gap-3">
        <p className={`font-semibold ${summary.state === 'adjust' ? 'text-[#ff6976]' : 'text-white'} ${compact ? 'text-sm' : 'text-base'}`} role="status">{summary.title}</p>
        {!compact && summary.provisional && <span className="text-[9px] uppercase tracking-wider text-amber-300 shrink-0">Preview</span>}
      </div>
      <p className={`${compact ? 'text-xs' : 'text-sm'} text-white/90 leading-relaxed mt-1`}>{summary.detail}</p>
      {!compact && (summary.passed + summary.corrections + summary.unassessed > 0) && <p className="text-xs text-white/60 mt-2">{summary.passed} in range · {summary.corrections} to adjust · {summary.unassessed} unassessed</p>}
    </section>
  );
}
