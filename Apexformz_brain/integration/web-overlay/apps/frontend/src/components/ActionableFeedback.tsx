'use client';
import React from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { CoachIssue } from '@smartcoach/types';

interface ActionableFeedbackProps {
  issues: CoachIssue[];
  /** An empty corrections list is not a verdict on technique. */
  emptyState?: { title: string; description: string };
}

export function ActionableFeedback({ issues, emptyState }: ActionableFeedbackProps) {
  const reduceMotion = useReducedMotion();
  const displayIssues = (issues || [])
    .filter((issue) => issue.severity !== 'none' && issue.severity !== 'low')
    .sort(
      (a, b) => Number(b.severity === 'high') - Number(a.severity === 'high'),
    )
    .slice(0, 3);
  return (
    <div className="flex flex-col gap-5 w-full">
      <AnimatePresence mode="popLayout" initial={false}>
        {displayIssues.length > 0 ? (
          displayIssues.map((issue) => (
            <motion.div
              key={`${issue.joint}-${issue.problem}`}
              layout
              initial={{ y: reduceMotion ? 0 : 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="glass-card p-6"
              style={{ borderRadius: 28 }}
            >
              <div className="flex items-center gap-3 mb-5">
                <div
                  className={`w-11 h-11 rounded-[17px] flex items-center justify-center shrink-0 ${issue.severity === 'high' ? 'bg-accent-danger/10 text-accent-danger' : 'bg-accent-warning/10 text-accent-warning'}`}
                >
                  {issue.severity === 'high' ? (
                    <AlertCircle className="w-5 h-5" />
                  ) : (
                    <Info className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <p
                    className={`text-sm font-medium ${issue.severity === 'high' ? 'text-accent-danger' : 'text-accent-warning'}`}
                  >
                    {issue.severity === 'high'
                      ? 'Priority correction'
                      : 'Refinement'}
                  </p>
                  <p className="text-sm text-subtle capitalize mt-1">
                    {issue.joint.replace(/_/g, ' ')}
                  </p>
                </div>
              </div>
              <h4 className="text-lg font-semibold text-foreground leading-snug">
                {issue.problem}
              </h4>
              <p className="text-base text-muted leading-relaxed mt-5 pt-5 border-t border-border">
                <ArrowUpRight className="inline w-5 h-5 text-primary mr-1.5" />
                {issue.correction}
              </p>
            </motion.div>
          ))
        ) : (
          <motion.div
            key="good-form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="glass-card p-7"
          >
            <div className="clay-icon w-16 h-16 mb-6">
              {emptyState ? <Info className="w-8 h-8" /> : <CheckCircle2 className="w-8 h-8" />}
            </div>
            <h3 className="text-xl font-semibold text-foreground">
              {emptyState?.title ?? 'Form on target'}
            </h3>
            <p className="text-base text-muted leading-relaxed mt-4">
              {emptyState?.description ?? 'No priority corrections right now. Maintain your alignment and controlled movement.'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
