'use client';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowUpRight,
  ArrowRight,
  ScanLine,
  Crosshair,
  TrendingUp,
  Check,
} from 'lucide-react';
import { PublicHeader } from '@/components/PublicHeader';
import { PerformanceVisual } from '@/components/PerformanceVisual';
import { HomeExperience } from '@/components/HomeExperience';
import { PublicFooter } from '@/components/PublicFooter';
export default function HomePage() {
  const reduce = useReducedMotion();
  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-5 focus:top-24 focus:z-50 focus:rounded-xl focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <PublicHeader />
      <main id="main" className="page-width">
        <section className="hero-grid">
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, ease: 'easeOut' }}
            className="relative z-10"
          >
            <div className="mb-7 inline-flex items-center gap-3 rounded-full border border-border/50 bg-surface/70 px-4 py-2.5 text-[13px] font-semibold text-muted shadow-sm">
              <span className="live-dot" />
              Your personal sports coach
            </div>
            <h1 className="hero-title">
              A better way
              <br />
              to <span className="text-primary">move.</span>
            </h1>
            <p className="hero-description mt-7">
              Understand your form. Find your rhythm. Build lasting progress
              with coaching that moves with you.
            </p>
            <div className="mt-9 flex flex-col gap-4 min-[420px]:flex-row">
              <Link href="/login" className="btn-primary">
                Start training <ArrowUpRight size={20} />
              </Link>
              <Link href="/sports" className="btn-secondary">
                Explore sports <ArrowRight size={19} />
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-[13px] text-muted">
              <span className="flex items-center gap-2">
                <Check size={16} className="text-primary" />
                Seven disciplines
              </span>
              <span className="flex items-center gap-2">
                <Check size={16} className="text-primary" />
                Just you and your camera
              </span>
            </div>
          </motion.div>
          <motion.div
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1 }}
            className="min-w-0"
          >
            <PerformanceVisual />
          </motion.div>
        </section>
        <section
          aria-label="Training capabilities"
          className="grid gap-5 pb-12 md:grid-cols-3 sm:pb-16"
        >
          {[
            {
              icon: ScanLine,
              title: 'See your movement',
              text: 'Bring your technique into focus with full-body pose tracking.',
            },
            {
              icon: Crosshair,
              title: 'Make every rep better',
              text: 'Simple, timely guidance to help you adjust and improve.',
            },
            {
              icon: TrendingUp,
              title: 'Build your momentum',
              text: 'Keep your sessions, milestones, and progress in one place.',
            },
          ].map((item) => (
            <Link key={item.title} href="/technology" className="feature-card">
              <span className="clay-icon h-14 w-14 shrink-0">
                <item.icon size={25} strokeWidth={1.5} />
              </span>
              <div>
                <h2>{item.title}</h2>
                <p>{item.text}</p>
              </div>
            </Link>
          ))}
        </section>
        <HomeExperience />
      </main>
      <PublicFooter />
    </div>
  );
}
