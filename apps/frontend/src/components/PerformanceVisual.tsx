'use client';

import dynamic from 'next/dynamic';
import { useReducedMotion } from 'framer-motion';
import { ScanLine, Pause, Play } from 'lucide-react';
import { useCallback, useState } from 'react';

const AthleteModel = dynamic(() => import('./ReferenceAthleteModel'), {
  ssr: false,
  loading: () => (
    <img
      src="/images/apex-athlete-reference.png"
      alt=""
      className="h-full w-full object-contain"
    />
  ),
});

export function PerformanceVisual({ compact = false }: { compact?: boolean }) {
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(true);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const onReady = useCallback(() => {
    setReady(true);
    setUnavailable(false);
  }, []);
  const onUnavailable = useCallback(() => {
    setUnavailable(true);
    setReady(false);
  }, []);

  return (
    <div
      className={`performance-scene ${compact ? 'performance-scene-compact' : ''}`}
    >
      <div className="performance-model-stage">
        <div className="performance-orbit" aria-hidden="true" />
        <div className="performance-plinth" aria-hidden="true" />
        <div className="performance-model">
          <AthleteModel
            playing={playing && !reduced}
            onReady={onReady}
            onUnavailable={onUnavailable}
          />
        </div>
      </div>
      <div className="scene-caption">
        <span className="scene-chip-icon">
          <ScanLine size={22} strokeWidth={1.6} />
        </span>
        <div className="min-w-0 flex-1">
          <strong>Every movement matters</strong>
          <small>Real-time form guidance</small>
        </div>
        {ready && !reduced && (
          <button
            type="button"
            onClick={() => setPlaying(!playing)}
            aria-label={
              playing ? 'Pause athlete animation' : 'Play athlete animation'
            }
            aria-pressed={!playing}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border/50 bg-surface/80 text-primary transition hover:bg-surface-raised"
          >
            {playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
        )}
      </div>
      <p className="mt-3 text-center text-xs text-subtle">
        {unavailable ? 'Athlete illustration' : 'Movement in focus'}
        <span aria-hidden="true"> · </span>Inspired by the way you move
      </p>
    </div>
  );
}
