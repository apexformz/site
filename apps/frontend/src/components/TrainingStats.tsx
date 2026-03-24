"use client";

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, Zap, Timer, Target } from 'lucide-react';

interface TrainingStatsProps {
  score: number;
  duration: number;
  frameCount: number;
  isConnected: boolean;
}

export const TrainingStats: React.FC<TrainingStatsProps> = ({ score, duration, frameCount, isConnected }) => {
  return (
    <div className="flex flex-col gap-4">
      {/* Real-time Score Ring */}
      <div className="relative w-32 h-32 flex items-center justify-center">
        <svg className="w-full h-full transform -rotate-90">
          <circle
            cx="64"
            cy="64"
            r="60"
            stroke="currentColor"
            strokeWidth="8"
            fill="transparent"
            className="text-white/10"
          />
          <motion.circle
            cx="64"
            cy="64"
            r="60"
            stroke="currentColor"
            strokeWidth="8"
            fill="transparent"
            strokeDasharray={377}
            initial={{ strokeDashoffset: 377 }}
            animate={{ strokeDashoffset: 377 - (377 * score) / 100 }}
            className="text-primary"
          />
        </svg>
        <div className="absolute flex flex-col items-center">
          <span className="text-3xl font-bold">{Math.round(score)}</span>
          <span className="text-xs text-white/50 uppercase tracking-widest">Score</span>
        </div>
      </div>

      {/* Connection Status */}
      <div className="flex items-center gap-2 px-4 py-2 glass-card border-none bg-white/10">
        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-secondary animate-pulse' : 'bg-accent-danger'}`} />
        <span className="text-sm font-medium uppercase tracking-tighter">AI {isConnected ? 'Live' : 'Offline'}</span>
      </div>

      {/* Grid Stats */}
      <div className="grid grid-cols-2 gap-2">
        <div className="glass-card p-3 flex flex-col items-center">
          <Timer className="w-4 h-4 text-primary mb-1" />
          <span className="text-lg font-mono">{Math.floor(duration / 60)}:{(duration % 60).toString().padStart(2, '0')}</span>
          <span className="text-[10px] text-white/40 uppercase">Time</span>
        </div>
        <div className="glass-card p-3 flex flex-col items-center">
          <Zap className="w-4 h-4 text-secondary mb-1" />
          <span className="text-lg font-mono">{frameCount}</span>
          <span className="text-[10px] text-white/40 uppercase">Frames</span>
        </div>
      </div>
    </div>
  );
};
