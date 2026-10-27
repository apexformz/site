'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  ArrowUpRight,
  Camera,
  Check,
  CircleDot,
  Focus,
  Layers3,
  MoveUpRight,
  ScanLine,
  ShieldCheck,
  TrendingUp,
  Users,
} from 'lucide-react';
import { Reveal } from './ui/Reveal';
import { Faq } from './ui/Faq';

const features = [
  {
    name: 'Understand your form',
    icon: Focus,
    heading: 'See the adjustment. Feel the difference.',
    description:
      'A live pose overlay makes your position easier to understand. Joint-angle comparisons turn selected movements into focused cues, so you can work on one adjustment at a time.',
    details: [
      'Visual body tracking',
      'Movement-specific reference positions',
      'Feedback as you practice',
    ],
  },
  {
    name: 'Follow your progress',
    icon: TrendingUp,
    heading: 'Give every session a place to land.',
    description:
      'Your session summary brings form scores and feedback together. Return to your training history, review your activity, and use the last session to decide what to practice next.',
    details: [
      'Saved session summaries',
      'Personal streaks and experience points',
      'Your training history in one place',
    ],
  },
  {
    name: 'Find your people',
    icon: Users,
    heading: 'A routine feels better with company.',
    description:
      'Create a training circle or join one with an invite code. Keep your group together and see member profiles and personal streaks. Shared circle metrics are still in preview.',
    details: [
      'Create or join a circle',
      'A shared member space',
      'Individual consistency, together',
    ],
  },
];

