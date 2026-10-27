'use client';

import React, {
  Suspense,
  useRef,
  useEffect,
  useState,
  useCallback,
} from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  Camera,
  CameraOff,
  Check,
  Focus,
  Loader2,
  Play,
  Radio,
  RotateCcw,
  ShieldCheck,
  Square,
  Sparkles,
  X,
} from 'lucide-react';
import { Brand } from '@/components/ui/Brand';
import { ThemeToggle } from '@/components/ui/ThemeProvider';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { useHolisticDetection } from '@/hooks/useHolisticDetection';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useVoiceCoaching } from '@/hooks/useVoiceCoaching';
import { PoseSkeleton } from '@/components/PoseSkeleton';
import { TrainingStats } from '@/components/TrainingStats';
import { ActionableFeedback } from '@/components/ActionableFeedback';
import { PostureReference } from '@/components/PostureReference';
import {
  FrameAnalysis,
  DynamicFrameAnalysis,
  PoseKeypoints,
  Sport,
  Hand,
} from '@smartcoach/types';
import { api } from '@/lib/api';
import BrainTrainingPage from '@/components/brain/BrainTrainingPage';

export default function TrainingPage() {
  return (
    <Suspense fallback={<LoadingScreen label="Opening your training studio" />}>
      <TrainingRoute />
    </Suspense>
  );
}

function TrainingRoute() {
  const { sport } = useParams() as { sport: Sport };
  if (sport === 'squash') {
    return <div className="brain-surface"><BrainTrainingPage sport={sport} /></div>;
  }
  return <TrainingWorkspace />;
}

