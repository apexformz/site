"use client";

import React from 'react';
import { Repeat } from 'lucide-react';
import type { RepetitionEstimate } from '@apexformz/analysis';

interface Props {
  repetition: RepetitionEstimate | null;
  executionsCompleted: number;
  movementType?: 'static' | 'dynamic';
  diagnostics?: boolean;
}

export const RepetitionTile: React.FC<Props> = ({ repetition, executionsCompleted, movementType, diagnostics = false }) => (
  <div className="glass-card p-4 flex flex-col gap-3 border-l-4 border-l-primary/40">
    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40 flex items-center gap-2"><Repeat className="w-3 h-3" /> Selected drill progress</h3>
    <div className="bg-black/40 rounded-lg p-3 border border-white/5">
      <div className="text-[9px] font-black text-white/40 uppercase tracking-widest mb-1">{movementType === 'static' ? 'Completed holds' : 'Completed movement sequences'}</div>
      <div className="text-2xl font-black text-white italic" data-testid="completed-drill-executions">{executionsCompleted}</div>
    </div>
    <p className="text-[10px] text-white/50">Completion records the observed drill sequence, not technique correctness. Follow the criterion results for corrections.</p>
    {diagnostics && <p className="text-[10px] text-white/40">Motion diagnostic: {repetition?.rep_count ?? 0} generic cycles, {Math.round((repetition?.periodicity ?? 0) * 100)}% periodicity. These are not selected-drill repetitions.</p>}
  </div>
);
