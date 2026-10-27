'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowUpRight,
  Camera,
  Check,
  Focus,
  MoveUpRight,
  Search,
  ShieldCheck,
  Target,
} from 'lucide-react';
import { Sport } from '@smartcoach/types';
import { Brand } from '@/components/ui/Brand';
import { ThemeToggle } from '@/components/ui/ThemeProvider';
import BrainSetup from '@/components/brain/BrainSetup';

const SPORT_CONFIG: Record<
  string,
  {
    title: string;
    description: string;
    poses: {
      id: string;
      name: string;
      description: string;
      difficulty: 'Beginner' | 'Intermediate' | 'Pro';
    }[];
  }
> = {
  cricket: {
    title: 'Cricket Mastery',
    description:
      'Refine your technique with targeted shot and delivery analysis.',
    poses: [
      {
        id: 'batting_stance',
        name: 'Batting Stance',
        description: 'Optimize your balance and head position.',
        difficulty: 'Beginner',
      },
      {
        id: 'bowling_loadup',
        name: 'Bowling Load-up',
        description: 'Sync your shoulder and jump-off.',
        difficulty: 'Intermediate',
      },
      {
        id: 'fielding_ready',
        name: 'Fielding Ready',
        description: 'Stay low and reactive for catches.',
        difficulty: 'Beginner',
      },
      {
        id: 'cover_drive',
        name: 'Cover Drive',
        description: 'Perfect the elbow-head alignment.',
        difficulty: 'Intermediate',
      },
      {
        id: 'pull_shot',
        name: 'Pull Shot',
        description: 'Analysis of weight transfer and pivot.',
        difficulty: 'Intermediate',
      },
      {
        id: 'wicket_keeping',
        name: 'Wicket Keeping',
        description: 'Deep crouch and hand positioning.',
        difficulty: 'Intermediate',
      },
      {
        id: 'spin_release',
        name: 'Spin Release',
        description: 'Focus on wrist flick and follow-through.',
        difficulty: 'Pro',
      },
      {
        id: 'backfoot_defense',
        name: 'Backfoot Defense',
        description: 'Solidify your defensive wall.',
        difficulty: 'Beginner',
      },
      {
        id: 'slip_catching',
        name: 'Slip Catching',
        description: 'Refine the low-capture reflex.',
        difficulty: 'Intermediate',
      },
      {
        id: 'sweep_shot',
        name: 'Sweep Shot',
        description: 'Balance check for the sweep.',
        difficulty: 'Pro',
      },
    ],
  },
  tennis: {
    title: 'Tennis Precision',
    description: 'Master the court with AI-guided stroke analysis.',
    poses: [
      {
        id: 'serve_trophy',
        name: 'Serve Trophy',
        description: "Find the explosive 'Trophy Pose'.",
        difficulty: 'Intermediate',
      },
      {
        id: 'forehand_top',
        name: 'Forehand Top',
        description: 'Wrist lag and shoulder rotation.',
        difficulty: 'Beginner',
      },
      {
        id: 'ready_position',
        name: 'Ready Position',
        description: 'Weight distribution for speed.',
        difficulty: 'Beginner',
      },
      {
        id: 'backhand_split',
        name: 'Backhand Split',
        description: 'Timing on the split step.',
        difficulty: 'Intermediate',
      },
      {
        id: 'volley_ready',
        name: 'Volley Ready',
        description: 'Compact form for net play.',
        difficulty: 'Beginner',
      },
      {
        id: 'overhead_smash',
        name: 'Overhead Smash',
        description: 'Full extension and timing check.',
        difficulty: 'Pro',
      },
      {
        id: 'return_stance',
        name: 'Return Stance',
        description: 'Reactive posture for power serves.',
        difficulty: 'Intermediate',
      },
      {
        id: 'slice_backhand',
        name: 'Slice Backhand',
        description: 'Angle and follow-through check.',
        difficulty: 'Intermediate',
      },
      {
        id: 'half_volley',
        name: 'Half Volley',
        description: 'Low balance and soft hands.',
        difficulty: 'Pro',
      },
      {
        id: 'drop_shot',
        name: 'Drop Shot',
        description: 'Deception and wrist control.',
        difficulty: 'Pro',
      },
    ],
  },
  yoga: {
    title: 'Yoga Flow',
    description:
      'Develop control, stability, and alignment across core positions.',
    poses: [
      {
        id: 'warrior_2',
        name: 'Warrior II',
        description: 'Focus on arm level and knee alignment.',
        difficulty: 'Beginner',
      },
      {
        id: 'squats',
        name: 'Yoga Squats',
        description: 'Improve lower body strength and mobility.',
        difficulty: 'Beginner',
      },
      {
        id: 'tree_pose',
        name: 'Tree Pose',
        description: 'Master vertical balance and core.',
        difficulty: 'Intermediate',
      },
      {
        id: 'downward_dog',
        name: 'Downward Dog',
        description: 'Spine inversion and hip elevation.',
        difficulty: 'Intermediate',
      },
      {
        id: 'triangle_pose',
        name: 'Triangle Pose',
        description: 'Lateral stretch and hand placement.',
        difficulty: 'Intermediate',
      },
      {
        id: 'cobra_pose',
        name: 'Cobra Pose',
        description: 'Upper back strength and gaze.',
        difficulty: 'Beginner',
      },
      {
        id: 'plank_pose',
        name: 'Plank Pose',
        description: 'Perfect horizontal core alignment.',
        difficulty: 'Beginner',
      },
      {
        id: 'bridge_pose',
        name: 'Bridge Pose',
        description: 'Glute activation and shoulder base.',
        difficulty: 'Beginner',
      },
      {
        id: 'childs_pose',
        name: "Child's Pose",
        description: 'Restorative depth and relaxation.',
        difficulty: 'Beginner',
      },
      {
        id: 'cat_cow',
        name: 'Cat-Cow Flow',
        description: 'Spinal mobility and breath sync.',
        difficulty: 'Beginner',
      },
      {
        id: 'chair_pose',
        name: 'Chair Pose',
        description: 'Quad endurance and alignment.',
        difficulty: 'Intermediate',
      },
    ],
  },
  running: {
    title: 'Running Form',
    description: 'Drill down into your biomechanics for maximum efficiency.',
    poses: [
      {
        id: 'mid_stride',
        name: 'Mid-Stride',
        description: 'Analyze peak velocity arm pump.',
        difficulty: 'Intermediate',
      },
      {
        id: 'starting_block',
        name: 'Starting Block',
        description: 'Explosive 45-degree start angle.',
        difficulty: 'Pro',
      },
      {
        id: 'sprint_form',
        name: 'Sprint Form',
        description: 'Knee height and foot strike.',
        difficulty: 'Pro',
      },
      {
        id: 'heel_strike',
        name: 'Heel Strike Check',
        description: 'Ensure safe impact transition.',
        difficulty: 'Intermediate',
      },
      {
        id: 'knee_drive',
        name: 'High Knee Drive',
        description: 'Power generation technique.',
        difficulty: 'Pro',
      },
      {
        id: 'arm_swing',
        name: 'Arm Swing Path',
        description: 'Minimize lateral energy loss.',
        difficulty: 'Beginner',
      },
      {
        id: 'uphill_lean',
        name: 'Uphill Lean',
        description: 'Center of mass for climbing.',
        difficulty: 'Intermediate',
      },
      {
        id: 'downhill_brake',
        name: 'Downhill Braking',
        description: 'Impact management and control.',
        difficulty: 'Intermediate',
      },
      {
        id: 'recovery_phase',
        name: 'Recovery Mechanics',
        description: 'Efficient leg swing throughput.',
        difficulty: 'Pro',
      },
      {
        id: 'posture_check',
        name: 'Vertical Posture',
        description: 'Maintain core during fatigue.',
        difficulty: 'Beginner',
      },
    ],
  },
  boxing: {
    title: 'Boxing Performance',
    description: 'Sharpen your strikes and defensive architecture.',
    poses: [
      {
        id: 'guard_stance',
        name: 'Guard Stance',
        description: 'AI checks chin and glove placement.',
        difficulty: 'Beginner',
      },
      {
        id: 'lead_jab',
        name: 'Lead Jab',
        description: 'Extension and shoulder protection.',
        difficulty: 'Beginner',
      },
      {
        id: 'right_cross',
        name: 'Right Cross',
        description: 'Pivot and rear-foot power.',
        difficulty: 'Intermediate',
      },
      {
        id: 'lead_hook',
        name: 'Lead Hook',
        description: 'Elbow height and torso torque.',
        difficulty: 'Intermediate',
      },
      {
        id: 'lead_uppercut',
        name: 'Lead Uppercut',
        description: 'Drive from the legs up.',
        difficulty: 'Intermediate',
      },
      {
        id: 'rear_uppercut',
        name: 'Rear Uppercut',
        description: 'Hip rotation and impact angle.',
        difficulty: 'Intermediate',
      },
      {
        id: 'bob_and_weave',
        name: 'Bob & Weave',
        description: 'Head movement and low balance.',
        difficulty: 'Intermediate',
      },
      {
        id: 'slip_left',
        name: 'Slip Left',
        description: 'Quick weight shift and evasion.',
        difficulty: 'Pro',
      },
      {
        id: 'slip_right',
        name: 'Slip Right',
        description: 'Defensive angle and readiness.',
        difficulty: 'Pro',
      },
      {
        id: 'pivot_check',
        name: 'Foot Pivot',
        description: '360-degree mobility verification.',
        difficulty: 'Pro',
      },
    ],
  },
  football: {
    title: 'Football Technique',
    description: 'Improve your technical execution on the pitch.',
    poses: [
      {
        id: 'kick_prepare',
        name: 'Kick Preparation',
        description: 'Plant foot and swing back.',
        difficulty: 'Intermediate',
      },
      {
        id: 'header_jump',
        name: 'Header Projection',
        description: 'Vertical alignment and arch.',
        difficulty: 'Pro',
      },
      {
        id: 'ready_stance',
        name: 'Defensive Stance',
        description: 'Springy posture for intercept.',
        difficulty: 'Beginner',
      },
      {
        id: 'throw_in',
        name: 'Throw-In Form',
        description: 'Full arc and balanced release.',
        difficulty: 'Beginner',
      },
      {
        id: 'goalkeeper_dive',
        name: 'Keeper Dive',
        description: 'Full extension and hand spread.',
        difficulty: 'Pro',
      },
      {
        id: 'chest_trap',
        name: 'Chest Control',
        description: 'Impact absorption and lean.',
        difficulty: 'Intermediate',
      },
      {
        id: 'sprint_dribble',
        name: 'Dribble Posture',
        description: 'Keep ball close under control.',
        difficulty: 'Intermediate',
      },
      {
        id: 'sliding_tackle',
        name: 'Tackle Safety',
        description: 'Leg extension and impact point.',
        difficulty: 'Pro',
      },
      {
        id: 'volley_kick',
        name: 'Full Volley',
        description: 'In-air timing and weight shift.',
        difficulty: 'Pro',
      },
      {
        id: 'penalty_look',
        name: 'Penalty Focus',
        description: 'Composed stance and alignment.',
        difficulty: 'Intermediate',
      },
    ],
  },
  taekwondo: {
    title: 'Taekwondo Mastery',
    description: 'Refine your kicking techniques and dynamic movements.',
    poses: [
      {
        id: 'ap_chagi_front_kick',
        name: 'Ap Chagi',
        description: 'Front Kick mechanics.',
        difficulty: 'Beginner',
      },
      {
        id: 'dollyo_chagi_roundhouse_kick',
        name: 'Dollyo Chagi',
        description: 'Roundhouse Kick execution.',
        difficulty: 'Intermediate',
      },
      {
        id: 'yeop_chagi_side_kick',
        name: 'Yeop Chagi',
        description: 'Side Kick thrust power.',
        difficulty: 'Intermediate',
      },
      {
        id: 'dwi_chagi_back_kick',
        name: 'Dwi Chagi',
        description: 'Back Kick accuracy and balance.',
        difficulty: 'Intermediate',
      },
      {
        id: 'miro_chagi_push_kick',
        name: 'Miro Chagi',
        description: 'Push Kick targeting.',
        difficulty: 'Beginner',
      },
      {
        id: 'bandae_dollyo_chagi_reverse_roundhouse',
        name: 'Bandae Dollyo',
        description: 'Reverse Roundhouse spin.',
        difficulty: 'Pro',
      },
      {
        id: 'twio_ap_chagi_jumping_front_kick',
        name: 'Twio Ap Chagi',
        description: 'Jumping Front Kick timing.',
        difficulty: 'Pro',
      },
      {
        id: 'twio_dollyo_chagi_jumping_roundhouse',
        name: 'Twio Dollyo Chagi',
        description: 'Jumping Roundhouse airborne control.',
        difficulty: 'Pro',
      },
      {
        id: 'baka_chagi_side_slide_roundhouse',
        name: 'Baka Chagi',
        description: 'Side Slide + Roundhouse.',
        difficulty: 'Intermediate',
      },
      {
        id: 'preamble_dollyo_chagi_front_leg_slide',
        name: 'Preamble Dollyo',
        description: 'Front-Leg Slide + Roundhouse.',
        difficulty: 'Intermediate',
      },
    ],
  },
};