function TrainingWorkspace() {
  const { sport } = useParams() as { sport: Sport };
  const searchParams = useSearchParams();
  const poseName = searchParams?.get('pose') || undefined;
  const router = useRouter();
  const reduceMotion = useReducedMotion();

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraControlsReady, setCameraControlsReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isSessionPending, setIsSessionPending] = useState(false);

  useEffect(() => {
    setCameraControlsReady(true);
  }, []);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentPose, setCurrentPose] = useState<PoseKeypoints | null>(null);
  const [currentHands, setCurrentHands] = useState<Hand[] | null>(null);
  const [currentFace, setCurrentFace] = useState<any[] | null>(null);
  const [currentAnalysis, setCurrentAnalysis] = useState<FrameAnalysis | null>(
    null,
  );
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [sessionDuration, setSessionDuration] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [averageScore, setAverageScore] = useState(0);
  const [currentRep, setCurrentRep] = useState(0);
  const [throttledAnalysis, setThrottledAnalysis] =
    useState<FrameAnalysis | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1280, height: 720 });
  const lastFeedbackUpdateRef = useRef<number>(0);
  const [coWorkoutMates, setCoWorkoutMates] = useState<Record<string, number>>(
    {},
  );

  // Track detailed stats for the step-wise report
  const sessionStatsRef = useRef({
    issues: [] as any[],
    phaseScores: {} as Record<string, number>,
    fluidityScores: [] as number[],
    trajectorySimilarity: 0,
    maxReps: 0,
  });

  const circleId = searchParams?.get('circle') || undefined;

  const {
    announce,
    isSpeaking: isAiSpeaking,
    stop: stopAiVoice,
  } = useVoiceCoaching();
  const {
    detectHolistic,
    hardResetHolistic,
    isLoading: isAiLoading,
    error: aiError,
  } = useHolisticDetection();

  const onFeedback = useCallback(
    (analysis: FrameAnalysis) => {
      setAnalysisError(null);
      setCurrentAnalysis(analysis);
      setFrameCount((prev) => {
        const nextCount = prev + 1;
        setAverageScore((currentAvg) => {
          const newScore = (currentAvg * prev + analysis.score) / nextCount;
          return Number.isNaN(newScore) ? analysis.score : newScore;
        });
        return nextCount;
      });
      setBestScore((prev) => Math.max(prev, analysis.score));

      // Accumulate detailed stats
      if (analysis.issues && analysis.issues.length > 0) {
        sessionStatsRef.current.issues.push(...analysis.issues);
      }

      // Typecast to any to safely check for dynamic fields
      const dynamicAnalysis = analysis as any;
      if (dynamicAnalysis.dynamic) {
        if (dynamicAnalysis.phase_scores) {
          sessionStatsRef.current.phaseScores = {
            ...sessionStatsRef.current.phaseScores,
            ...dynamicAnalysis.phase_scores,
          };
        }
        if (dynamicAnalysis.fluidity_score) {
          sessionStatsRef.current.fluidityScores.push(
            dynamicAnalysis.fluidity_score,
          );
        }
        if (dynamicAnalysis.trajectory_similarity) {
          sessionStatsRef.current.trajectorySimilarity =
            dynamicAnalysis.trajectory_similarity;
        }
      }

      // VOICE-GUIDED SEQUENTIAL DELIVERY + FREQUENCY THROTTLE
      const activeIssues = analysis.issues?.filter(
        (i) => i.severity === 'high' || i.severity === 'medium',
      );
      const now = Date.now();

      // Rep-aware logic
      if (dynamicAnalysis.dynamic && dynamicAnalysis.rep_completed) {
        setCurrentRep(dynamicAnalysis.rep_count);
        sessionStatsRef.current.maxReps = Math.max(
          sessionStatsRef.current.maxReps,
          dynamicAnalysis.rep_count,
        );

        // On rep completion, give immediate feedback about the rep
        if (!isAiSpeaking) {
          if (analysis.score >= 80) {
            announce(`Great rep! Keep it up.`);
          } else if (activeIssues && activeIssues.length > 0) {
            const primaryIssue =
              activeIssues.find((i) => i.severity === 'high') ||
              activeIssues[0];
            announce(`Good rep, but next time, ${primaryIssue.correction}`);
          }
          lastFeedbackUpdateRef.current = now;
        }
      } else {
        // Standard continuous logic
        if (
          analysis.score >= 80 &&
          !(sport === 'squash' && activeIssues?.length)
        ) {
          setThrottledAnalysis({ ...analysis, issues: [] });

          if (!isAiSpeaking && now - lastFeedbackUpdateRef.current > 12000) {
            announce(
              sport === 'squash'
                ? 'Your position is within the experimental guide. Keep it comfortable.'
                : 'Perfect posture. Keep it up!',
            );
            lastFeedbackUpdateRef.current = now;
          }
        } else if (activeIssues && activeIssues.length > 0) {
          setThrottledAnalysis(analysis);

          if (!isAiSpeaking && now - lastFeedbackUpdateRef.current > 10000) {
            const primaryIssue =
              activeIssues.find((i) => i.severity === 'high') ||
              activeIssues[0];
            if (primaryIssue) {
              announce(primaryIssue.correction);
              lastFeedbackUpdateRef.current = now;
            }
          }
        }
      }
    },
    [isAiSpeaking, announce, sport],
  );

  const onCoWorkoutSync = useCallback(
    (data: { userId: string; score: number }) => {
      setCoWorkoutMates((prev) => ({ ...prev, [data.userId]: data.score }));
    },
    [],
  );

  const onFeedbackError = useCallback((message: string) => {
    setAnalysisError(message);
  }, []);

  const {
    isConnected,
    connectionError,
    startSession,
    submitFrame,
    stopSession,
  } = useWebSocket(onFeedback, onCoWorkoutSync, onFeedbackError);

  // Toggle Camera
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    async function setupCamera() {
      if (isCameraActive) {
        setCameraError(null);
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720, facingMode: 'user' },
            audio: false,
          });
          if (cancelled) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        } catch (err) {
          console.error('Camera error:', err);
          if (cancelled) return;
          const errorName = (err as Error).name;
          setCameraError(
            errorName === 'NotAllowedError'
              ? 'Camera access was blocked. Allow camera access in your browser, then try again.'
              : errorName === 'NotFoundError'
                ? 'No camera was found. Connect a camera and try again.'
                : 'Your camera could not start. Check that it is connected and not in use by another app.',
          );
          setIsCameraActive(false);
        }
      } else {
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
        }
      }
    }

    setupCamera();
    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }, [isCameraActive]);

  // Resize Observer for pixel-perfect skeleton alignment
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const [aiFps, setAiFps] = useState(0);

  // Main Detection Loop (Optimized for Async/Non-Blocking Performance)
  useEffect(() => {
    let animationId: number;
    let frameTimes: number[] = [];

    const loop = () => {
      const now = performance.now();

      if (
        videoRef.current &&
        isCameraActive &&
        videoRef.current.readyState >= 2
      ) {
        // NON-BLOCKING TRIGGER: Kick off AI processing without 'awaiting' it.
        // This ensures the main UI thread never pauses for inference.
        detectHolistic(videoRef.current)
          .then((result) => {
            if (result) {
              setCurrentPose(result.pose);
              setCurrentHands(result.hands);
              setCurrentFace(result.face);

              // Calculate actual AI FPS
              frameTimes.push(performance.now());
              if (frameTimes.length > 30) frameTimes.shift();
              if (frameTimes.length > 1) {
                const fps = Math.round(
                  1000 /
                    ((performance.now() - frameTimes[0]) /
                      (frameTimes.length - 1)),
                );
                setAiFps(fps);
              }

              if (isRecording && isConnected && result.pose) {
                submitFrame(result.pose, result.hands, sport, poseName);
              }
            }
          })
          .catch((err) => {
            console.error('Holistic detection background error:', err);
          });
      }

      animationId = requestAnimationFrame(loop);
    };

    animationId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationId);
  }, [
    detectHolistic,
    isCameraActive,
    isRecording,
    isConnected,
    sport,
    submitFrame,
    poseName,
  ]);

  // Session timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRecording) {
      interval = setInterval(
        () => setSessionDuration((prev) => prev + 1),
        1000,
      );
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const toggleSession = async () => {
    if (isSessionPending) return;
    setIsSessionPending(true);
    setSessionError(null);
    try {
      if (!isRecording) {
        // Start Session
        try {
          const { data } = await api.post('/sessions', { sport });
          if (data.success && data.data) {
            setSessionId(data.data.id);
            startSession(data.data.id, sport, poseName);
            setIsRecording(true);
            setSessionDuration(0);
            setFrameCount(0);
            setAverageScore(0);
            setBestScore(0);
            setCurrentRep(0);
            // Reset stats ref
            sessionStatsRef.current = {
              issues: [],
              phaseScores: {},
              fluidityScores: [],
              trajectorySimilarity: 0,
              maxReps: 0,
            };
          } else {
            setSessionError(
              data.error || 'Your session could not start. Please try again.',
            );
          }
        } catch (err) {
          console.error('Failed to start session:', err);
          setSessionError(
            'Your session could not start. Check your connection and try again.',
          );
        }
      } else {
        // Stop Session
        if (sessionId) {
          try {
            // Build detailed step-wise report
            const stats = sessionStatsRef.current;
            let detailedSummary =
              sport === 'squash'
                ? `Technical Summary:\nExperimental Squash position guide: this score reflects approximate 2D joint alignment, not validated stroke quality. No racket, ball, or grip analysis.\n`
                : `Technical Summary:\n`;

            if (stats.maxReps > 0) {
              detailedSummary += `• ✅ You completed ${stats.maxReps} ${sport} reps!\n`;
            }

            if (Object.keys(stats.phaseScores).length > 0) {
              const avgFluidity =
                stats.fluidityScores.length > 0
                  ? stats.fluidityScores.reduce((a, b) => a + b, 0) /
                    stats.fluidityScores.length
                  : 0;

              if (avgFluidity > 0) {
                detailedSummary += `• ✅ Movement Fluidity: ${Math.round(avgFluidity)}/100\n`;
              }
              if (stats.trajectorySimilarity > 0) {
                detailedSummary += `• ✅ Trajectory Match: ${Math.round(stats.trajectorySimilarity)}%\n`;
              }

              Object.entries(stats.phaseScores).forEach(([phase, score]) => {
                const phaseName = phase.replace(/_/g, ' ');
                if (score >= 80) {
                  detailedSummary += `• ✅ Excellent form during ${phaseName} (Score: ${Math.round(score)})\n`;
                } else if (score < 60) {
                  detailedSummary += `• ❌ Needs focus during ${phaseName} (Score: ${Math.round(score)})\n`;
                }
              });
            }

            // Count issues
            const issueCounts: Record<
              string,
              {
                count: number;
                correction: string;
                problem: string;
                phase?: string;
              }
            > = {};
            stats.issues.forEach((i) => {
              if (
                i.severity === 'high' ||
                i.severity === 'medium' ||
                i.severity === 'warning' ||
                i.severity === 'error'
              ) {
                const key = i.phase ? `${i.phase}:${i.problem}` : i.problem;
                if (!issueCounts[key])
                  issueCounts[key] = {
                    count: 0,
                    correction: i.correction,
                    problem: i.problem,
                    phase: i.phase,
                  };
                issueCounts[key].count++;
              }
            });

            // Sort by frequency, take top 5
            const topIssues = Object.values(issueCounts)
              .sort((a, b) => b.count - a.count)
              .slice(0, 5);

            if (topIssues.length > 0) {
              detailedSummary += `\nDetailed Form Analysis:\n`;
              topIssues.forEach((i) => {
                const contextPrefix = i.phase ? `During ${i.phase}, ` : '';
                // Ensure we don't duplicate 'During phase' if it somehow already exists
                const problemStr = i.problem.toLowerCase().startsWith('during')
                  ? i.problem
                  : `${contextPrefix}${i.problem}`;
                detailedSummary += `• ❌ Incorrect: ${problemStr}\n`;
                detailedSummary += `• 💡 Improve: ${i.correction}\n`;
              });
            } else {
              detailedSummary += `\nDetailed Form Analysis:\n`;
              detailedSummary +=
                sport === 'squash'
                  ? `• Position stayed within the experimental guide for the observed frames.\n`
                  : `• ✅ Outstanding form! No major consistent issues detected across reps.\n`;
            }

            await api.patch(`/sessions/${sessionId}`, {
              duration_s: sessionDuration,
              score: averageScore,
              feedback_summary: detailedSummary,
              frame_count: frameCount,
            });
            stopSession();
            stopAiVoice();
            setIsRecording(false);
            router.push(`/results/${sessionId}`);
          } catch (err) {
            console.error('Failed to stop session:', err);
            setSessionError(
              'Your session could not be saved. Keep this page open and try finishing again.',
            );
          }
        }
      }
    } finally {
      setIsSessionPending(false);
    }
  };

  const dynamic = (currentAnalysis as DynamicFrameAnalysis | null)?.dynamic
    ? (currentAnalysis as DynamicFrameAnalysis)
    : null;
  if (
    ![
      'squash',
      'cricket',
      'tennis',
      'yoga',
      'running',
      'boxing',
      'football',
      'taekwondo',
    ].includes(sport)
  )
    return (
      <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="absolute top-5 right-5">
          <ThemeToggle />
        </div>
        <div className="glass-card max-w-lg p-8 sm:p-12 text-center">
          <div className="clay-icon w-20 h-20 mx-auto mb-7">
            <Focus className="w-8 h-8" />
          </div>
          <h1 className="text-3xl font-semibold mb-4">
            Discipline unavailable
          </h1>
          <p className="text-base text-muted mb-8 leading-relaxed">
            Choose a supported sport to begin a training session.
          </p>
          <Link href="/dashboard" className="btn-primary inline-flex">
            Back to training
          </Link>
        </div>
      </main>
    );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-surface/75 backdrop-blur-xl">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-8 py-5 flex items-center justify-between gap-3">
          <div className="sm:hidden">
            <Brand compact />
          </div>
          <div className="hidden sm:block">
            <Brand />
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href={`/train/${sport}/setup`}
              aria-label="Change training focus"
              className="text-sm text-muted hover:text-foreground hover:bg-surface-raised rounded-2xl p-3 sm:px-4 flex items-center gap-2"
            >
              <ArrowLeft className="w-5 h-5" />
              <span className="hidden sm:inline">Change movement</span>
            </Link>
          </div>
        </div>
      </header>
      <main className="max-w-[1600px] mx-auto px-5 sm:px-8 py-9 sm:py-12">
        {sport === 'squash' && (
          <section
            className="mb-8 rounded-[24px] border border-primary/20 bg-primary/[.06] p-5 sm:p-6"
            aria-label="Experimental Squash coaching"
          >
            <p className="text-sm font-semibold text-primary">
              Experimental Squash coaching
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Body-angle feedback uses broad, app-authored position guides. It
              is not a validated Squash model and does not track a racket, ball,
              grip, or complete stroke. Use comfortable positions; camera
              perspective affects the score.
            </p>
          </section>
        )}
        <div className="flex flex-wrap items-end justify-between gap-5 mb-9">
          <div>
            <p className="text-base font-medium text-primary capitalize mb-3">
              {sport} / {poseName?.replace(/_/g, ' ') || 'Open training'}
            </p>
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-[-0.04em]">
              Training studio
            </h1>
            <p className="text-muted text-base mt-4">
              See your movement. Refine your form.
            </p>
          </div>
          <span className="flex items-center gap-2.5 rounded-full border border-border bg-surface px-4 py-2.5 text-sm">
            <span
              className={`w-2 h-2 rounded-full ${isConnected ? 'bg-secondary' : 'bg-subtle'}`}
            />
            <span className="text-muted">
              {isConnected ? 'Coach connected' : 'Coach offline'}
            </span>
          </span>
        </div>
        <div className="grid xl:grid-cols-[minmax(0,1fr)_350px] gap-7 xl:gap-8 items-start">
          <section className="min-w-0 space-y-5">
            <div
              className="glass-card overflow-hidden"
              style={{ borderRadius: 28 }}
            >
              <div className="px-5 sm:px-7 py-5 flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2.5 text-base font-semibold">
                  <Camera className="w-5 h-5 text-primary" /> Camera preview
                </h2>
                <span className="text-sm text-subtle">
                  {isCameraActive ? 'Live' : 'Camera off'}
                </span>
              </div>
              {cameraError && (
                <div
                  role="alert"
                  className="border-y border-accent-warning/20 bg-accent-warning/5 px-5 sm:px-7 py-4 text-sm leading-relaxed text-accent-warning"
                >
                  {cameraError}
                </div>
              )}
              <div className="px-3 sm:px-4">
                <div
                  ref={containerRef}
                  className={`relative w-full overflow-hidden rounded-[24px] bg-[#08111f] text-white flex items-center justify-center ${isCameraActive && !isAiLoading && !aiError ? 'aspect-[4/3] sm:aspect-video lg:aspect-[16/11] 2xl:aspect-video' : ''}`}
                >
                  {isCameraActive ? (
                    <>
                      <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="absolute inset-0 w-full h-full object-cover mirror"
                      />
                      <PoseSkeleton
                        pose={currentPose}
                        hands={currentHands}
                        face={currentFace}
                        analysis={currentAnalysis}
                        width={dimensions.width}
                        height={dimensions.height}
                        videoWidth={videoRef.current?.videoWidth}
                        videoHeight={videoRef.current?.videoHeight}
                      />
                      <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/50 pointer-events-none" />
                      <div className="absolute top-4 left-4 rounded-full px-3 py-2 bg-black/50 backdrop-blur-lg flex items-center gap-2 text-sm text-white/80">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${currentPose ? 'bg-[#53d8ff]' : 'bg-amber-300'}`}
                        />
                        {currentPose ? 'Body detected' : 'Move into frame'}
                        {aiFps > 0 && (
                          <span className="hidden sm:inline text-white/50 ml-1">
                            {aiFps} fps
                          </span>
                        )}
                      </div>
                      {isRecording && (
                        <div className="absolute top-4 right-4 rounded-full px-3 py-2 bg-black/50 backdrop-blur-lg flex items-center gap-2 text-sm">
                          <span className="w-2 h-2 rounded-full bg-red-400 motion-safe:animate-pulse" />
                          <span className="hidden sm:inline">Recording</span>
                        </div>
                      )}
                      <div className="absolute bottom-4 left-4 right-4 flex items-end justify-between gap-3 pointer-events-none">
                        <p className="text-sm text-white/65">
                          {currentPose
                            ? 'Tracking your movement'
                            : 'Keep your full body visible'}
                        </p>
                        <div className="text-right">
                          <span className="text-sm text-white/60">
                            Session best
                          </span>
                          <p className="text-3xl font-semibold tabular-nums">
                            {Math.round(bestScore)}
                            <span className="text-sm font-normal text-white/50">
                              {' '}
                              / 100
                            </span>
                          </p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="relative w-full min-h-[420px] sm:min-h-[470px] flex flex-col items-center justify-center text-center p-7 sm:p-12">
                      <div
                        aria-hidden="true"
                        className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_35%,rgba(79,142,255,0.12),transparent_68%)]"
                      />
                      <div className="relative w-24 h-24 rounded-[30px] bg-gradient-to-br from-[#233d60] to-[#101d31] border border-white/10 flex items-center justify-center mb-7 shadow-[inset_1px_1px_2px_rgba(255,255,255,.12),0_16px_30px_rgba(0,0,0,.25)]">
                        <Camera className="w-10 h-10 text-[#88b8ff] stroke-[1.5]" />
                      </div>
                      <h2 className="relative text-2xl sm:text-3xl font-semibold tracking-tight">
                        Set up your camera
                      </h2>
                      <p className="relative text-base text-slate-400 leading-relaxed max-w-sm mt-4">
                        Step back until your full body is visible. Start your
                        session when you’re in position.
                      </p>
                      <button
                        disabled={!cameraControlsReady}
                        onClick={() => setIsCameraActive(true)}
                        className="relative btn-primary flex items-center gap-3 mt-7 px-7 py-4 text-base"
                      >
                        <Camera className="w-5 h-5" /> Enable camera
                      </button>
                    </div>
                  )}
                  {isAiLoading && isCameraActive && !aiError && (
                    <div
                      role="status"
                      className="relative w-full min-h-[420px] sm:min-h-[470px] bg-[#08111f]/90 backdrop-blur-lg flex flex-col items-center justify-center z-40 p-7 text-center"
                    >
                      <div className="relative w-24 h-24 flex items-center justify-center mb-8">
                        <motion.div
                          animate={reduceMotion ? {} : { rotate: 360 }}
                          transition={{
                            repeat: Infinity,
                            duration: 2.5,
                            ease: 'linear',
                          }}
                          className="absolute inset-0 rounded-full border border-[#88b8ff]/15 border-t-[#88b8ff]"
                        />
                        <motion.div
                          animate={reduceMotion ? {} : { rotate: -360 }}
                          transition={{
                            repeat: Infinity,
                            duration: 4,
                            ease: 'linear',
                          }}
                          className="absolute inset-3 rounded-full border border-white/5 border-r-[#53d8ff]/60"
                        />
                        <Focus className="w-8 h-8 text-[#88b8ff]" />
                      </div>
                      <h2 className="text-2xl font-semibold mb-4">
                        Preparing your coach
                      </h2>
                      <p className="text-base leading-relaxed text-slate-400 max-w-sm">
                        Loading movement tracking. Your first session may take a
                        little longer.
                      </p>
                    </div>
                  )}
                  {aiError && isCameraActive && (
                    <div
                      role="alert"
                      className="relative w-full min-h-[420px] sm:min-h-[470px] bg-[#08111f]/95 backdrop-blur-xl flex flex-col items-center justify-center z-50 p-7 text-center"
                    >
                      <div className="w-16 h-16 rounded-[24px] bg-amber-400/10 flex items-center justify-center mb-6">
                        <X className="w-7 h-7 text-amber-300" />
                      </div>
                      <h2 className="text-2xl font-semibold mb-4">
                        Tracking unavailable
                      </h2>
                      <p className="text-base text-slate-400 leading-relaxed max-w-sm mb-7">
                        {aiError}. Check that hardware acceleration is enabled
                        in your browser, then try again.
                      </p>
                      <button
                        onClick={() => hardResetHolistic()}
                        className="btn-primary text-base flex items-center gap-3"
                      >
                        <RotateCcw className="w-5 h-5" /> Restart tracking
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-4 justify-between items-center p-5 sm:p-6">
                <div className="flex items-center gap-3">
                  <button
                    aria-label={
                      isCameraActive ? 'Turn camera off' : 'Turn camera on'
                    }
                    title={
                      isRecording
                        ? 'Finish your session before turning off the camera'
                        : isCameraActive
                          ? 'Turn camera off'
                          : 'Turn camera on'
                    }
                    disabled={!cameraControlsReady || isRecording}
                    onClick={() => setIsCameraActive(!isCameraActive)}
                    className={`w-12 h-12 rounded-[18px] border flex items-center justify-center transition-colors disabled:opacity-40 ${isCameraActive ? 'border-primary/25 bg-primary/10 text-primary' : 'border-border bg-surface-raised text-muted hover:text-foreground'}`}
                  >
                    {isCameraActive ? (
                      <Camera className="w-5 h-5" />
                    ) : (
                      <CameraOff className="w-5 h-5" />
                    )}
                  </button>
                  <button
                    onClick={() => hardResetHolistic()}
                    disabled={isRecording || isAiLoading}
                    title="Recalibrate movement tracking"
                    className="w-12 h-12 rounded-[18px] border border-border bg-surface-raised flex items-center justify-center text-muted hover:text-foreground disabled:opacity-30"
                  >
                    <RotateCcw className="w-5 h-5" />
                    <span className="sr-only">Recalibrate tracking</span>
                  </button>
                </div>
                <button
                  disabled={
                    isSessionPending ||
                    (!isRecording &&
                      (!isCameraActive ||
                        isAiLoading ||
                        !!aiError ||
                        !isConnected))
                  }
                  onClick={toggleSession}
                  className={`flex items-center justify-center gap-2 min-h-12 rounded-[18px] px-5 text-base font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isRecording ? 'bg-accent-danger/10 border border-accent-danger/25 text-accent-danger hover:bg-accent-danger/15' : 'btn-primary'}`}
                >
                  {isSessionPending ? (
                    <Loader2 className="w-5 h-5 motion-safe:animate-spin" />
                  ) : isRecording ? (
                    <Square className="w-4 h-4 fill-current" />
                  ) : (
                    <Play className="w-4 h-4 fill-current" />
                  )}
                  {isSessionPending
                    ? isRecording
                      ? 'Saving session…'
                      : 'Starting…'
                    : isRecording
                      ? 'Finish session'
                      : 'Start session'}
                </button>
              </div>
            </div>
            {sessionError && (
              <div
                role="alert"
                className="rounded-[24px] border border-accent-warning/20 bg-accent-warning/5 p-5 text-base leading-relaxed text-accent-warning"
              >
                {sessionError}
              </div>
            )}
            <TrainingStats
              score={currentAnalysis?.score || 0}
              duration={sessionDuration}
              frameCount={frameCount}
              isConnected={isConnected}
              connectionError={connectionError}
              repCount={currentRep}
            />
            <p className="text-sm text-muted leading-relaxed px-2 flex items-start gap-2.5">
              <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5" />
              Use even lighting and leave enough space for your full range of
              movement.
            </p>
          </section>
          <aside className="flex flex-col gap-6 min-w-0">
            <div className="flex items-center justify-between gap-3 px-1">
              <h2 className="font-semibold text-xl">Your coach</h2>
              <span className="text-sm text-subtle">Live feedback</span>
            </div>
            {Boolean(circleId) && Object.keys(coWorkoutMates).length > 0 && (
              <div className="glass-card p-6">
                <p className="text-base font-semibold flex items-center gap-2 mb-5">
                  <Radio className="w-5 h-5 text-primary" />
                  Circle session
                </p>
                <div className="space-y-4">
                  {Object.entries(coWorkoutMates).map(([mateId, score]) => (
                    <div
                      key={mateId}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="text-sm text-muted">
                        Athlete {mateId.substring(0, 4)}
                      </span>
                      <span className="text-base font-medium tabular-nums text-primary">
                        {Math.round(score)} / 100
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {dynamic && (
              <div className="glass-card p-6">
                <p className="text-sm text-primary mb-3">Current movement</p>
                <p className="text-2xl font-semibold capitalize tracking-tight mb-6">
                  {dynamic.current_phase.replace(/_/g, ' ')}
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-surface-inset rounded-[20px] p-4">
                    <p className="text-sm text-muted mb-2">Repetitions</p>
                    <p className="text-3xl text-primary font-semibold tabular-nums">
                      {dynamic.rep_count}
                    </p>
                  </div>
                  {dynamic.trajectory_similarity != null && (
                    <div className="bg-surface-inset rounded-[20px] p-4">
                      <p className="text-sm text-muted mb-2">Match</p>
                      <p className="text-3xl font-semibold tabular-nums">
                        {Math.round(dynamic.trajectory_similarity)}
                        <span className="text-sm text-muted">%</span>
                      </p>
                    </div>
                  )}
                  {dynamic.aqa_grade != null && (
                    <div className="bg-surface-inset rounded-[20px] p-4">
                      <p className="text-sm text-muted mb-2">Quality</p>
                      <p className="text-3xl font-semibold tabular-nums">
                        {Math.round(dynamic.aqa_grade)}
                        <span className="text-sm text-muted">/100</span>
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
            {analysisError ? (
              <div
                className="glass-card p-6 border-accent-warning/25"
                role="status"
              >
                <p className="text-base font-semibold text-accent-warning">
                  Feedback connection interrupted
                </p>
                <p className="text-sm text-muted leading-relaxed mt-3">
                  {analysisError}
                </p>
              </div>
            ) : currentAnalysis ? (
              <ActionableFeedback
                issues={
                  throttledAnalysis?.issues || currentAnalysis.issues || []
                }
              />
            ) : (
              <div className="glass-card p-7">
                <div className="clay-icon w-16 h-16 mb-6">
                  <Focus className="w-7 h-7" />
                </div>
                <p className="text-xl font-semibold">Awaiting session data</p>
                <p className="text-base text-muted leading-relaxed mt-4">
                  Your coach will guide your balance, alignment, and technique
                  as you train.
                </p>
                <div className="space-y-3 text-sm text-muted mt-6 border-t border-border pt-5">
                  {[
                    'Full body in frame',
                    'Steady camera and even lighting',
                    'Clear space to move',
                  ].map((item) => (
                    <p key={item} className="flex items-center gap-2.5">
                      <Check className="w-4 h-4 text-primary shrink-0" />
                      {item}
                    </p>
                  ))}
                </div>
              </div>
            )}
            <PostureReference sport={sport} poseName={poseName} />
            {isRecording && (
              <div className="glass-card p-6 flex items-center justify-between gap-3">
                <div>
                  <p className="text-base font-medium">Session average</p>
                  <p className="text-sm text-muted mt-1">All analysed frames</p>
                </div>
                <p className="text-3xl font-semibold text-primary tabular-nums">
                  {Math.round(averageScore)}
                  <span className="text-sm font-normal text-muted">%</span>
                </p>
              </div>
            )}
          </aside>
        </div>
      </main>
      <style jsx>{`
        .mirror {
          transform: rotateY(180deg);
        }
      `}</style>
    </div>
  );
}
