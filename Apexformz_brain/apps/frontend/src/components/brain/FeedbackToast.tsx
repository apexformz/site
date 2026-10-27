"use client";

import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Megaphone } from 'lucide-react';
import type { FeedbackAction } from '@apexformz/contracts';

interface Props {
  feedback: FeedbackAction | null;
  announce: (text: string) => Promise<void>;
  voiceEnabled: boolean;
}

const PRIORITY: Record<string, string> = {
  safety: 'border-accent-danger bg-accent-danger/10 text-accent-danger',
  setup: 'border-accent-warning bg-accent-warning/10 text-accent-warning',
  primary: 'border-primary bg-primary/10 text-primary',
  secondary: 'border-secondary bg-secondary/10 text-secondary',
};

export const FeedbackToast: React.FC<Props> = ({ feedback, announce, voiceEnabled }) => {
  const spoken = useRef<string | null>(null);
  useEffect(() => {
    if (!feedback || spoken.current === feedback.event_id) return;
    spoken.current = feedback.event_id;
    if (voiceEnabled && feedback.modality.includes('audio') && ['technique_cue', 'setup_instruction', 'quality_instruction', 'positive_reinforcement'].includes(feedback.kind)) {
      void announce(feedback.text);
    }
  }, [feedback, announce, voiceEnabled]);

  return (
    <AnimatePresence mode="wait">
      {feedback && feedback.kind !== 'none' && (
        <motion.div
          key={feedback.event_id}
          initial={{ y: 12, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -12, opacity: 0 }}
          className={`glass-card p-4 border-l-4 flex flex-col gap-2 ${PRIORITY[feedback.priority] ?? PRIORITY.primary}`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Megaphone className="w-4 h-4" />
              <span className="text-[9px] font-black uppercase tracking-[0.2em]">{feedback.kind.replace(/_/g, ' ')} · {feedback.priority}</span>
            </div>
            {feedback.provenance.review_status === 'draft' && (
              <span className="text-[8px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-accent-warning/50 text-accent-warning">provisional</span>
            )}
          </div>
          <p className="text-sm font-bold text-white leading-snug">{feedback.text}</p>
          {feedback.rationale && <p className="text-[11px] text-white/50">{feedback.rationale}</p>}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
