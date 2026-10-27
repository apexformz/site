'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  ArrowUpRight,
  Camera,
  Check,
  Focus,
  Layers3,
  Monitor,
  ScanLine,
  Search,
  ShieldCheck,
  Target,
  X,
} from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { PublicHeader } from '@/components/PublicHeader';
import { PublicFooter } from '@/components/PublicFooter';
import { SportCard } from '@/components/SportCard';
import { Reveal } from '@/components/ui/Reveal';
import { Faq } from '@/components/ui/Faq';
import { SPORTS, SPORT_CATEGORIES } from '@/lib/sports';
import { api } from '@/lib/api';

const questions = [
  {
    question: 'What does Squash training include?',
    answer:
      'The shared ApexFormz Brain provides a catalog of 184 movements, including static positions, strokes, footwork, and recovery. Trained recognition covers 68 static and 109 dynamic classes. The studio shows recognition confidence, movement phases, visibility, and evidence-aware assessments. Technique rubrics remain provisional.',
  },
  {
    question: 'What do I need to begin a session?',
    answer:
      'Use a browser with camera access and enough room to keep your full body visible. Load the Squash movement pack and models, choose a movement and camera setup, then enable your camera. Squash analysis runs on your device; an internet connection is needed for initial loading and account synchronization.',
  },
  {
    question: 'Can I explore the sports before creating an account?',
    answer:
      'Yes. Browse the catalog and movement libraries first. Squash sessions can run locally without an account. Sign in to synchronize supported sessions with your account; local-only results remain in the browser where you trained.',
  },
  {
    question: 'Can I switch between disciplines?',
    answer:
      'Yes. Return to the sports library and choose another discipline or movement for your next session. Your completed sessions remain together in your training history.',
  },
  {
    question: 'What does my session score tell me?',
    answer:
      'For Squash, recognition confidence and technique score are separate. A technique score appears only when the Brain has enough evidence and the selected coaching mode allows it. Strict mode withholds scores for provisional rubrics. Preview scores are experimental and do not measure overall playing ability.',
  },
  {
    question: 'Does the camera track the ball or racket?',
    answer:
      'The browser camera follows body landmarks. Equipment-dependent checks stay unavailable when racket or ball evidence is missing. Body motion alone cannot establish ball placement, contact, racket-face angle, or a rally outcome.',
  },
];

