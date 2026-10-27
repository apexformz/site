import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Camera,
  Check,
  Cloud,
  Focus,
  LockKeyhole,
  Monitor,
  MoveRight,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
  Volume2,
  Wifi,
} from 'lucide-react';
import { PublicHeader } from '@/components/PublicHeader';
import { PublicFooter } from '@/components/PublicFooter';
import { Reveal } from '@/components/ui/Reveal';
import { Faq } from '@/components/ui/Faq';
import { TechnologyFlow } from '@/components/TechnologyFlow';

export const metadata: Metadata = {
  title: 'How it works | ApexFormz',
  description:
    'Understand how ApexFormz turns camera-based pose tracking into exercise-specific feedback, session insights, and a clearer training routine.',
};

const steps = [
  {
    number: '01',
    icon: Target,
    title: 'Choose your focus',
    copy: 'Pick a discipline and a specific technique. The reference you select tells the coaching system what movement to look for.',
    detail: 'A session starts with one clear intention.',
  },
  {
    number: '02',
    icon: Camera,
    title: 'Set up your view',
    copy: 'Enable your camera when you’re ready. Place it on a stable surface and keep your full body in frame, with even light and room to move.',
    detail: 'Clear visibility gives the tracker better information.',
  },
  {
    number: '03',
    icon: ScanLine,
    title: 'Train with feedback',
    copy: 'Start the session to analyse your movement. In Squash, the Brain runs on your device and shows the skeleton overlay, recognition, phases, and feedback supported by the available evidence.',
    detail: 'Make one adjustment, then see what changes.',
  },
  {
    number: '04',
    icon: BarChart3,
    title: 'Bring the lesson forward',
    copy: 'Finish and save your session to review the score, duration, earned XP, and recurring technique notes. Use that context to choose your next focus.',
    detail: 'Each session becomes a useful point of reference.',
  },
];
const faqs = [
  {
    question: 'What do I need for my first session?',
    answer:
      'A camera-enabled device, a modern browser with camera permission, a stable internet connection, and enough space to perform the selected movement. The live coaching flow does not require a wearable or a microphone. Start with an exercise you already know how to perform comfortably.',
  },
  {
    question: 'Does ApexFormz record or upload my camera video?',
    answer:
      'Camera images are processed in your browser and are not uploaded by the live training flow. Squash tracking, recognition, and analysis run on your device; saved summaries and analysis events can synchronize with your account. Other disciplines send pose and hand landmarks to the coaching service for analysis. The live training flow does not request microphone audio.',
  },
  {
    question: 'What does the form score mean?',
    answer:
      'It describes the assessment of your selected technique when enough evidence is available. Squash recognition confidence is separate from technique scoring. Strict mode withholds scores for provisional criteria; preview scores are experimental. Lighting, camera angle, and tracking quality affect the evidence, so review the notes alongside any number.',
  },
  {
    question: 'Why are some movements tracked differently?',
    answer:
      'A held position and a moving technique need different context. Static checks compare visible joint alignment with the selected reference. Supported dynamic movements also keep track of phases across time, and can report completed repetitions, phase scores, and movement fluidity. The available feedback depends on the technique you choose.',
  },
  {
    question: 'What does the Squash Brain support?',
    answer:
      'The catalog contains 184 movements, covering static positions, strokes, footwork, and recovery. Trained recognition covers 68 static and 109 dynamic classes. The Brain follows movement phases and checks visible technique evidence. Technique criteria remain provisional, and equipment-dependent checks require separate racket or ball evidence.',
  },
  {
    question: 'Can I train without an internet connection?',
    answer:
      'Load the Squash page, movement pack, and models while connected. Once loaded, Squash analysis runs locally and can continue if the connection drops. Results remain on this device, and signed-in sessions can retry account synchronization when connected. Other disciplines still depend on their online coaching service.',
  },
  {
    question: 'How do circles work today?',
    answer:
      'You can create a circle, share its invite code, and view your teammates and their individual streaks. Shared circle health and the shared streak are preview features: automatic updates from completed sessions are not active yet. Your own saved sessions, XP, and individual progress remain separate from those preview team metrics.',
  },
];