export default function SetupPage() {
  const { sport } = useParams() as { sport: Sport };
  if (sport === 'squash') {
    return <div className="brain-surface"><BrainSetup sport={sport} /></div>;
  }
  return <LegacySetupPage sport={sport} />;
}

function LegacySetupPage({ sport }: { sport: Sport }) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const config = SPORT_CONFIG[sport];
  const [selectedPose, setSelectedPose] = useState(config?.poses[0].id || '');
  const [query, setQuery] = useState('');
  const [imageFallback, setImageFallback] = useState(0);

  useEffect(() => {
    setSelectedPose(SPORT_CONFIG[sport]?.poses[0].id || '');
    setImageFallback(0);
    setQuery('');
  }, [sport]);
  if (!config)
    return (
      <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="absolute right-5 top-5">
          <ThemeToggle />
        </div>
        <div className="glass-card max-w-lg p-8 sm:p-12 text-center">
          <div className="clay-icon w-20 h-20 mx-auto mb-7">
            <Target className="w-8 h-8" />
          </div>
          <h1 className="text-3xl font-semibold tracking-tight mb-4">
            Discipline unavailable
          </h1>
          <p className="text-muted leading-relaxed mb-8">
            This discipline is not available for analysis yet. Choose a
            supported sport to begin training.
          </p>
          <Link
            href="/dashboard"
            className="btn-primary inline-flex items-center gap-3"
          >
            Return to training <ArrowUpRight className="w-5 h-5" />
          </Link>
        </div>
      </main>
    );
  const selected =
    config.poses.find((pose) => pose.id === selectedPose) || config.poses[0];
  const filteredPoses = config.poses.filter((pose) =>
    `${pose.name} ${pose.description} ${pose.difficulty}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  return (
    <div className="min-h-screen text-foreground bg-background">
      <header className="border-b border-border bg-surface/75 backdrop-blur-xl">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-8 py-5 flex items-center justify-between gap-3">
          <div className="sm:hidden">
            <Brand compact />
          </div>
          <div className="hidden sm:block">
            <Brand />
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/dashboard"
              aria-label="Back to training"
              className="flex items-center gap-2 rounded-2xl p-3 sm:px-4 text-sm text-muted hover:bg-surface-raised hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
              <span className="hidden sm:inline">Back to training</span>
            </Link>
          </div>
        </div>
      </header>
      <main className="max-w-[1360px] mx-auto px-5 sm:px-8 pt-9 sm:pt-12 pb-36 lg:pb-16">
        <div className="flex flex-wrap items-center gap-3 text-sm text-subtle mb-8">
          <span className="text-primary font-medium">1. Choose a movement</span>
          <span aria-hidden="true">/</span>
          <span>2. Train</span>
          <span aria-hidden="true">/</span>
          <span>3. Review</span>
        </div>
        <div className="mb-10">
          <p className="text-primary text-base font-medium capitalize mb-3">
            {sport} training
          </p>
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-[-0.04em] leading-[1.12]">
            Select your movement
          </h1>
          <p className="text-muted text-base sm:text-lg leading-relaxed max-w-2xl mt-5">
            {config.description} Choose a focus for your next session.
          </p>
        </div>
        <div className="grid lg:grid-cols-[1.05fr_1fr] gap-7 xl:gap-10 items-start">
          <section>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h2 className="text-xl font-semibold tracking-tight">
                Movement library
              </h2>
              <span className="text-sm text-subtle">
                {config.poses.length} movements
              </span>
            </div>
            <div className="relative mb-5">
              <Search className="w-5 h-5 text-subtle absolute left-5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search movements"
                placeholder="Search movements"
                className="w-full text-base rounded-[22px] border border-border bg-surface-inset pl-[52px] pr-5 py-4 placeholder:text-subtle outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/10"
              />
            </div>
            <div className="space-y-4">
              {filteredPoses.map((pose) => (
                <motion.button
                  key={pose.id}
                  aria-pressed={selectedPose === pose.id}
                  whileHover={reduceMotion ? undefined : { y: -2 }}
                  whileTap={reduceMotion ? undefined : { scale: 0.99 }}
                  onClick={() => {
                    setSelectedPose(pose.id);
                    setImageFallback(0);
                  }}
                  className={`relative w-full flex items-start gap-4 rounded-[26px] p-5 sm:p-6 text-left border transition-colors ${selectedPose === pose.id ? 'border-primary/40 bg-primary/[0.065] shadow-[0_8px_30px_-18px_rgb(var(--primary)/0.25)]' : 'border-border bg-surface hover:bg-surface-raised'}`}
                >
                  <span
                    className={`shrink-0 w-10 h-10 rounded-2xl font-medium text-sm flex items-center justify-center ${selectedPose === pose.id ? 'bg-primary text-background shadow-lg shadow-primary/20' : 'bg-surface-inset text-subtle'}`}
                  >
                    {selectedPose === pose.id ? (
                      <Check className="w-5 h-5" />
                    ) : (
                      String(config.poses.indexOf(pose) + 1).padStart(2, '0')
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-2">
                      <h3 className="text-base sm:text-lg font-semibold text-foreground">
                        {pose.name}
                      </h3>
                      <span className="text-sm text-muted">
                        {pose.difficulty}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed text-muted">
                      {pose.description}
                    </p>
                  </div>
                </motion.button>
              ))}
            </div>
            {filteredPoses.length === 0 && (
              <div className="glass-card py-12 px-6 text-center text-base text-muted">
                No movements match “{query}”.{' '}
                <button
                  onClick={() => setQuery('')}
                  className="text-primary underline underline-offset-4"
                >
                  Clear search
                </button>
              </div>
            )}
          </section>
          <aside className="lg:sticky lg:top-8 space-y-5">
            <motion.div
              whileHover={reduceMotion ? undefined : { y: -3 }}
              className="glass-card overflow-hidden"
              style={{ borderRadius: 28 }}
            >
              <div className="px-6 sm:px-8 pt-7 flex items-center justify-between gap-3">
                <h2 className="text-base font-medium flex items-center gap-2.5">
                  <Focus className="w-5 h-5 text-primary" /> Movement preview
                </h2>
                <span className="text-sm text-subtle">
                  {config.poses.indexOf(selected) + 1} / {config.poses.length}
                </span>
              </div>
              <div className="relative h-[350px] sm:h-[440px] flex items-center justify-center p-6 sm:p-8">
                <div
                  aria-hidden="true"
                  className="absolute inset-8 rounded-[32px] bg-gradient-to-br from-primary/[0.07] via-surface-inset to-secondary/[0.05]"
                />
                <AnimatePresence mode="wait">
                  <motion.div
                    key={selectedPose}
                    initial={{ opacity: 0, y: reduceMotion ? 0 : 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.22 }}
                    className="relative h-full w-full flex items-center justify-center"
                  >
                    {imageFallback < 2 ? (
                      <img
                        src={
                          imageFallback === 0
                            ? `/postures/${sport}_${selectedPose}.${sport === 'squash' ? 'svg' : 'png'}`
                            : `/postures/${sport}.${sport === 'squash' ? 'svg' : 'png'}`
                        }
                        alt={`${selected.name} ${sport === 'squash' ? 'illustrative position guide' : 'reference posture'}`}
                        onError={() =>
                          setImageFallback((current) => current + 1)
                        }
                        className="max-w-full max-h-full object-contain rounded-2xl shadow-xl"
                      />
                    ) : (
                      <div className="text-center px-5">
                        <Focus className="w-16 h-16 stroke-1 text-primary/65 mx-auto mb-5" />
                        <p className="text-sm text-muted leading-relaxed">
                          Reference image unavailable.
                          <br />
                          Follow the coaching cues during your session.
                        </p>
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="px-6 sm:px-8 pb-8">
                <p className="text-sm text-primary mb-2">
                  Your selected movement
                </p>
                <h2 className="text-3xl font-semibold tracking-tight">
                  {selected.name}
                </h2>
                <p className="text-base text-muted mt-4 leading-relaxed">
                  {selected.description}
                </p>
                <div className="flex flex-wrap items-center gap-3 mt-6 text-sm text-muted">
                  <span className="rounded-full bg-surface-inset px-4 py-2">
                    {selected.difficulty}
                  </span>
                  <span className="rounded-full bg-surface-inset px-4 py-2">
                    Live form feedback
                  </span>
                </div>
                <button
                  onClick={() =>
                    router.push(`/train/${sport}?pose=${selectedPose}`)
                  }
                  className="btn-primary w-full hidden lg:flex items-center justify-between mt-7 py-4 text-base"
                >
                  Start training <ArrowUpRight className="w-5 h-5" />
                </button>
              </div>
            </motion.div>
            <div className="flex gap-3 px-2 py-2">
              <Camera className="w-5 h-5 text-primary mt-0.5 shrink-0" />
              <p className="text-sm text-muted leading-relaxed">
                Keep your full body in frame. You’ll enable your camera on the
                next screen.
              </p>
            </div>
          </aside>
        </div>
      </main>
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/90 px-4 pt-4 backdrop-blur-2xl sm:px-8 lg:hidden"
        style={{
          paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="mb-1 text-sm text-muted">Selected</p>
            <p className="truncate text-sm font-semibold" aria-live="polite">
              {selected.name}
            </p>
          </div>
          <button
            onClick={() => router.push(`/train/${sport}?pose=${selectedPose}`)}
            className="btn-primary shrink-0 gap-2 whitespace-nowrap px-4 py-3.5 text-sm"
          >
            Start training <ArrowUpRight className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
