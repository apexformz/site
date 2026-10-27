'use client';

import React from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  Activity,
  ArrowUpRight,
  BarChart3,
  ScanLine,
  ShieldCheck,
  Check,
} from 'lucide-react';
import { Brand } from '@/components/ui/Brand';
import { ThemeToggle } from '@/components/ui/ThemeProvider';
import { Faq } from '@/components/ui/Faq';
import { Reveal } from '@/components/ui/Reveal';
import '@/styles/account.css';

export function AuthFrame({
  children,
  mode,
}: {
  children: React.ReactNode;
  mode: 'login' | 'register';
}) {
  const reducedMotion = useReducedMotion();
  return (
    <main className="auth-layout">
      <header className="auth-header">
        <Brand />
        <div className="auth-header-actions">
          <Link href="/" className="auth-back" aria-label="Back to ApexFormz">
            <ArrowLeft size={17} aria-hidden="true" />
            <span>Back to home</span>
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <div className="auth-content">
        <section className="auth-introduction" aria-label="About ApexFormz">
          <span className="auth-kicker">
            <Activity size={17} /> Training, with perspective
          </span>
          <h1>
            A clearer path
            <br />
            to your <span>personal best.</span>
          </h1>
          <p>
            Understand your movement. Refine your technique. See the progress in
            every session.
          </p>
          <div className="auth-scene" aria-hidden="true">
            <div className="auth-scene-aura" />
            <div className="auth-scene-back" />
            <div className="auth-scene-card">
              <div className="auth-scene-top">
                <div className="auth-scene-icon">
                  <ScanLine size={24} />
                </div>
                <span>Your training studio</span>
                <ArrowUpRight size={19} />
              </div>
              <div className="auth-scene-wave">
                <Activity size={100} strokeWidth={1.15} />
                <span className="auth-scene-wave-line" />
              </div>
              <div className="auth-scene-bottom">
                <span>Form. Balance. Control.</span>
                <span className="auth-scene-dots">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </div>
            <div className="auth-scene-chip">
              <span>
                <Check size={17} />
              </span>
              <div>
                <strong>A new perspective</strong>
                <small>Feedback as you move</small>
              </div>
            </div>
            <div className="auth-scene-brand">
              <img src="/logo.png" alt="" />
            </div>
          </div>
          <div className="auth-benefits">
            <span>
              <ScanLine size={18} /> Live form feedback
            </span>
            <span>
              <BarChart3 size={18} /> Progress you can follow
            </span>
          </div>
        </section>
        <section
          className="auth-form-section"
          aria-label={
            mode === 'login'
              ? 'Sign in to ApexFormz'
              : 'Create an ApexFormz account'
          }
        >
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="auth-form-wrap"
          >
            <div className="auth-form-heading">
              <span className="auth-kicker">
                {mode === 'login' ? 'Your training space' : 'Your next chapter'}
              </span>
              <h2>{mode === 'login' ? 'Welcome back.' : 'Make it yours.'}</h2>
              <p>
                {mode === 'login'
                  ? 'Sign in to pick up where you left off.'
                  : 'Create your athlete profile to start training.'}
              </p>
            </div>
            {children}
            <div className="auth-bottom-note">
              <ShieldCheck size={17} />
              <span>One account. All your progress.</span>
            </div>
          </motion.div>
        </section>
      </div>
      <section className="auth-help" aria-labelledby="auth-help-title">
        <Reveal className="grid lg:grid-cols-[.7fr_1.3fr] gap-7 lg:gap-16 border-t border-border/70 pt-10 sm:pt-14">
          <div>
            <p className="text-sm font-medium text-primary mb-4">
              Before you begin
            </p>
            <h2
              id="auth-help-title"
              className="text-2xl sm:text-3xl font-semibold tracking-tight"
            >
              A little more clarity.
            </h2>
            <p className="text-base leading-relaxed text-muted mt-5">
              Your account brings your sessions, progress, and training circles
              into one place.
            </p>
            <Link
              href="/technology"
              className="inline-flex items-center gap-2 text-sm font-semibold text-primary mt-6"
            >
              See how coaching works <ArrowUpRight size={17} />
            </Link>
          </div>
          <Faq
            items={[
              {
                question: 'What can I train with ApexFormz?',
                answer:
                  'Explore Squash, Taekwondo, Yoga, Cricket, Tennis, Running, and Boxing. Squash uses the ApexFormz Brain for positions, strokes, footwork, and recovery. Choose a movement to focus your analysis. Technique criteria remain provisional, and the Brain withholds scores when validation or visible evidence is insufficient.',
              },
              {
                question: 'Do I need to turn on my camera now?',
                answer:
                  'No camera is needed to create an account or browse your training space. When you open a training session, you choose when to enable the camera. Use a camera-enabled device with a modern browser, a stable connection, and enough well-lit space for the movement.',
              },
              {
                question: 'What happens to my training data?',
                answer:
                  'Camera frames remain in your browser. Squash tracking, recognition, and technique analysis run on your device; session summaries and analysis events can synchronize with your account. Other disciplines send movement landmarks to the coaching service. The live training flow does not upload camera video or request microphone audio.',
              },
            ]}
          />
        </Reveal>
      </section>
      <footer className="auth-footer">
        <span>ApexFormz</span>
        <span>Precision in motion.</span>
      </footer>
    </main>
  );
}