function CoachingPreview({ selected }: { selected: number }) {
  const reduced = useReducedMotion();
  return (
    <div className="glass-card relative flex min-h-[385px] flex-col overflow-hidden p-6 sm:p-9">
      <div className="mb-7 flex items-center justify-between gap-3 text-sm text-muted">
        <span className="flex items-center gap-2">
          <span className="live-dot" />
          Inside your training space
        </span>
        <span className="rounded-full bg-surface-inset/70 px-3 py-1 text-xs">
          Illustration
        </span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={selected}
          initial={{ opacity: 0, y: reduced ? 0 : 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -8 }}
          transition={{ duration: reduced ? 0 : 0.24 }}
          className="flex flex-1 flex-col justify-center"
        >
          {selected === 0 ? (
            <>
              <div className="relative mx-auto w-full max-w-[330px] rounded-[26px] bg-surface-inset/60 px-7 py-5">
                <svg
                  viewBox="0 0 280 185"
                  className="h-48 w-full text-primary"
                  aria-label="Illustration of joint landmarks on a person holding a stance"
                  role="img"
                >
                  <defs>
                    <linearGradient id="pose-trail" x1="0" y1="0" x2="1" y2="1">
                      <stop stopColor="currentColor" stopOpacity=".18" />
                      <stop
                        offset="1"
                        stopColor="currentColor"
                        stopOpacity=".8"
                      />
                    </linearGradient>
                  </defs>
                  <circle
                    cx="140"
                    cy="27"
                    r="16"
                    fill="currentColor"
                    fillOpacity=".1"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M140 45 L140 101 M105 57 L175 57 M105 57 L78 87 L53 71 M175 57 L201 87 L226 71 M140 101 L111 113 L92 164 M140 101 L169 113 L187 164"
                    fill="none"
                    stroke="url(#pose-trail)"
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {[
                    [105, 57],
                    [175, 57],
                    [78, 87],
                    [201, 87],
                    [140, 101],
                    [111, 113],
                    [169, 113],
                    [92, 164],
                    [187, 164],
                  ].map(([cx, cy]) => (
                    <circle
                      key={`${cx}-${cy}`}
                      cx={cx}
                      cy={cy}
                      r="5"
                      fill="rgb(var(--surface))"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  ))}
                  <motion.path
                    d="M68 117 Q86 128 105 126"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray="3 5"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: reduced ? 0 : 1 }}
                  />
                </svg>
              </div>
              <div className="mx-auto -mt-3 flex w-[90%] items-center gap-3 rounded-2xl border border-border/50 bg-surface-raised p-4 shadow-sm">
                <span className="clay-icon h-10 w-10 shrink-0 !rounded-xl">
                  <ScanLine size={20} />
                </span>
                <div>
                  <p className="text-sm font-semibold">
                    Small adjustments. Clearer technique.
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Example feedback: soften your knees.
                  </p>
                </div>
              </div>
            </>
          ) : selected === 1 ? (
            <div className="rounded-3xl border border-border/50 bg-surface/50 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted">Your practice, over time</p>
                  <p className="mt-2 text-2xl font-semibold tracking-tight">
                    Keep showing up.
                  </p>
                </div>
                <TrendingUp className="text-primary" />
              </div>
              <div
                className="mt-9 flex h-32 items-end gap-3"
                aria-label="Illustrative session history chart"
              >
                {[35, 53, 45, 70, 63, 82, 91].map((height, index) => (
                  <motion.div
                    key={index}
                    className="flex-1 rounded-t-lg bg-primary/20 last:bg-primary/70"
                    initial={{ height: 8 }}
                    animate={{ height: `${height}%` }}
                    transition={{
                      duration: reduced ? 0 : 0.6,
                      delay: reduced ? 0 : index * 0.05,
                    }}
                  />
                ))}
              </div>
              <div className="mt-4 flex justify-between border-t border-border/60 pt-4 text-xs text-muted">
                <span>First session</span>
                <span>Your next milestone</span>
              </div>
            </div>
          ) : (
            <div className="rounded-3xl border border-border/50 bg-surface/50 p-6 text-center">
              <div className="mx-auto mb-6 flex w-fit -space-x-3">
                {[Users, Focus, TrendingUp].map((Icon, index) => (
                  <motion.span
                    key={index}
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: reduced ? 0 : index * 0.1 }}
                    className="grid h-16 w-16 place-items-center rounded-full border-4 border-surface bg-surface-inset text-primary"
                  >
                    <Icon size={24} strokeWidth={1.5} />
                  </motion.span>
                ))}
              </div>
              <p className="text-2xl font-semibold tracking-tight">
                Your circle. Your rhythm.
              </p>
              <p className="mx-auto mt-3 max-w-xs text-sm leading-relaxed text-muted">
                A home for the people who help you keep going.
              </p>
              <div className="mt-6 flex items-center justify-center gap-2 rounded-xl bg-primary/5 p-3 text-sm text-primary">
                <Users size={16} />
                Connect with an invite code
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export function HomeExperience() {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const reduced = useReducedMotion();
  return (
    <>
      <section
        id="how-it-works"
        className="marketing-section border-t border-border/50"
      >
        <Reveal className="mb-12 grid gap-6 lg:grid-cols-2 lg:items-end">
          <div>
            <p className="eyebrow mb-4">A simple start</p>
            <h2 className="section-title">
              From camera on
              <br />
              to confidence in motion.
            </h2>
          </div>
          <p className="max-w-lg text-lg leading-relaxed text-muted lg:justify-self-end">
            No wearable setup. Choose a movement, give your camera a clear view,
            and build your practice around feedback you can act on.
          </p>
        </Reveal>
        <div className="grid gap-5 md:grid-cols-3">
          {[
            {
              icon: CircleDot,
              title: 'Choose your focus',
              text: 'Explore the sports, select a supported movement, and look through the reference before you begin.',
              label: '01 / Find your movement',
            },
            {
              icon: Camera,
              title: 'Find your frame',
              text: 'Set your device on a stable surface. Step back until your full body is visible, with space to move comfortably.',
              label: '02 / Set up your space',
            },
            {
              icon: MoveUpRight,
              title: 'Practice with purpose',
              text: 'Follow the pose overlay and coaching cues. Finish the session to save your summary and plan your next one.',
              label: '03 / Move, review, repeat',
            },
          ].map((step, index) => (
            <Reveal
              key={step.title}
              delay={index * 0.08}
              className="glass-card p-7 sm:p-9"
            >
              <div className="mb-9 flex items-center justify-between gap-3">
                <span className="clay-icon h-16 w-16">
                  <step.icon size={27} strokeWidth={1.5} />
                </span>
                <span className="text-sm text-subtle">0{index + 1}</span>
              </div>
              <h3 className="mb-4 text-xl font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="text-base leading-relaxed text-muted">
                {step.text}
              </p>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="marketing-section">
        <Reveal className="mb-10">
          <p className="eyebrow mb-4">More than a session</p>
          <h2 className="section-title max-w-3xl">
            A clearer picture of how you move. A reason to keep going.
          </h2>
        </Reveal>
        <div
          role="tablist"
          aria-label="Explore product features"
          className="mb-10 flex flex-col gap-2 rounded-[24px] border border-border/50 bg-surface-inset/50 p-2 md:w-fit md:flex-row"
        >
          {features.map((feature, index) => (
            <button
              key={feature.name}
              id={`${id}-tab-${index}`}
              role="tab"
              aria-selected={selected === index}
              aria-controls={`${id}-panel-${index}`}
              tabIndex={selected === index ? 0 : -1}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => {
                if (
                  ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)
                ) {
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? 2
                        : (selected + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
                  setSelected(next);
                  document.getElementById(`${id}-tab-${next}`)?.focus();
                }
              }}
              className={`relative flex items-center gap-3 rounded-[18px] px-5 py-3.5 text-left text-sm font-semibold ${selected === index ? 'text-foreground' : 'text-muted hover:text-primary'}`}
            >
              {selected === index && (
                <motion.span
                  layoutId={`${id}-feature-pill`}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 320, damping: 30 }
                  }
                  className="absolute inset-0 rounded-[18px] bg-surface shadow-sm"
                />
              )}
              <feature.icon size={18} className="relative" />
              <span className="relative">{feature.name}</span>
            </button>
          ))}
        </div>
        <div
          id={`${id}-panel-${selected}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${selected}`}
          className="grid items-center gap-10 lg:grid-cols-2 lg:gap-20"
        >
          <div>
            <h3 className="max-w-lg text-3xl font-semibold leading-tight tracking-[-.035em] sm:text-4xl">
              {features[selected].heading}
            </h3>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
              {features[selected].description}
            </p>
            <ul className="mt-7 space-y-4">
              {features[selected].details.map((detail) => (
                <li key={detail} className="flex items-center gap-3 text-base">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <Check size={14} />
                  </span>
                  {detail}
                </li>
              ))}
            </ul>
            <Link
              href={selected === 2 ? '/register' : '/technology'}
              className="mt-8 inline-flex items-center gap-3 font-semibold text-primary"
            >
              {selected === 2 ? 'Start your circle' : 'Explore the technology'}
              <ArrowRight size={18} />
            </Link>
          </div>
          <CoachingPreview selected={selected} />
        </div>
      </section>

      <section className="marketing-section">
        <Reveal className="glass-card overflow-hidden p-7 sm:p-12 lg:p-16">
          <div className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:items-center">
            <div>
              <p className="eyebrow mb-4">Your sport. Your starting point.</p>
              <h2 className="section-title">
                Different disciplines.
                <br />
                One place to grow.
              </h2>
              <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted">
                From a balanced squash stance to controlled taekwondo technique
                and mindful yoga positions, make room for the way you like to
                move.
              </p>
              <Link href="/sports" className="btn-primary mt-8">
                Explore all sports <ArrowUpRight size={19} />
              </Link>
            </div>
            <div className="space-y-3">
              {[
                {
                  name: 'Squash',
                  note: 'Positions, strokes, footwork & recovery',
                  tag: 'ApexFormz Brain',
                  href: 'squash',
                },
                {
                  name: 'Taekwondo',
                  note: 'Stances, kicks & movement control',
                  tag: 'Martial arts',
                  href: 'taekwondo',
                },
                {
                  name: 'Yoga',
                  note: 'Alignment, balance & stillness',
                  tag: 'Mindful movement',
                  href: 'yoga',
                },
              ].map((sport, index) => (
                <Link
                  href={`/train/${sport.href}/setup`}
                  key={sport.name}
                  className="group flex items-center gap-4 rounded-[22px] border border-border/50 bg-surface/60 p-5 transition duration-300 hover:-translate-y-1 hover:bg-surface-raised"
                >
                  <span className="clay-icon h-12 w-12 shrink-0 !rounded-2xl text-lg font-semibold">
                    0{index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="text-xl font-semibold tracking-tight">
                        {sport.name}
                      </h3>
                      <span className="text-xs text-primary">{sport.tag}</span>
                    </div>
                    <p className="mt-1 text-sm text-muted">{sport.note}</p>
                  </div>
                  <ArrowUpRight
                    size={19}
                    className="shrink-0 text-subtle transition group-hover:text-primary"
                  />
                </Link>
              ))}
            </div>
          </div>
        </Reveal>
      </section>

      <section className="marketing-section grid gap-12 lg:grid-cols-[.85fr_1.15fr] lg:gap-24">
        <Reveal>
          <span className="clay-icon mb-8 h-16 w-16">
            <Layers3 size={28} strokeWidth={1.4} />
          </span>
          <p className="eyebrow mb-4">Built to make movement visible</p>
          <h2 className="section-title">
            Computer vision.
            <br />
            Human-sized feedback.
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-muted">
            Your browser detects body landmarks with MediaPipe. The coaching
            service compares angles and supported movement phases with reference
            guides, then returns form feedback to your session.
          </p>
          <Link
            href="/technology"
            className="mt-7 inline-flex items-center gap-3 font-semibold text-primary"
          >
            See what happens behind the camera <ArrowRight size={18} />
          </Link>
        </Reveal>
        <div className="space-y-6">
          {[
            {
              icon: ScanLine,
              title: 'A familiar camera becomes a new perspective.',
              text: 'Pose tracking runs in your browser. Landmark coordinates go to the coaching service for analysis; the coaching pipeline does not send camera video.',
            },
            {
              icon: Focus,
              title: 'The focus changes with the movement.',
              text: 'Each supported drill has its own reference. Static alignment and supported dynamic sequences use different analysis paths, so the feedback has context.',
            },
            {
              icon: ShieldCheck,
              title: 'Clarity about what the system can see.',
              text: 'Camera angle, lighting and visibility affect results. Form scores are reference comparisons—not a diagnosis or a professional assessment. Session records include pose data and feedback.',
            },
          ].map((item, index) => (
            <Reveal
              key={item.title}
              delay={index * 0.08}
              className="flex gap-5 border-b border-border/50 pb-7 last:border-0"
            >
              <item.icon
                size={25}
                strokeWidth={1.5}
                className="mt-1 shrink-0 text-primary"
              />
              <div>
                <h3 className="mb-3 text-lg font-semibold tracking-tight">
                  {item.title}
                </h3>
                <p className="text-base leading-relaxed text-muted">
                  {item.text}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="marketing-section grid gap-8 border-t border-border/50 lg:grid-cols-[.75fr_1.25fr] lg:gap-20">
        <Reveal>
          <p className="eyebrow mb-4">Before your first session</p>
          <h2 className="section-title">
            A few things
            <br />
            worth knowing.
          </h2>
        </Reveal>
        <Faq
          items={[
            {
              question: 'What do I need to start?',
              answer:
                'A device with a camera, a supported modern browser, an internet connection and enough clear space to move safely. Stable positioning, even lighting and a full-body view help the tracker. Create an account to save sessions and build your history.',
            },
            {
              question: 'Is this useful if I am new to a sport?',
              answer:
                'You can begin with a supported position and its reference guide, then use the feedback to notice alignment. ApexFormz supports your practice; it does not replace instruction from a qualified coach. Start with movements you can perform comfortably.',
            },
            {
              question: 'What does Squash training include?',
              answer:
                'Explore 184 movements with the on-device ApexFormz Brain. Trained recognition covers 68 static and 109 dynamic classes, alongside movement phases, visibility checks, and technique assessments. Technique criteria remain provisional, so strict mode withholds unsupported scores and corrections. Ball and racket evidence are required for equipment-dependent checks.',
            },
            {
              question: 'What happens to my camera and session data?',
              answer:
                'Camera frames stay in your browser. Squash tracking, recognition, and analysis run on your device; session summaries and analysis events can synchronize with your account. Other disciplines use the coaching service to analyse movement landmarks. Camera permission is requested when you enable the camera, and the stream stops when you leave training.',
            },
            {
              question: 'Can I choose a day or night theme?',
              answer:
                'Yes. Use the sun or moon control in the header. Your choice is saved on this device for the public pages and account views. The Squash training studio uses a dark camera workspace.',
            },
          ]}
        />
      </section>
      <Reveal className="mb-20 rounded-[32px] border border-primary/15 bg-primary/[.045] px-7 py-12 text-center sm:px-12 sm:py-16">
        <p className="eyebrow mb-4">Make room for better movement</p>
        <h2 className="section-title mx-auto max-w-3xl">
          Your next session starts
          <br />
          with a little more insight.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-lg text-muted">
          Choose your sport. Find your focus. Take the next step with ApexFormz.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Link href="/register" className="btn-primary">
            Create your account <ArrowUpRight size={19} />
          </Link>
          <Link href="/sports" className="btn-secondary">
            Find your sport <ArrowRight size={18} />
          </Link>
        </div>
      </Reveal>
    </>
  );
}