export default function TechnologyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <PublicHeader />
      <main>
        <section className="page-width pt-14 pb-16 sm:pt-20 sm:pb-24">
          <Reveal className="max-w-4xl">
            <p className="eyebrow mb-5">A closer look at your movement</p>
            <h1 className="display-title text-[38px] sm:text-6xl lg:text-[72px]">
              Intelligence in
              <br />
              <span className="text-primary">every movement.</span>
            </h1>
            <p className="mt-7 max-w-2xl text-lg sm:text-xl leading-relaxed text-muted">
              From the way you hold a pose to the way you complete a kick,
              ApexFormz helps turn what your camera sees into a clearer next
              step.
            </p>
            <div className="flex flex-wrap items-center gap-4 mt-9">
              <Link href="/sports" className="btn-primary">
                Find your discipline <ArrowUpRight size={20} />
              </Link>
              <a href="#coaching-loop" className="btn-secondary">
                See how it works <ArrowRight size={19} />
              </a>
            </div>
          </Reveal>
          <Reveal delay={0.1} className="mt-14 sm:mt-20">
            <div className="grid sm:grid-cols-3 gap-6 sm:gap-8 border-y border-border/60 py-7 sm:py-9">
              {[
                {
                  icon: Camera,
                  title: 'Start with your camera',
                  copy: 'No specialist tracking equipment.',
                },
                {
                  icon: Focus,
                  title: 'Focus on one technique',
                  copy: 'Feedback tied to your selected exercise.',
                },
                {
                  icon: BarChart3,
                  title: 'Learn across sessions',
                  copy: 'Keep the results and corrections that matter.',
                },
              ].map((item) => (
                <div key={item.title} className="flex items-start gap-4">
                  <span className="clay-icon h-12 w-12 shrink-0 rounded-2xl">
                    <item.icon size={23} strokeWidth={1.6} />
                  </span>
                  <div>
                    <h2 className="text-base font-semibold">{item.title}</h2>
                    <p className="text-sm text-muted leading-relaxed mt-2">
                      {item.copy}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section
          id="coaching-loop"
          className="page-width pb-20 sm:pb-28 scroll-mt-10"
        >
          <Reveal className="grid lg:grid-cols-[.7fr_1.3fr] items-start gap-9 lg:gap-14">
            <div className="lg:pt-8">
              <p className="eyebrow mb-4">The feedback loop</p>
              <h2 className="display-title text-3xl sm:text-4xl">
                See. Understand.
                <br />
                Adjust.
              </h2>
              <p className="mt-6 text-base sm:text-lg leading-relaxed text-muted">
                Squash uses the shared ApexFormz Brain for pose tracking,
                recognition, and technique analysis on your device.
              </p>
              <p className="mt-5 text-base leading-relaxed text-muted">
                Your camera view becomes movement landmarks. The Brain follows
                the athlete and movement phases, then checks whether the
                available evidence supports an assessment. Other disciplines
                use the online coaching service.
              </p>
              <p className="mt-7 text-sm leading-relaxed text-subtle">
                Explore each stage in the illustration. It shows the flow of
                information, not a live camera session.
              </p>
            </div>
            <TechnologyFlow />
          </Reveal>
        </section>

        <section className="page-width pb-20 sm:pb-28">
          <Reveal className="max-w-2xl mb-10 sm:mb-12">
            <p className="eyebrow mb-4">Your first session</p>
            <h2 className="display-title text-3xl sm:text-4xl">
              A simple routine.
              <br />A more useful practice.
            </h2>
            <p className="text-base sm:text-lg leading-relaxed text-muted mt-6">
              Move from choosing a technique to understanding your result,
              without changing tools along the way.
            </p>
          </Reveal>
          <div className="grid md:grid-cols-2 gap-6">
            {steps.map((step, index) => (
              <Reveal key={step.number} delay={index * 0.06}>
                <article className="glass-card p-7 sm:p-9 h-full">
                  <div className="flex items-center justify-between mb-7">
                    <span className="clay-icon h-14 w-14 rounded-[20px]">
                      <step.icon size={26} strokeWidth={1.6} />
                    </span>
                    <span className="text-3xl font-medium tracking-tight text-primary/30">
                      {step.number}
                    </span>
                  </div>
                  <h3 className="text-2xl font-semibold tracking-tight">
                    {step.title}
                  </h3>
                  <p className="text-base leading-relaxed text-muted mt-4">
                    {step.copy}
                  </p>
                  <p className="mt-6 pt-5 border-t border-border/60 text-sm text-primary flex items-start gap-2.5">
                    <Check size={17} className="shrink-0 mt-0.5" />
                    {step.detail}
                  </p>
                </article>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="page-width pb-20 sm:pb-28">
          <Reveal className="text-center max-w-3xl mx-auto mb-10 sm:mb-12">
            <p className="eyebrow mb-4">The right context for the technique</p>
            <h2 className="display-title text-3xl sm:text-4xl">
              Some moments are held.
              <br />
              Others unfold.
            </h2>
            <p className="mt-6 text-base sm:text-lg leading-relaxed text-muted">
              The selected exercise determines how your movement is assessed. A
              posture check and a sequence of motion are different training
              questions.
            </p>
          </Reveal>
          <div className="grid lg:grid-cols-2 gap-7">
            <Reveal>
              <article className="glass-card p-7 sm:p-10 h-full">
                <span className="clay-icon h-16 w-16 mb-7">
                  <Focus size={29} strokeWidth={1.5} />
                </span>
                <span className="inline-flex rounded-full bg-primary/[.06] text-primary text-sm px-3.5 py-1.5 mb-5">
                  Held positions
                </span>
                <h3 className="text-2xl font-semibold tracking-tight">
                  Make alignment visible.
                </h3>
                <p className="mt-5 text-base leading-relaxed text-muted">
                  Static analysis checks visible joints against the selected
                  posture’s reference. It can identify an alignment issue and
                  show a correction while you hold the position.
                </p>
                <div className="rounded-[22px] border border-border/70 bg-surface-inset/35 p-5 mt-7">
                  <p className="text-sm font-semibold">
                    For example: a yoga posture
                  </p>
                  <p className="text-sm text-muted leading-relaxed mt-2">
                    Keep the relevant joints in view and use the feedback to
                    refine your position. Missing joints can affect the result.
                  </p>
                </div>
              </article>
            </Reveal>
            <Reveal delay={0.08}>
              <article className="glass-card p-7 sm:p-10 h-full">
                <span className="clay-icon h-16 w-16 mb-7">
                  <Activity size={29} strokeWidth={1.5} />
                </span>
                <span className="inline-flex rounded-full bg-primary/[.06] text-primary text-sm px-3.5 py-1.5 mb-5">
                  Dynamic movements
                </span>
                <h3 className="text-2xl font-semibold tracking-tight">
                  Follow the whole sequence.
                </h3>
                <p className="mt-5 text-base leading-relaxed text-muted">
                  Supported moving techniques track phases across successive
                  frames. Analysis can include phase alignment, repetition
                  counts, movement fluidity, and comparison with available
                  reference sequences.
                </p>
                <div className="rounded-[22px] border border-border/70 bg-surface-inset/35 p-5 mt-7">
                  <p className="text-sm font-semibold">
                    For example: a taekwondo kick
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted mt-3">
                    <span>Preparation</span>
                    <MoveRight size={15} />
                    <span>Extension</span>
                    <MoveRight size={15} />
                    <span>Recovery</span>
                  </div>
                  <p className="text-sm text-subtle mt-3">
                    Illustrative sequence. The exact phases depend on your
                    selected kick.
                  </p>
                </div>
              </article>
            </Reveal>
          </div>
          <Reveal>
            <div className="mt-7 rounded-[24px] border border-primary/15 bg-primary/[.035] p-6 sm:px-8 flex items-start gap-4">
              <Sparkles size={22} className="text-primary shrink-0 mt-1" />
              <p className="text-base text-muted leading-relaxed">
                <strong className="font-semibold text-foreground">
                  Squash uses the ApexFormz Brain.
                </strong>{' '}
                Recognition covers static and dynamic movements. Technique
                criteria remain provisional: strict mode withholds scores and
                corrections until evidence and validation support them. Body
                landmarks alone cannot establish ball contact or racket-face angle.
              </p>
            </div>
          </Reveal>
        </section>

        <section className="page-width pb-20 sm:pb-28">
          <Reveal className="max-w-2xl mb-10">
            <p className="eyebrow mb-4">More context, less guesswork</p>
            <h2 className="display-title text-3xl sm:text-4xl">
              Useful during the session.
              <br />
              Useful after it.
            </h2>
          </Reveal>
          <div className="grid lg:grid-cols-3 gap-6">
            {[
              {
                icon: Volume2,
                title: 'Coaching you can act on',
                copy: 'See priority corrections alongside your camera. Optional spoken coaching reads cues using your browser’s available speech voices, so you can listen as you practise.',
                link: '/sports',
                action: 'Choose a technique',
              },
              {
                icon: BarChart3,
                title: 'A record of your work',
                copy: 'Saved results bring together your session score, duration, XP, and technique notes. Dynamic sessions may also include phase and movement-quality details when available.',
                link: '/profile',
                action: 'View your progress',
              },
              {
                icon: Users,
                title: 'A place for your team',
                copy: 'Create or join a circle using an invite code. See who is training with you and view individual streaks. Shared circle metrics are still in preview.',
                link: '/circles',
                action: 'Explore your circles',
              },
            ].map((item, index) => (
              <Reveal key={item.title} delay={index * 0.07}>
                <article className="glass-card p-7 sm:p-8 h-full flex flex-col">
                  <span className="clay-icon h-14 w-14 mb-7">
                    <item.icon size={26} strokeWidth={1.5} />
                  </span>
                  <h3 className="text-xl font-semibold tracking-tight">
                    {item.title}
                  </h3>
                  <p className="text-base text-muted leading-relaxed mt-4 mb-7 flex-1">
                    {item.copy}
                  </p>
                  <Link
                    href={item.link}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:gap-3 transition-all"
                  >
                    {item.action}
                    <ArrowUpRight size={17} />
                  </Link>
                </article>
              </Reveal>
            ))}
          </div>
        </section>

        <section
          id="camera-and-data"
          className="page-width pb-20 sm:pb-28 scroll-mt-10"
        >
          <Reveal>
            <div className="glass-card p-7 sm:p-10 lg:p-12">
              <div className="max-w-3xl mb-9">
                <span className="clay-icon h-16 w-16 mb-7">
                  <ShieldCheck size={30} strokeWidth={1.5} />
                </span>
                <p className="eyebrow mb-4">Your camera and your data</p>
                <h2 className="display-title text-3xl sm:text-4xl">
                  Know what happens
                  <br />
                  when you press start.
                </h2>
                <p className="mt-6 text-base sm:text-lg leading-relaxed text-muted">
                  Camera images stay in your browser. Squash runs tracking and
                  analysis locally, then saves the session review on this
                  device and synchronizes account-backed results when connected.
                </p>
              </div>
              <div className="grid md:grid-cols-2 gap-6 lg:gap-10">
                <div className="rounded-[24px] border border-border/70 bg-surface/40 p-6 sm:p-7">
                  <div className="flex items-center gap-3 mb-5">
                    <Monitor size={23} className="text-primary" />
                    <h3 className="text-lg font-semibold">On your device</h3>
                  </div>
                  <ul className="space-y-4 text-base text-muted leading-relaxed">
                    <li className="flex gap-3">
                      <Check className="text-primary shrink-0 mt-1" size={18} />
                      Camera permission is requested when you enable the camera.
                    </li>
                    <li className="flex gap-3">
                      <Check className="text-primary shrink-0 mt-1" size={18} />
                      Squash uses MediaPipe Pose Landmarker in the Brain worker.
                      Other disciplines use body and hand tracking.
                    </li>
                    <li className="flex gap-3">
                      <Check className="text-primary shrink-0 mt-1" size={18} />
                      The live training flow does not upload camera video or
                      request microphone audio.
                    </li>
                  </ul>
                </div>
                <div className="rounded-[24px] border border-border/70 bg-surface/40 p-6 sm:p-7">
                  <div className="flex items-center gap-3 mb-5">
                    <Cloud size={23} className="text-primary" />
                    <h3 className="text-lg font-semibold">
                      In the coaching service
                    </h3>
                  </div>
                  <ul className="space-y-4 text-base text-muted leading-relaxed">
                    <li className="flex gap-3">
                      <Check className="text-primary shrink-0 mt-1" size={18} />
                      Squash synchronizes analysis events and session summaries.
                      Other disciplines send movement landmarks for analysis.
                    </li>
                    <li className="flex gap-3">
                      <Check className="text-primary shrink-0 mt-1" size={18} />
                      Squash results preserve movement, assessment, and feedback
                      evidence. A missing technique score stays unscored.
                    </li>
                    <li className="flex gap-3">
                      <Check className="text-primary shrink-0 mt-1" size={18} />
                      Finishing a session saves the summary used in your results
                      and progress views.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        <section className="page-width pb-20 sm:pb-28">
          <Reveal className="grid lg:grid-cols-[.8fr_1.2fr] gap-10 lg:gap-16">
            <div>
              <p className="eyebrow mb-4">Set yourself up well</p>
              <h2 className="display-title text-3xl sm:text-4xl">
                A clear view makes
                <br />a real difference.
              </h2>
              <p className="mt-6 text-base sm:text-lg text-muted leading-relaxed">
                Tracking is only as useful as the movement the camera can see. A
                few setup choices help the system follow you more reliably.
              </p>
            </div>
            <div className="space-y-6">
              {[
                {
                  icon: Camera,
                  title: 'Room, light, and a steady camera',
                  copy: 'Keep your head, hips, knees, and feet visible. Avoid backlighting and objects covering your body. Leave enough space for the full selected movement.',
                },
                {
                  icon: LockKeyhole,
                  title: 'Camera access in your browser',
                  copy: 'Use the secure HTTPS version of the site and allow camera permission. If another app is using the camera, close it before retrying. Check the preview before starting.',
                },
                {
                  icon: Wifi,
                  title: 'A stable connection and a ready device',
                  copy: 'Load the Squash page, pack, and models while connected. Analysis then runs on your device, with account synchronization when available. Other disciplines require the online analysis service. Loading time varies with your device and connection.',
                },
              ].map((item) => (
                <div
                  key={item.title}
                  className="flex items-start gap-4 sm:gap-5"
                >
                  <span className="clay-icon w-12 h-12 sm:w-14 sm:h-14 shrink-0">
                    <item.icon size={24} strokeWidth={1.6} />
                  </span>
                  <div>
                    <h3 className="text-lg font-semibold">{item.title}</h3>
                    <p className="text-base text-muted leading-relaxed mt-3">
                      {item.copy}
                    </p>
                  </div>
                </div>
              ))}
              <a
                href="https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia#privacy_and_security"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 text-sm font-medium text-primary mt-2"
              >
                About browser camera permissions <ArrowUpRight size={16} />
              </a>
            </div>
          </Reveal>
        </section>

        <section className="page-width pb-20 sm:pb-28">
          <Reveal className="grid lg:grid-cols-[.65fr_1.35fr] gap-9 lg:gap-16">
            <div>
              <p className="eyebrow mb-4">A few useful answers</p>
              <h2 className="display-title text-3xl sm:text-4xl">
                Before you begin.
              </h2>
              <p className="mt-6 text-base text-muted leading-relaxed">
                A closer look at scores, camera access, and what the current
                coaching experience supports.
              </p>
            </div>
            <div className="border-y border-border/70">
              <Faq items={faqs} />
            </div>
          </Reveal>
        </section>

        <section className="page-width pb-16 sm:pb-24">
          <Reveal>
            <div className="glass-card p-8 sm:p-12 lg:p-14 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-8">
              <div className="max-w-2xl">
                <p className="eyebrow mb-4">Put it into practice</p>
                <h2 className="display-title text-3xl sm:text-4xl">
                  Your next session
                  <br />
                  can start with one adjustment.
                </h2>
                <p className="text-base sm:text-lg text-muted leading-relaxed mt-5">
                  Choose your discipline, find a technique, and give yourself
                  the space to focus.
                </p>
              </div>
              <div className="flex flex-wrap gap-4 shrink-0">
                <Link href="/sports" className="btn-primary">
                  Explore sports <ArrowUpRight size={19} />
                </Link>
                <Link href="/register" className="btn-secondary">
                  Create an account
                </Link>
              </div>
            </div>
          </Reveal>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