export default function SportsPage() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All sports');
  const [focusId, setFocusId] = useState(SPORTS[0].id);
  const [signedIn, setSignedIn] = useState(false);
  const [userName, setUserName] = useState<string>();
  useEffect(() => {
    if (!localStorage.getItem('access_token')) return;
    setSignedIn(true);
    let active = true;
    api
      .get('/users/me')
      .then((response) => {
        if (active) setUserName(response.data.data?.name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const search = query.trim().toLowerCase();
  const visibleSports = SPORTS.filter(
    (sport) =>
      (category === 'All sports' || sport.category === category) &&
      `${sport.title} ${sport.description} ${sport.focus}`
        .toLowerCase()
        .includes(search),
  );
  const focused = SPORTS.find((sport) => sport.id === focusId) || SPORTS[0];
  function handleTabKey(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = (index + 1) % SPORTS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index - 1 + SPORTS.length) % SPORTS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SPORTS.length - 1;
    else return;
    event.preventDefault();
    setFocusId(SPORTS[next].id);
    document.getElementById(`discipline-tab-${SPORTS[next].id}`)?.focus();
  }

  const content = (
    <>
      <Reveal className="mb-10 flex flex-wrap items-end justify-between gap-6 sm:mb-12">
        <div>
          <p className="mb-3 text-sm font-medium text-primary">
            Your training library
          </p>
          <h1 className="display-title text-[34px] leading-[1.15] tracking-[-.045em] sm:text-[46px]">
            Choose your discipline.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-[1.8] text-muted">
            Different sports. The same attention to how you move. Find a
            technique to focus on, bring it into view, and make your next
            session more intentional.
          </p>
        </div>
        <div
          className="flex items-center gap-3 rounded-[20px] border border-border bg-surface-raised px-5 py-4 text-sm text-muted"
          style={{ boxShadow: 'var(--shadow-card)' }}
        >
          <Camera size={22} strokeWidth={1.5} className="text-primary" />
          Just you and your camera
        </div>
      </Reveal>

      <Reveal className="mb-12 grid gap-5 md:grid-cols-3" delay={0.06}>
        {[
          {
            icon: Target,
            title: 'One clear focus',
            text: 'Choose a specific technique from a dedicated movement library.',
          },
          {
            icon: ScanLine,
            title: 'Feedback as you move',
            text: 'See body-position guidance while your camera is enabled.',
          },
          {
            icon: Layers3,
            title: 'A history that stays with you',
            text: 'Save completed sessions and revisit your form feedback.',
          },
        ].map((item) => (
          <div
            key={item.title}
            className="flex gap-4 rounded-[24px] border border-border/60 bg-surface/50 p-5 sm:p-6"
          >
            <span className="clay-icon h-12 w-12 shrink-0 !rounded-2xl">
              <item.icon size={22} strokeWidth={1.5} />
            </span>
            <div>
              <h2 className="text-base font-semibold tracking-tight">
                {item.title}
              </h2>
              <p className="mt-2 text-sm leading-[1.75] text-muted">
                {item.text}
              </p>
            </div>
          </div>
        ))}
      </Reveal>

      <section aria-label="Sports catalog">
        <div className="mb-9 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div
            className="flex flex-wrap gap-1.5 rounded-[22px] border border-border bg-surface-inset/65 p-2"
            aria-label="Filter sports by category"
          >
            {SPORT_CATEGORIES.map((item) => (
              <button
                key={item}
                aria-pressed={category === item}
                onClick={() => setCategory(item)}
                className={`relative rounded-2xl px-3 py-3 text-sm font-medium transition-colors sm:px-5 ${category === item ? 'text-foreground' : 'text-muted hover:text-foreground'}`}
              >
                {category === item && (
                  <motion.span
                    layoutId="catalog-category"
                    className="absolute inset-0 rounded-2xl border border-border bg-surface-raised"
                    style={{ boxShadow: 'var(--shadow-card)' }}
                    transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                  />
                )}
                <span className="relative">{item}</span>
              </button>
            ))}
          </div>
          <div className="relative w-full lg:max-w-[320px]">
            <Search
              size={19}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-subtle"
            />
            <input
              aria-label="Search sports"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sports or techniques"
              className="w-full rounded-[20px] border border-border bg-surface py-4 pl-12 pr-11 text-sm text-foreground outline-none transition placeholder:text-subtle focus:border-primary/50 focus:ring-4 focus:ring-primary/[.06]"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear sport search"
                className="absolute right-3.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted transition hover:bg-primary/10 hover:text-primary"
              >
                <X size={16} />
              </button>
            )}
          </div>
        </div>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <p className="text-base font-semibold tracking-tight">
            {category === 'All sports' ? 'Available disciplines' : category}
            <span className="ml-3 inline-flex min-w-7 items-center justify-center rounded-full bg-primary/[.08] px-2 py-1 text-xs font-medium text-primary">
              {visibleSports.length}
            </span>
          </p>
          <span className="text-sm text-subtle">
            Squash is connected to the ApexFormz Brain.
          </span>
        </div>
        <motion.div
          layout
          className="grid gap-5 sm:grid-cols-2 sm:gap-6 2xl:grid-cols-3"
        >
          <AnimatePresence mode="popLayout">
            {visibleSports.map((sport) => (
              <SportCard
                key={sport.id}
                {...sport}
                onClick={() => router.push(`/train/${sport.id}/setup`)}
              />
            ))}
          </AnimatePresence>
        </motion.div>
        {!visibleSports.length && (
          <div className="glass-card rounded-[28px] px-6 py-16 text-center">
            <span className="clay-icon mx-auto mb-7 flex h-16 w-16 items-center justify-center !rounded-[22px]">
              <Search size={27} strokeWidth={1.5} />
            </span>
            <h2 className="text-2xl font-semibold tracking-tight">
              No matching disciplines.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted">
              Try a sport name or choose a different category.
            </p>
            <button
              onClick={() => {
                setQuery('');
                setCategory('All sports');
              }}
              className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-primary"
            >
              Reset filters <ArrowRight size={17} />
            </button>
          </div>
        )}
      </section>

      <Reveal className="mt-20 sm:mt-24">
        <div className="mb-8 max-w-2xl">
          <p className="eyebrow mb-4">A closer look</p>
          <h2 className="display-title text-3xl sm:text-[40px]">
            Find the focus that fits your sport.
          </h2>
          <p className="mt-5 text-base leading-[1.8] text-muted">
            Explore what each library offers before you step into the training
            studio. Every session begins with a specific position or movement.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Explore discipline details"
          className="mb-6 flex flex-wrap gap-2"
        >
          {SPORTS.map((sport, index) => (
            <button
              key={sport.id}
              id={`discipline-tab-${sport.id}`}
              role="tab"
              aria-selected={focusId === sport.id}
              aria-controls={`discipline-panel-${sport.id}`}
              tabIndex={focusId === sport.id ? 0 : -1}
              onKeyDown={(event) => handleTabKey(event, index)}
              onClick={() => setFocusId(sport.id)}
              className={`relative rounded-2xl border px-4 py-3 text-sm font-semibold transition-colors sm:px-5 ${focusId === sport.id ? 'border-primary/20 text-primary' : 'border-border text-muted hover:text-foreground'}`}
            >
              {focusId === sport.id && (
                <motion.span
                  layoutId="discipline-focus"
                  className="absolute inset-0 rounded-2xl bg-primary/[.08]"
                  transition={{ duration: reduce ? 0 : 0.2 }}
                />
              )}
              <span className="relative">{sport.title}</span>
            </button>
          ))}
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={focused.id}
            id={`discipline-panel-${focused.id}`}
            role="tabpanel"
            aria-labelledby={`discipline-tab-${focused.id}`}
            tabIndex={0}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -6 }}
            transition={{ duration: reduce ? 0 : 0.18 }}
            className="glass-card grid gap-9 p-6 sm:p-9 lg:grid-cols-[1.3fr_1fr] lg:gap-14 lg:p-11"
          >
            <div>
              <div className="mb-7 flex flex-wrap items-center gap-4">
                <span className="clay-icon h-[72px] w-[72px] shrink-0 !rounded-[24px]">
                  <focused.icon size={31} strokeWidth={1.5} />
                </span>
                <div>
                  <p className="mb-1 text-sm text-primary">
                    {focused.id === 'squash'
                      ? 'ApexFormz Brain'
                      : focused.availability === 'experimental'
                      ? 'Experimental coaching'
                      : focused.category}
                  </p>
                  <h3 className="text-[28px] font-semibold tracking-tight">
                    {focused.title}
                  </h3>
                </div>
              </div>
              <p className="text-base leading-[1.85] text-muted">
                {focused.overview}
              </p>
              <Link
                href={`/train/${focused.id}/setup`}
                className="btn-primary mt-7"
              >
                Explore {focused.title.toLowerCase()} <ArrowUpRight size={18} />
              </Link>
            </div>
            <div className="rounded-[24px] border border-border/60 bg-surface-inset/50 p-5 sm:p-7">
              <p className="mb-5 text-sm font-semibold text-foreground">
                {focused.id === 'squash'
                  ? 'Explore the movement catalog'
                  : focused.availability === 'experimental'
                  ? 'Included position drills'
                  : 'A few places to begin'}
              </p>
              <ul className="space-y-4">
                {focused.movements.map((movement) => (
                  <li
                    key={movement}
                    className="flex items-start gap-3 text-sm leading-relaxed text-muted"
                  >
                    <span className="mt-0.5 rounded-full bg-primary/10 p-1 text-primary">
                      <Check size={13} />
                    </span>
                    {movement}
                  </li>
                ))}
              </ul>
              <p className="mt-6 border-t border-border pt-5 text-sm leading-[1.8] text-muted">
                {focused.sessionNote}
              </p>
              {focused.id === 'squash' && (
                <Link
                  href="/train/squash/setup"
                  className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary"
                >
                  Browse the complete Squash catalog <ArrowUpRight size={14} />
                </Link>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </Reveal>

      <Reveal className="mt-20 sm:mt-24">
        <div className="mb-9 max-w-2xl">
          <p className="eyebrow mb-4">Your training rhythm</p>
          <h2 className="display-title text-3xl sm:text-[40px]">
            From a clear intention to a useful session.
          </h2>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {[
            {
              n: '01',
              title: 'Choose a movement',
              text: 'Open a discipline, browse the available techniques, and pick the position or movement you want to work on.',
            },
            {
              n: '02',
              title: 'Bring your form into view',
              text: 'Set up your camera, make sure your body is visible, and begin a session when your coach is connected.',
            },
            {
              n: '03',
              title: 'Review and return',
              text: 'End the session to save its result. Read your feedback, then choose a focus for the next time you train.',
            },
          ].map((step) => (
            <div key={step.n} className="glass-card p-7 sm:p-8">
              <span className="mb-7 inline-block text-4xl font-medium tracking-tight text-primary/35">
                {step.n}
              </span>
              <h3 className="text-xl font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="mt-4 text-base leading-[1.8] text-muted">
                {step.text}
              </p>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal className="mt-12 grid gap-6 lg:grid-cols-2">
        <div className="glass-card p-7 sm:p-9">
          <span className="clay-icon mb-7 h-14 w-14 !rounded-[20px]">
            <Monitor size={26} strokeWidth={1.5} />
          </span>
          <h2 className="text-2xl font-semibold tracking-tight">
            A simple space to practice.
          </h2>
          <p className="mt-4 text-base leading-[1.8] text-muted">
            A connected browser, a camera, and a clear view of your movement are
            the essentials. Choose a position that gives the camera an
            unobstructed view of the joints you are practicing.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {['Camera access', 'Internet connection', 'Room to move'].map(
              (item) => (
                <span
                  key={item}
                  className="rounded-full border border-border bg-surface px-3.5 py-2 text-sm text-muted"
                >
                  {item}
                </span>
              ),
            )}
          </div>
        </div>
        <div className="glass-card p-7 sm:p-9">
          <span className="clay-icon mb-7 h-14 w-14 !rounded-[20px]">
            <ShieldCheck size={26} strokeWidth={1.5} />
          </span>
          <h2 className="text-2xl font-semibold tracking-tight">
            You choose when the camera starts.
          </h2>
          <p className="mt-4 text-base leading-[1.8] text-muted">
            Explore the library with your camera off. In the studio, enable it
            to see your position. Squash recognition and analysis run on your
            device. Saved session summaries and events can synchronize with
            your account; camera frames stay in the browser.
          </p>
          <Link
            href="/technology"
            className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-primary"
          >
            How the coaching works <ArrowRight size={16} />
          </Link>
        </div>
      </Reveal>

      <Reveal className="mt-20 border-t border-border/60 pt-12 sm:mt-24">
        <div className="mb-6 max-w-2xl">
          <p className="eyebrow mb-4">Before you begin</p>
          <h2 className="display-title text-3xl sm:text-[40px]">
            A few useful answers.
          </h2>
        </div>
        <Faq items={questions} />
      </Reveal>
      <Reveal className="mt-12 rounded-[28px] border border-border bg-surface-inset/50 p-7 sm:p-10">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              Make room for your next session.
            </h2>
            <p className="mt-3 text-base leading-relaxed text-muted">
              Start with one technique. See what you can learn from your
              movement.
            </p>
          </div>
          <Link
            href={signedIn ? '/dashboard' : '/register'}
            className="btn-primary"
          >
            {signedIn ? 'Your training overview' : 'Create your account'}{' '}
            <ArrowUpRight size={18} />
          </Link>
        </div>
      </Reveal>
    </>
  );
  return signedIn ? (
    <AppShell userName={userName} active="training" title="Sports library">
      {content}
    </AppShell>
  ) : (
    <div className="min-h-screen bg-background">
      <PublicHeader />
      <main className="page-width py-10 sm:py-14">{content}</main>
      <PublicFooter />
    </div>
  );
}
