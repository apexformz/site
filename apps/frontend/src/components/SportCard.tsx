'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, LucideIcon } from 'lucide-react';
import { Sport } from '@smartcoach/types';

interface SportCardProps {
  id: Sport;
  title: string;
  description: string;
  icon: LucideIcon;
  availability?: 'available' | 'experimental';
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  focus?: string;
  onClick: () => void;
}

export function SportCard({
  id,
  title,
  description,
  icon: Icon,
  difficulty,
  availability = 'available',
  onClick,
}: SportCardProps) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      layout="position"
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      whileHover={reduce ? undefined : { y: -6, rotateX: 1.5, rotateY: -1.5 }}
      whileTap={reduce ? undefined : { scale: 0.985 }}
      transition={{ duration: 0.25 }}
      style={{
        background: 'var(--panel-fill)',
        boxShadow: 'var(--shadow-card)',
        transformPerspective: 1100,
      }}
      onClick={onClick}
      className="group relative flex h-full min-h-[300px] flex-col overflow-hidden rounded-[28px] border border-border p-6 text-left transition-colors hover:border-primary/30 sm:p-7"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/[.035] blur-2xl transition-opacity group-hover:opacity-80"
      />
      <div className="relative mb-7 flex w-full items-center justify-between gap-4">
        <div className="relative h-[84px] w-[88px] shrink-0" aria-hidden="true">
          <span className="absolute bottom-0 left-1 h-[70px] w-[70px] rotate-[-12deg] rounded-[22px] border border-border bg-surface-inset" />
          <span className="absolute bottom-1 left-2 h-[70px] w-[70px] rotate-[8deg] rounded-[22px] border border-primary/10 bg-primary/[.07]" />
          <span className="clay-icon absolute left-0 top-0 flex h-[74px] w-[74px] items-center justify-center !rounded-[24px] text-primary transition-transform duration-300 group-hover:-translate-y-1 group-hover:rotate-[-4deg]">
            <Icon size={32} strokeWidth={1.5} />
          </span>
        </div>
        <span className="rounded-full border border-border bg-surface/70 px-3.5 py-2 text-xs font-medium text-muted">
          {availability === 'experimental' ? 'Experimental' : difficulty}
        </span>
      </div>
      <div className="relative">
        <h3 className="mb-3 text-[22px] font-semibold tracking-[-.035em] text-foreground">
          {title}
        </h3>
        <p className="max-w-sm text-sm leading-[1.75] text-muted">
          {description}
        </p>
      </div>
      <div className="relative mt-auto flex w-full items-center justify-between gap-4 pt-7">
        <span className="text-sm font-medium text-muted transition-colors group-hover:text-primary">
          Explore movements
        </span>
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-raised text-primary transition-transform group-hover:-rotate-6">
          <ArrowUpRight size={17} />
        </span>
      </div>
      <svg
        aria-hidden="true"
        viewBox="0 0 120 120"
        className="pointer-events-none absolute right-[-24px] top-10 h-32 w-32 text-primary opacity-[.035]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      >
        {['squash', 'tennis', 'football', 'cricket'].includes(id) ? (
          <>
            <rect x="20" y="15" width="80" height="90" rx="10" />
            <path d="M20 60h80M60 15v90" />
            <circle cx="60" cy="60" r="18" />
          </>
        ) : (
          <>
            <circle cx="60" cy="60" r="45" />
            <circle cx="60" cy="60" r="30" />
            <path d="M60 15v90M15 60h90" />
          </>
        )}
      </svg>
    </motion.button>
  );
}
