"use client";

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, Info } from 'lucide-react';
import { prioritizeCorrectionIssues } from '@apexformz/brain-client';

import { CoachIssue } from '@smartcoach/types';

interface ActionableFeedbackProps {
  issues: (CoachIssue & { provisional?: boolean; phase?: string })[];
  /** The Brain supplies an evidence-aware empty state; an empty issues list is not a technique verdict. */
  emptyState?: { title: string; description: string };
}

export const ActionableFeedback: React.FC<ActionableFeedbackProps> = ({ issues, emptyState }) => {
  // Low-priority cues (for example, a low racket hand) remain actionable.
  const displayIssues = prioritizeCorrectionIssues(issues || []);

  return (
    <div className="flex flex-col gap-3 w-full">
      <AnimatePresence mode="popLayout">
        {displayIssues.length > 0 ? (
          displayIssues.map((issue, i) => (
            <motion.div
              key={`${issue.joint}-${issue.problem}`}
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              className={`glass-card p-4 flex flex-col gap-2 border-l-4 overflow-hidden relative group transition-all duration-300 ${
                issue.severity === 'high' 
                  ? 'border-l-accent-danger bg-accent-danger/5 shadow-lg shadow-accent-danger/5' 
                  : 'border-l-accent-warning bg-accent-warning/5'
              }`}
            >
              <div className="flex items-center gap-3">
                 {issue.severity === 'high' ? (
                   <div className="w-8 h-8 rounded-full bg-accent-danger/20 flex items-center justify-center shrink-0">
                     <AlertCircle className="w-4 h-4 text-accent-danger" />
                   </div>
                 ) : (
                   <div className="w-8 h-8 rounded-full bg-accent-warning/20 flex items-center justify-center shrink-0">
                     <Info className="w-4 h-4 text-accent-warning" />
                   </div>
                 )}
                 <div className="flex flex-col">
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40 leading-none mb-1">
                      {issue.joint.replace('_', ' ')}
                    </span>
                    <h5 className="text-sm font-bold text-white leading-tight">
                      {issue.problem}
                    </h5>
                    {issue.provisional && <span className="text-[10px] text-accent-warning">Preview correction</span>}
                    {issue.phase && issue.phase !== 'hold' && <span className="text-[10px] text-white/50">Observed phase: {issue.phase.replace(/_/g, ' ')}</span>}
                 </div>
              </div>

              <div className="bg-white/5 rounded-lg p-3 mt-1 border border-white/5 group-hover:bg-white/10 transition-colors">
                <p className="text-xs text-white/70 leading-relaxed font-medium">
                  <span className="text-primary font-black uppercase text-[10px] mr-2">Coach:</span>
                  {issue.correction}
                </p>
              </div>

              {/* Subtle background pulse for high severity issues */}
              {issue.severity === 'high' && (
                <div className="absolute inset-0 bg-accent-danger/10 animate-pulse pointer-events-none" />
              )}
            </motion.div>
          ))
        ) : (
          <div className="glass-card p-4 flex flex-col gap-2 border-l-4 border-l-white/20 bg-white/[0.02]" role="status">
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/50">{emptyState?.title ?? 'No correction available'}</span>
            <p className="text-xs text-white/50 leading-relaxed">{emptyState?.description ?? 'No assessable correction has been reported. This does not confirm correct technique.'}</p>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
