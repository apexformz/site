'use client';

import { Crosshair, X } from 'lucide-react';

export type PinViewState = 'unpinned' | 'pending' | 'tracking' | 'uncertain' | 'searching';

export interface PinView {
  state: PinViewState;
  personCount: number;
  error: string | null;
}

const LABEL: Record<Exclude<PinViewState, 'unpinned'>, { text: string; tone: string }> = {
  pending: { text: 'Pinning…', tone: 'border-white/30 text-white/70' },
  tracking: { text: 'Pinned · tracking', tone: 'border-primary/50 text-primary' },
  uncertain: { text: 'Pinned · players crossing, paused', tone: 'border-accent-warning/50 text-accent-warning' },
  searching: { text: 'Pinned · searching, tap the athlete again if needed', tone: 'border-accent-warning/50 text-accent-warning' },
};

/** Tap-to-pin status chip. The tap itself is handled on the video surface by the page. */
export function PinControl({ view, onUnpin }: { view: PinView; onUnpin: () => void }) {
  if (view.state === 'unpinned') {
    if (view.error) return <Chip tone="border-accent-danger/50 text-accent-danger">{view.error}: tap directly on the athlete</Chip>;
    if (view.personCount < 2) return null;
    return <Chip tone="border-primary/40 text-primary">{view.personCount} people in view · tap the athlete to pin</Chip>;
  }
  const l = LABEL[view.state];
  return (
    <Chip tone={l.tone}>
      {l.text}
      <button data-no-pin onClick={onUnpin} className="ml-2 rounded-full p-0.5 hover:bg-white/10" title="Unpin" aria-label="Unpin athlete">
        <X className="w-3 h-3" />
      </button>
    </Chip>
  );
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <div data-no-pin className={`flex items-center gap-2 rounded-full border bg-black/60 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest backdrop-blur ${tone}`}>
      <Crosshair className="w-3 h-3" />
      {children}
    </div>
  );
}
