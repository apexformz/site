"use client";

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { JointFeedback } from '@smartcoach/types';

interface ActionableFeedbackProps {
  feedbacks: JointFeedback[];
}

export const ActionableFeedback: React.FC<ActionableFeedbackProps> = ({ feedbacks }) => {
  // Only show the most severe or important feedbacks
  const displayFeedbacks = feedbacks
    .filter(f => f.severity !== 'good')
    .sort((a, b) => (a.severity === 'error' ? -1 : 1))
    .slice(0, 6);

  return (
    <div className="flex flex-col gap-2 w-full max-w-sm">
      <AnimatePresence mode="popLayout">
        {displayFeedbacks.length > 0 ? (
          displayFeedbacks.map((f, i) => (
            <motion.div
              key={`${f.joint}-${f.message}`}
              initial={{ x: 50, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              className={`glass-card p-4 flex items-start gap-4 border-l-4 ${
                f.severity === 'error' ? 'border-l-accent-danger bg-accent-danger/10' : 'border-l-accent-warning bg-accent-warning/10'
              }`}
            >
              {f.severity === 'error' ? (
                <AlertCircle className="w-6 h-6 text-accent-danger shrink-0" />
              ) : (
                <Info className="w-6 h-6 text-accent-warning shrink-0" />
              )}
              <div className="flex flex-col">
                <span className="text-sm font-bold uppercase tracking-tight text-white/90">
                  {f.joint.replace('_', ' ')}
                </span>
                <span className="text-sm text-white/70 leading-tight">
                  {f.message}
                </span>
              </div>
            </motion.div>
          ))
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="glass-card p-4 flex items-center gap-4 border-l-4 border-l-secondary bg-secondary/10"
          >
            <CheckCircle2 className="w-6 h-6 text-secondary shrink-0" />
            <span className="text-sm font-bold uppercase tracking-wide text-secondary">Looking Good!</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
