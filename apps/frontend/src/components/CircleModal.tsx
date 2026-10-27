'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Users, X, ArrowRight, Loader2, Copy, Check, Plus } from 'lucide-react';
import { api } from '@/lib/api';

interface CircleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function CircleModal({ isOpen, onClose, onSuccess }: CircleModalProps) {
  const [activeTab, setActiveTab] = useState<'join' | 'create'>('join');
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdCircleId, setCreatedCircleId] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
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
  const handleClose = () => {
    if (isLoading) return;
    if (createdCircleId) onSuccess();
    setInputValue('');
    setError(null);
    setCreatedCircleId(null);
    setCopyStatus('');
    onClose();
  };
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!inputValue.trim() || isLoading) return;
    setIsLoading(true);
    setError(null);
    try {
      if (activeTab === 'create') {
        const res = await api.post('/circles', { name: inputValue.trim() });
        setCreatedCircleId(res.data.data.id);
        setInputValue('');
      } else {
        await api.post('/circles/join', { circleId: inputValue.trim() });
        onSuccess();
        setInputValue('');
        setError(null);
        onClose();
      }
    } catch (err: any) {
      setError(
        err.response?.data?.error || 'Something went wrong. Please try again.',
      );
    } finally {
      setIsLoading(false);
    }
  };
  const handleCopy = async () => {
    if (!createdCircleId) return;
    try {
      await navigator.clipboard.writeText(createdCircleId);
      setCopyStatus('Invite code copied');
    } catch {
      setCopyStatus('Could not copy. Select the code to copy it manually.');
    }
  };
  return (
    <dialog
      ref={dialog}
      aria-labelledby="circle-modal-title"
      onCancel={(event) => {
        event.preventDefault();
        handleClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
      className="m-auto w-[calc(100%-32px)] max-w-[520px] max-h-[90dvh] overflow-y-auto p-0 bg-transparent text-foreground backdrop:bg-background/70 backdrop:backdrop-blur-md rounded-[28px]"
    >
      {isOpen && (
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, y: 16, scale: 0.975 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="relative border border-border rounded-[28px] bg-surface-raised overflow-hidden"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <div className="flex items-start justify-between gap-5 p-6 sm:p-8 pb-0 sm:pb-0">
            <div className="min-w-0">
              <span className="clay-icon w-14 h-14 rounded-[20px] mb-5">
                <Users size={25} strokeWidth={1.6} />
              </span>
              <h2
                id="circle-modal-title"
                className="text-2xl sm:text-3xl font-semibold tracking-tight"
              >
                {createdCircleId ? 'Circle created' : 'Training circle'}
              </h2>
              <p className="text-base leading-relaxed text-muted mt-3">
                {createdCircleId
                  ? 'Your team has a place to come together.'
                  : 'Make progress with people who keep you going.'}
              </p>
            </div>
            <button
              onClick={handleClose}
              disabled={isLoading}
              aria-label="Close circle dialog"
              className="p-3 shrink-0 rounded-2xl border border-border bg-surface text-muted hover:text-foreground hover:bg-surface-inset transition-colors disabled:opacity-30"
            >
              <X size={19} />
            </button>
          </div>
          <div className="p-6 sm:p-8">
            {!createdCircleId ? (
              <>
                <div
                  className="flex gap-1 bg-surface-inset border border-border rounded-2xl p-1.5 mb-7"
                  aria-label="Circle action"
                >
                  {(['join', 'create'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      disabled={isLoading}
                      aria-pressed={activeTab === tab}
                      onClick={() => {
                        setActiveTab(tab);
                        setError(null);
                        setInputValue('');
                      }}
                      className={`relative flex-1 text-sm font-medium py-3 rounded-xl transition-colors ${activeTab === tab ? 'text-primary' : 'text-muted hover:text-foreground'}`}
                    >
                      {activeTab === tab && (
                        <motion.span
                          layoutId="circle-tab"
                          className="absolute inset-0 rounded-xl border border-border bg-surface-raised shadow-sm"
                          transition={
                            reducedMotion
                              ? { duration: 0 }
                              : { type: 'spring', stiffness: 360, damping: 32 }
                          }
                        />
                      )}
                      <span className="relative">
                        {tab === 'join' ? 'Join a circle' : 'Create a circle'}
                      </span>
                    </button>
                  ))}
                </div>
                <form onSubmit={handleSubmit}>
                  <label
                    htmlFor="circle-input"
                    className="text-sm font-semibold text-foreground block mb-3"
                  >
                    {activeTab === 'join' ? 'Invite code' : 'Circle name'}
                  </label>
                  <input
                    id="circle-input"
                    required
                    minLength={activeTab === 'join' ? 6 : 3}
                    maxLength={activeTab === 'join' ? undefined : 30}
                    disabled={isLoading}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder={
                      activeTab === 'join'
                        ? 'Paste your invite code'
                        : 'e.g. Weekend training club'
                    }
                    className="w-full bg-surface-inset border border-border rounded-2xl px-4 py-4 text-base text-foreground placeholder:text-subtle outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all"
                  />
                  <p className="text-sm text-muted mt-3 leading-relaxed">
                    {activeTab === 'join'
                      ? 'Get an invite code from your circle leader.'
                      : 'Choose a name your team will recognise, from 3 to 30 characters.'}
                  </p>
                  {error && (
                    <p
                      role="alert"
                      className="text-sm text-accent-danger rounded-2xl border border-accent-danger/15 bg-accent-danger/5 p-4 mt-5 leading-relaxed"
                    >
                      {error}
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={isLoading || !inputValue.trim()}
                    aria-busy={isLoading}
                    className="btn-primary mt-7 w-full flex items-center justify-center gap-2.5 text-base disabled:opacity-40"
                  >
                    {isLoading ? (
                      <>
                        <Loader2
                          size={19}
                          className="animate-spin motion-reduce:animate-none"
                        />
                        {activeTab === 'join' ? 'Joining…' : 'Creating…'}
                      </>
                    ) : (
                      <>
                        {activeTab === 'join' ? 'Join circle' : 'Create circle'}
                        {activeTab === 'join' ? (
                          <ArrowRight size={19} />
                        ) : (
                          <Plus size={19} />
                        )}
                      </>
                    )}
                  </button>
                </form>
              </>
            ) : (
              <div>
                <div className="rounded-2xl bg-primary/[.05] border border-primary/15 p-4 flex items-center gap-3 mb-7">
                  <span className="shrink-0 w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                    <Check size={20} />
                  </span>
                  <p className="text-sm text-muted leading-relaxed">
                    All set. Share the invite code with your first teammate.
                  </p>
                </div>
                <p className="block text-sm font-semibold mb-3">
                  Your invite code
                </p>
                <div className="flex items-center gap-3 rounded-2xl bg-surface-inset border border-border p-3.5">
                  <code className="text-sm text-foreground break-all flex-1 select-all">
                    {createdCircleId}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopy}
                    aria-label="Copy invite code"
                    className="shrink-0 p-3 rounded-xl border border-border bg-surface-raised hover:bg-primary/5 text-primary"
                  >
                    {copyStatus === 'Invite code copied' ? (
                      <Check size={18} />
                    ) : (
                      <Copy size={18} />
                    )}
                  </button>
                </div>
                <p
                  aria-live="polite"
                  className="text-sm text-primary min-h-5 mt-3"
                >
                  {copyStatus}
                </p>
                <p className="text-sm text-muted leading-relaxed mt-5">
                  Teammates can enter this code under “Join a circle” on the
                  Circles page.
                </p>
                <button
                  onClick={handleClose}
                  className="btn-primary flex items-center justify-center gap-2.5 w-full mt-7 text-base"
                >
                  Done <ArrowRight size={19} />
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </dialog>
  );
}
