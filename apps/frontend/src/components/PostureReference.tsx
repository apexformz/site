'use client';
import React, { useEffect, useState } from 'react';
import { Sport } from '@smartcoach/types';
import { Focus } from 'lucide-react';

export function PostureReference({
  sport,
  poseName,
}: {
  sport: Sport;
  poseName?: string;
}) {
  const [fallback, setFallback] = useState(0);
  useEffect(() => setFallback(0), [sport, poseName]);
  const imageUrl =
    poseName && fallback === 0
      ? `/postures/${sport}_${poseName}.${sport === 'squash' ? 'svg' : 'png'}`
      : `/postures/${sport}.${sport === 'squash' ? 'svg' : 'png'}`;
  return (
    <div className="glass-card overflow-hidden" style={{ borderRadius: 28 }}>
      <div className="px-6 pt-6 flex items-center gap-2.5 text-base font-semibold text-foreground">
        <Focus className="w-5 h-5 text-primary" /> Movement reference
      </div>
      <div className="relative m-4 rounded-[22px] bg-surface-inset h-64 flex items-center justify-center">
        {fallback < 2 ? (
          <img
            src={imageUrl}
            alt={`${(poseName || sport).replace(/_/g, ' ')} posture reference`}
            className="w-full h-full object-contain p-4 rounded-2xl"
            onError={() => setFallback((current) => current + 1)}
          />
        ) : (
          <div className="text-center p-6">
            <Focus className="w-14 h-14 text-primary/50 mx-auto mb-4 stroke-1" />
            <p className="text-sm text-muted leading-relaxed">
              Reference unavailable. Follow the live coaching cues.
            </p>
          </div>
        )}
      </div>
      <div className="px-6 pb-7">
        <p className="text-base font-semibold capitalize">
          {(poseName || sport).replace(/_/g, ' ')}
        </p>
        <p className="text-sm text-muted leading-relaxed mt-3">
          {sport === 'squash'
            ? 'Illustrative position guide, not an expert capture. Either side may be used; racket position is not assessed.'
            : 'Use this as a guide for your stance and alignment.'}
        </p>
      </div>
    </div>
  );
}
