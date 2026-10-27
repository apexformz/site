"use client";

import type { PhaseGraph } from '@apexformz/contracts';
import type { DynamicProgress as Progress } from '@/lib/brain/dynamicProgress';

export function DynamicProgress({ graph, progress }: { graph: PhaseGraph | null; progress: Progress }) {
  return <section className="rounded-xl border border-sky-400/30 bg-sky-400/5 p-3 shrink-0" aria-label="Dynamic movement progress" data-testid="dynamic-movement-progress">
    <div className="flex justify-between items-start gap-2">
      <p className="text-sm font-semibold text-sky-200">{progress.title}</p>
      {progress.elapsedMs !== null && <span className="text-xs tabular-nums text-white/50 shrink-0">{Math.max(0, progress.elapsedMs / 1000).toFixed(1)} s</span>}
    </div>
    <p className="text-xs leading-relaxed text-white/65 mt-1">{progress.description}</p>
    <ol className="flex flex-wrap gap-1.5 mt-3" aria-label="Movement sequence">
      {graph?.phases.map((phase, index) => <li key={phase.id} aria-current={progress.activePhase === phase.id ? 'step' : undefined} className={`px-2 py-1 rounded border text-[10px] ${progress.activePhase === phase.id ? 'border-sky-300 text-sky-200 bg-sky-400/10' : progress.observedPhases.includes(phase.id) ? 'border-white/30 text-white/70' : 'border-white/10 text-white/40'}`}>
        {index + 1}. {phase.name}
      </li>)}
    </ol>
  </section>;
}
