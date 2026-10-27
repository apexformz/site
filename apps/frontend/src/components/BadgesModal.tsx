'use client';

import React, { useEffect, useRef } from 'react';
import { Trophy, X, LockKeyhole, Check } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';

export interface Badge {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  unlocked: boolean;
  date?: string;
  color: string;
}
interface BadgesModalProps {
  isOpen: boolean;
  onClose: () => void;
  badges: Badge[];
}

export const BadgesModal: React.FC<BadgesModalProps> = ({
  isOpen,
  onClose,
  badges,
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (isOpen && !element.open) element.showModal();
    if (!isOpen && element.open) element.close();
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        element.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((control) => control.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) {
        event.preventDefault();
        element.focus();
        return;
      }
      if (!element.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === element)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus, true);
    return () => {
      document.removeEventListener('keydown', trapFocus, true);
      document.body.style.overflow = previous;
      if (element.open) element.close();
    };
  }, [isOpen]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="achievements-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto w-[calc(100%-32px)] max-w-3xl max-h-[90dvh] p-0 bg-transparent text-foreground backdrop:bg-background/70 backdrop:backdrop-blur-md rounded-[28px]"
    >
      {isOpen && (
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, y: 16, scale: 0.975 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="border border-border rounded-[28px] bg-surface-raised overflow-hidden"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <div className="p-6 sm:p-8 flex items-start justify-between gap-5 border-b border-border">
            <div className="min-w-0">
              <span className="clay-icon w-14 h-14 rounded-[20px] mb-5">
                <Trophy size={25} strokeWidth={1.6} />
              </span>
              <h2
                id="achievements-title"
                className="text-2xl sm:text-3xl font-semibold tracking-tight"
              >
                Athlete achievements
              </h2>
              <p className="text-sm text-muted mt-3 leading-relaxed">
                {badges.filter((badge) => badge.unlocked).length} of{' '}
                {badges.length} milestones reached. Every one earned.
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close achievements"
              className="p-3 shrink-0 rounded-2xl border border-border bg-surface text-muted hover:text-foreground hover:bg-surface-inset transition-colors"
            >
              <X size={19} />
            </button>
          </div>
          <div className="p-5 sm:p-7 max-h-[58dvh] overflow-y-auto custom-scrollbar">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {badges.map((badge) => {
                const Icon = badge.icon;
                return (
                  <div
                    key={badge.id}
                    className={`p-5 sm:p-6 rounded-[22px] border flex flex-col items-start ${badge.unlocked ? 'border-primary/20 bg-primary/[.035]' : 'border-border bg-surface'}`}
                  >
                    <div
                      className={`w-14 h-14 shrink-0 rounded-[18px] flex items-center justify-center mb-5 ${badge.unlocked ? 'clay-icon' : 'bg-surface-inset border border-border text-subtle'}`}
                    >
                      <Icon size={26} strokeWidth={1.5} />
                    </div>
                    <h3 className="text-base font-semibold">{badge.title}</h3>
                    <p className="text-sm text-muted leading-relaxed mt-2 mb-5 flex-1">
                      {badge.description}
                    </p>
                    <span
                      className={`inline-flex gap-2 items-center text-sm ${badge.unlocked ? 'text-primary' : 'text-subtle'}`}
                    >
                      {badge.unlocked ? (
                        <Check size={16} />
                      ) : (
                        <LockKeyhole size={15} />
                      )}
                      {badge.unlocked
                        ? badge.date || 'Unlocked'
                        : 'Still ahead'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </motion.div>
      )}
    </dialog>
  );
};
