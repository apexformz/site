'use client';

import { useState } from 'react';
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from 'framer-motion';
import { ArrowRight, Camera, Check, Cpu, ScanLine } from 'lucide-react';

const stages = [
  {
    title: 'Your camera',
    icon: Camera,
    location: 'On your device',
    heading: 'Start with the movement.',
    description:
      'Your browser receives the camera view after you give permission. A clear, full-body view helps the tracker see the joints used by your exercise.',
  },
  {
    title: 'Your landmarks',
    icon: ScanLine,
    location: 'Tracked in your browser',
    heading: 'Turn movement into landmarks.',
    description:
      'For Squash, MediaPipe Pose Landmarker estimates body landmarks in the Brain worker. Coordinates and visibility information help the Brain track the athlete and decide whether the view supports analysis.',
  },
  {
    title: 'Your feedback',
    icon: Cpu,
    location: 'Squash analysis on your device',
    heading: 'Bring the next adjustment into focus.',
    description:
      'The Squash Brain recognizes movements, follows phases, and evaluates available evidence on your device. It shows eligible scores and cues, or explains why feedback is withheld. Session summaries and events can synchronize with your account.',
  },
];
const points = [
  [160, 46],
  [160, 76],
  [124, 88],
  [196, 88],
  [104, 126],
  [220, 117],
  [87, 159],
  [246, 139],
  [139, 143],
  [181, 143],
  [127, 190],
  [202, 181],
  [114, 229],
  [225, 224],
];
const segments = [
  [0, 1],
  [1, 2],
  [1, 3],
  [2, 4],
  [4, 6],
  [3, 5],
  [5, 7],
  [2, 8],
  [3, 9],
  [8, 9],
  [8, 10],
  [10, 12],
  [9, 11],
  [11, 13],
];

export function TechnologyFlow() {
  const [active, setActive] = useState(0);
  const reducedMotion = useReducedMotion();
  const stage = stages[active];
  return (
    <div className="glass-card p-5 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-7">
        <span className="text-sm font-medium text-muted">
          Follow the Squash coaching loop
        </span>
        <span className="rounded-full bg-primary/[.06] px-3 py-1.5 text-sm text-primary">
          Interactive illustration
        </span>
      </div>
      <LayoutGroup id="technology-flow">
        <div
          className="grid grid-cols-1 min-[420px]:grid-cols-3 gap-2 rounded-[22px] bg-surface-inset/60 p-2"
          aria-label="Explore the coaching stages"
        >
          {stages.map((item, index) => (
            <button
              key={item.title}
              type="button"
              aria-pressed={active === index}
              onClick={() => setActive(index)}
              className={`relative flex min-[420px]:flex-col sm:flex-row items-center justify-center gap-2 rounded-2xl px-2 py-3.5 text-sm font-medium ${active === index ? 'text-primary' : 'text-muted'}`}
            >
              {active === index && (
                <motion.span
                  layoutId="flow-selection"
                  className="absolute inset-0 rounded-2xl bg-surface-raised border border-border/50 shadow-sm"
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 360, damping: 32 }
                  }
                />
              )}
              <item.icon
                size={19}
                strokeWidth={1.7}
                className="relative shrink-0"
              />
              <span className="relative text-center">{item.title}</span>
            </button>
          ))}
        </div>
      </LayoutGroup>
      <div className="grid md:grid-cols-[1fr_1.05fr] items-center gap-7 sm:gap-9 mt-8">
        <div
          className="relative rounded-[26px] border border-border/70 bg-surface-inset/35 p-4 overflow-hidden"
          aria-hidden="true"
        >
          <span className="absolute top-4 left-4 rounded-full border border-border/70 bg-surface/80 px-3 py-1 text-sm text-muted">
            {active === 0
              ? 'Camera view'
              : active === 1
                ? 'Pose landmarks'
                : 'Form analysis'}
          </span>
          <svg
            viewBox="0 0 320 270"
            className="w-full h-auto text-primary mt-4"
          >
            <path
              d="M48 64 V43 Q48 31 60 31 H82 M238 31 H260 Q272 31 272 43 V64 M48 207 V230 Q48 242 60 242 H82 M238 242 H260 Q272 242 272 230 V207"
              fill="none"
              stroke="currentColor"
              strokeOpacity=".18"
              strokeWidth="2"
              strokeLinecap="round"
            />
            {segments.map(([from, to], index) => (
              <motion.line
                key={`body-${index}`}
                x1={points[from][0]}
                y1={points[from][1]}
                x2={points[to][0]}
                y2={points[to][1]}
                stroke="currentColor"
                strokeWidth={active === 0 ? 16 : 3}
                strokeLinecap="round"
                animate={{ opacity: active === 0 ? 0.13 : 0.52 }}
                transition={{ duration: reducedMotion ? 0 : 0.3 }}
              />
            ))}
            <circle
              cx="160"
              cy="43"
              r="15"
              fill="rgb(var(--primary) / .08)"
              stroke="currentColor"
              strokeOpacity=".4"
              strokeWidth="2"
            />
            {active > 0 &&
              points
                .slice(1)
                .map(([cx, cy], index) => (
                  <motion.circle
                    key={`joint-${index}`}
                    cx={cx}
                    cy={cy}
                    r="4"
                    fill="rgb(var(--surface-raised))"
                    stroke="currentColor"
                    strokeWidth="2"
                    initial={reducedMotion ? false : { opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{
                      delay: reducedMotion ? 0 : index * 0.025,
                      duration: 0.2,
                    }}
                  />
                ))}
            {active === 0 && (
              <motion.line
                x1="55"
                x2="265"
                y1="60"
                y2="60"
                stroke="currentColor"
                strokeOpacity=".45"
                strokeWidth="1.5"
                className="motion-reduce:hidden"
                initial={{ y: 0, opacity: 0 }}
                animate={
                  reducedMotion
                    ? { y: 0, opacity: 0 }
                    : { y: [0, 155], opacity: [0, 0.65, 0] }
                }
                transition={{
                  duration: reducedMotion ? 0 : 2,
                  ease: 'easeInOut',
                }}
              />
            )}
            {active === 2 && (
              <motion.path
                d="M194 177 Q211 186 202 199"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="3 4"
                initial={reducedMotion ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.5 }}
              />
            )}
          </svg>
          <div className="flex items-center justify-center gap-2 pb-2 text-sm text-muted">
            <ScanLine size={16} />
            {active === 0
              ? 'Full-body view'
              : active === 1
                ? 'Position and visibility'
                : 'Exercise-specific cues'}
          </div>
        </div>
        <div
          className="min-h-[230px] flex flex-col justify-center"
          aria-live="polite"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              initial={{ opacity: 0, y: reducedMotion ? 0 : 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.2 }}
            >
              <p className="text-sm font-medium text-primary mb-4">
                {stage.location}
              </p>
              <h3 className="text-2xl font-semibold tracking-tight leading-snug">
                {stage.heading}
              </h3>
              <p className="text-base text-muted leading-relaxed mt-4">
                {stage.description}
              </p>
            </motion.div>
          </AnimatePresence>
          <div className="flex items-center gap-2 mt-6 text-sm text-subtle">
            <Check size={17} className="text-primary" />
            {active < 2
              ? 'Select the next step to explore'
              : 'Feedback supported by the available evidence'}
            {active < 2 && <ArrowRight size={15} />}
          </div>
        </div>
      </div>
    </div>
  );
}
