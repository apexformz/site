"use client";

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Camera, CameraOff, X, Play, RotateCcw, ChevronLeft } from 'lucide-react';
import { useHolisticDetection } from '@/hooks/useHolisticDetection';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useVoiceCoaching } from '@/hooks/useVoiceCoaching';
import { PoseSkeleton } from '@/components/PoseSkeleton';
import { TrainingStats } from '@/components/TrainingStats';
import { ActionableFeedback } from '@/components/ActionableFeedback';
import { PostureReference } from '@/components/PostureReference';
import { FrameAnalysis, DynamicFrameAnalysis, PoseKeypoints, Sport, Hand, isBrainSport } from '@smartcoach/types';
import { api } from '@/lib/api';
import BrainTrainingPage from '@/components/brain/BrainTrainingPage';

export default function TrainingPage() {
  const { sport } = useParams() as { sport: Sport };
  // Sport-pack sports run the on-device Brain; legacy sports keep the WebSocket relay below.
  if (isBrainSport(sport)) return <BrainTrainingPage sport={sport} />;
  return <LegacyTrainingPage sport={sport} />;
}

function LegacyTrainingPage({ sport }: { sport: Sport }) {
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const poseName = searchParams?.get('pose') || undefined;
  const router = useRouter();
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentPose, setCurrentPose] = useState<PoseKeypoints | null>(null);
  const [currentHands, setCurrentHands] = useState<Hand[] | null>(null);
  const [currentFace, setCurrentFace] = useState<any[] | null>(null);
  const [currentAnalysis, setCurrentAnalysis] = useState<FrameAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [sessionDuration, setSessionDuration] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [averageScore, setAverageScore] = useState(0);
  const [currentRep, setCurrentRep] = useState(0);
  const [throttledAnalysis, setThrottledAnalysis] = useState<FrameAnalysis | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1280, height: 720 });
  const lastFeedbackUpdateRef = useRef<number>(0);
  const [isAiPulsing, setIsAiPulsing] = useState(false);
  const [coWorkoutMates, setCoWorkoutMates] = useState<Record<string, number>>({});
  
  // Track detailed stats for the step-wise report
  const sessionStatsRef = useRef({
    issues: [] as any[],
    phaseScores: {} as Record<string, number>,
    fluidityScores: [] as number[],
    trajectorySimilarity: 0,
    maxReps: 0
  });

  const circleId = searchParams?.get('circle') || undefined;
  
  const { announce, isSpeaking: isAiSpeaking, stop: stopAiVoice } = useVoiceCoaching();
  const { detectHolistic, hardResetHolistic, isLoading: isAiLoading, error: aiError } = useHolisticDetection();
  
  const onFeedback = useCallback((analysis: FrameAnalysis) => {
    setAnalysisError(null);
    setCurrentAnalysis(analysis);
    setFrameCount(prev => {
      const nextCount = prev + 1;
      setAverageScore(currentAvg => {
        const newScore = (currentAvg * prev + analysis.score) / nextCount;
        return Number.isNaN(newScore) ? analysis.score : newScore;
      });
      return nextCount;
    });
    setBestScore(prev => Math.max(prev, analysis.score));

    // Accumulate detailed stats
    if (analysis.issues && analysis.issues.length > 0) {
      sessionStatsRef.current.issues.push(...analysis.issues);
    }
    
    // Typecast to any to safely check for dynamic fields
    const dynamicAnalysis = analysis as any;
    if (dynamicAnalysis.dynamic) {
      if (dynamicAnalysis.phase_scores) {
        sessionStatsRef.current.phaseScores = { ...sessionStatsRef.current.phaseScores, ...dynamicAnalysis.phase_scores };
      }
      if (dynamicAnalysis.fluidity_score) {
        sessionStatsRef.current.fluidityScores.push(dynamicAnalysis.fluidity_score);
      }
      if (dynamicAnalysis.trajectory_similarity) {
        sessionStatsRef.current.trajectorySimilarity = dynamicAnalysis.trajectory_similarity;
      }
    }

    // VOICE-GUIDED SEQUENTIAL DELIVERY + FREQUENCY THROTTLE
    const activeIssues = analysis.issues?.filter(i => i.severity === 'high' || i.severity === 'medium');
    const now = Date.now();
    
    // Rep-aware logic
    if (dynamicAnalysis.dynamic && dynamicAnalysis.rep_completed) {
      setCurrentRep(dynamicAnalysis.rep_count);
      sessionStatsRef.current.maxReps = Math.max(sessionStatsRef.current.maxReps, dynamicAnalysis.rep_count);
      
      // On rep completion, give immediate feedback about the rep
      if (!isAiSpeaking) {
        if (analysis.score >= 80) {
          announce(`Great rep! Keep it up.`);
        } else if (activeIssues && activeIssues.length > 0) {
          const primaryIssue = activeIssues.find(i => i.severity === 'high') || activeIssues[0];
          announce(`Good rep, but next time, ${primaryIssue.correction}`);
        }
        lastFeedbackUpdateRef.current = now;
      }
    } else {
      // Standard continuous logic
      if (analysis.score >= 80) {
        setThrottledAnalysis({ ...analysis, issues: [] });
        
        if (!isAiSpeaking && (now - lastFeedbackUpdateRef.current > 12000)) {
          announce("Perfect posture. Keep it up!");
          lastFeedbackUpdateRef.current = now;
        }
      } else if (activeIssues && activeIssues.length > 0) {
        setThrottledAnalysis(analysis);

        if (!isAiSpeaking && (now - lastFeedbackUpdateRef.current > 10000)) {
          const primaryIssue = activeIssues.find(i => i.severity === 'high') || activeIssues[0];
          if (primaryIssue) {
            announce(primaryIssue.correction);
            lastFeedbackUpdateRef.current = now;
          }
        }
      }
    }
  }, [isAiSpeaking, announce]);

  const onCoWorkoutSync = useCallback((data: { userId: string, score: number }) => {
    setCoWorkoutMates(prev => ({ ...prev, [data.userId]: data.score }));
  }, []);

  const onFeedbackError = useCallback((message: string) => {
    setAnalysisError(message);
  }, []);

  const { isConnected, connectionError, startSession, submitFrame, stopSession } = useWebSocket(
    onFeedback,
    onCoWorkoutSync,
    onFeedbackError
  );

  // Toggle Camera
  useEffect(() => {
    let stream: MediaStream | null = null;
    
    async function setupCamera() {
      if (isCameraActive) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: 1280, height: 720, facingMode: 'user' }, 
            audio: false 
          });
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        } catch (err) {
          console.error('Camera error:', err);
          setIsCameraActive(false);
        }
      } else {
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
        }
      }
    }
    
    setupCamera();
    return () => {
      if (stream) stream.getTracks().forEach(track => track.stop());
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
          height: entry.contentRect.height
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
      
      if (videoRef.current && isCameraActive && videoRef.current.readyState >= 2) {
        // NON-BLOCKING TRIGGER: Kick off AI processing without 'awaiting' it.
        // This ensures the main UI thread never pauses for inference.
        detectHolistic(videoRef.current).then(result => {
          if (result) {
            setCurrentPose(result.pose);
            setCurrentHands(result.hands);
            setCurrentFace(result.face);
            
            setIsAiPulsing(true);
            setTimeout(() => setIsAiPulsing(false), 100);

            // Calculate actual AI FPS
            frameTimes.push(performance.now());
            if (frameTimes.length > 30) frameTimes.shift();
            if (frameTimes.length > 1) {
              const fps = Math.round(1000 / ((performance.now() - frameTimes[0]) / (frameTimes.length - 1)));
              setAiFps(fps);
            }

            if (isRecording && isConnected && result.pose) {
              submitFrame(result.pose, result.hands, sport, poseName);
            }
          }
        }).catch(err => {
          console.error('Holistic detection background error:', err);
        });
      }
      
      animationId = requestAnimationFrame(loop);
    };

    animationId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationId);
  }, [detectHolistic, isCameraActive, isRecording, isConnected, sport, submitFrame, poseName]);

  // Session timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRecording) {
      interval = setInterval(() => setSessionDuration(prev => prev + 1), 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const toggleSession = async () => {
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
            maxReps: 0
          };
        }
      } catch (err) {
        console.error('Failed to start session:', err);
      }
    } else {
      // Stop Session
      if (sessionId) {
        try {
          // Build detailed step-wise report
          const stats = sessionStatsRef.current;
          let detailedSummary = `Technical Summary:\n`;
          
          if (stats.maxReps > 0) {
            detailedSummary += `• ✅ You completed ${stats.maxReps} ${sport} reps!\n`;
          }
          
          if (Object.keys(stats.phaseScores).length > 0) {
            const avgFluidity = stats.fluidityScores.length > 0 
              ? stats.fluidityScores.reduce((a,b)=>a+b,0) / stats.fluidityScores.length 
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
          const issueCounts: Record<string, { count: number, correction: string, problem: string, phase?: string }> = {};
          stats.issues.forEach(i => {
            if (i.severity === 'high' || i.severity === 'medium' || i.severity === 'warning' || i.severity === 'error') {
              const key = i.phase ? `${i.phase}:${i.problem}` : i.problem;
              if (!issueCounts[key]) issueCounts[key] = { count: 0, correction: i.correction, problem: i.problem, phase: i.phase };
              issueCounts[key].count++;
            }
          });

          // Sort by frequency, take top 5
          const topIssues = Object.values(issueCounts).sort((a,b) => b.count - a.count).slice(0, 5);
          
          if (topIssues.length > 0) {
            detailedSummary += `\nDetailed Form Analysis:\n`;
            topIssues.forEach(i => {
              const contextPrefix = i.phase ? `During ${i.phase}, ` : '';
              // Ensure we don't duplicate 'During phase' if it somehow already exists
              const problemStr = i.problem.toLowerCase().startsWith('during') ? i.problem : `${contextPrefix}${i.problem}`;
              detailedSummary += `• ❌ Incorrect: ${problemStr}\n`;
              detailedSummary += `• 💡 Improve: ${i.correction}\n`;
            });
          } else {
            detailedSummary += `\nDetailed Form Analysis:\n`;
            detailedSummary += `• ✅ Outstanding form! No major consistent issues detected across reps.\n`;
          }

          await api.patch(`/sessions/${sessionId}`, {
            duration_s: sessionDuration,
            score: averageScore,
            feedback_summary: detailedSummary,
            frame_count: frameCount
          });
          stopSession();
          stopAiVoice();
          router.push(`/results/${sessionId}`);
        } catch (err) {
          console.error('Failed to stop session:', err);
        }
      }
      setIsRecording(false);
    }
  };

  return (
    <div className="flex h-screen bg-black overflow-hidden select-none">
      {/* Sidebar Controls */}
      <div className="w-20 bg-background/50 border-r border-white/10 flex flex-col items-center py-8 gap-8 z-50">
        <button onClick={() => router.push(`/train/${sport}/setup`)} className="p-3 glass-card hover:bg-white/10 transition-colors">
          <ChevronLeft className="w-6 h-6" />
        </button>
        
        <div className="flex-1 flex flex-col gap-4">
          <button 
            onClick={() => setIsCameraActive(!isCameraActive)}
            className={`p-4 rounded-2xl transition-all ${isCameraActive ? 'bg-primary text-primary-foreground shadow-glow' : 'glass-card'}`}
          >
            {isCameraActive ? <Camera className="w-6 h-6" /> : <CameraOff className="w-6 h-6" />}
          </button>
          
          <button 
            disabled={!isCameraActive || isAiLoading}
            onClick={toggleSession}
            className={`p-4 rounded-2xl transition-all ${isRecording ? 'bg-accent-danger animate-pulse shadow-glow shadow-accent-danger/40' : 'btn-secondary text-secondary-foreground p-0 w-14 h-14 flex items-center justify-center'}`}
          >
            {isRecording ? <X className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
          </button>
        </div>

        <button onClick={() => window.location.reload()} className="p-3 text-white/40 hover:text-white transition-colors">
          <RotateCcw className="w-6 h-6" />
        </button>
      </div>

      {/* Main Content Area (Camera + Right Feedback Sidebar) */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left/Center Viewport Area */}
        <div className="flex-1 relative flex items-center justify-center p-4">
          <div ref={containerRef} className="relative w-full h-full max-w-5xl aspect-video glass-card overflow-hidden bg-black/40 border-primary/20 flex items-center justify-center shadow-2xl">
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
              
              {/* Debug AI HUD */}
              <div className="absolute top-4 left-4 z-50 bg-black/80 p-3 rounded-lg border border-white/10 text-[10px] font-mono select-none pointer-events-none">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${isAiLoading ? 'bg-yellow-500 animate-pulse' : (aiError ? 'bg-red-500' : 'bg-green-500')}`}></div>
                    <span className="font-bold uppercase tracking-tighter">
                      HOLISTIC AI: {isAiLoading ? 'LOADING' : (aiError ? 'ERROR' : 'READY')}
                      {!isAiLoading && !aiError && ` (${aiFps} FPS)`}
                    </span>
                    {/* Heartbeat Pulse */}
                    <div className="w-1 h-3 bg-white/10 rounded-full overflow-hidden">
                      <div className={`w-full h-full bg-cyan-400 opacity-50 ${isCameraActive && !isAiLoading ? 'animate-pulse' : ''}`}></div>
                    </div>
                  </div>
                  <button 
                    onClick={(e) => { e.stopPropagation(); hardResetHolistic(); }}
                    className="pointer-events-auto ml-4 px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-[8px] uppercase font-bold text-white/70"
                  >
                    Reset AI
                  </button>
                </div>
                {aiError && <div className="text-red-400 mt-1 max-w-[200px] break-words uppercase font-bold text-[8px]">{aiError}</div>}
                {isCameraActive && (
                  <div className="mt-2 text-white/60 border-t border-white/20 pt-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        HANDS: {currentHands?.length || 0} 
                        {currentHands && <div className="w-1 h-1 bg-cyan-400 rounded-full animate-ping"></div>}
                      </div>
                      <div className="flex items-center gap-1">
                        POSE 33: {currentPose ? 'OK' : 'OFF'}
                        {currentPose && <div className="w-1 h-1 bg-primary rounded-full animate-ping"></div>}
                      </div>
                    </div>
                    {currentHands && currentHands.length > 0 && (
                      <div className="text-[8px] text-cyan-400/80 bg-cyan-400/5 px-1 rounded">
                        {currentHands[0].handedness} WRIST: {Math.round(currentHands[0].keypoints[0].x)},{Math.round(currentHands[0].keypoints[0].y)}
                      </div>
                    )}
                  </div>
                )}
              </div>
              
              {/* Camera Overlays */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />
              
              {/* Corner Info */}
              <div className="absolute top-6 left-6 z-20">
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <img src="/logo.png" alt="Apexformz Logo" className="w-8 h-8 object-contain" />
                    <span className="text-2xl font-black uppercase italic text-primary leading-none tracking-tighter">Apexformz AI</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-secondary/60 font-medium tracking-widest uppercase">{sport} {poseName ? `/ ${poseName.replace('_', ' ')}` : '/ LIVE INFERENCE'}</span>
                    <div className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${isAiPulsing ? 'bg-primary shadow-glow shadow-primary' : 'bg-white/10'}`} />
                  </div>
                </div>
              </div>

              {/* Stats Overlay */}
              <div className="absolute bottom-6 left-6 z-30">
                <TrainingStats 
                  score={Math.round(currentAnalysis?.score || 0)}
                  duration={sessionDuration}
                  frameCount={frameCount}
                  isConnected={isConnected}
                  connectionError={connectionError}
                  repCount={currentRep}
                />
              </div>

              {isRecording && (
                <div className="absolute top-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-accent-danger/20 border border-accent-danger/40 px-4 py-1.5 rounded-full z-40">
                  <div className="w-2 h-2 rounded-full bg-accent-danger animate-ping" />
                  <span className="text-xs font-bold tracking-widest text-accent-danger uppercase">Recording Session</span>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-4 text-white/20">
              <CameraOff className="w-24 h-24 mb-4 stroke-[1]" />
              <p className="text-xl font-medium">Camera is disabled</p>
              <button 
                onClick={() => setIsCameraActive(true)}
                className="mt-4 btn-primary text-sm tracking-widest px-8"
              >
                ENABLE CAMERA TO START
              </button>
            </div>
          )}
          
          {isAiLoading && isCameraActive && !aiError && (
            <div className="absolute inset-0 glass-card bg-black/80 flex flex-col items-center justify-center z-[100]">
              <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mb-6" />
              <p className="text-primary font-bold tracking-widest animate-pulse font-mono uppercase text-center">
                Initializing High-Fidelity<br/>Unified AI Engine...
              </p>
            </div>
          )}

          {aiError && (
            <div className="absolute inset-0 glass-card bg-black/80 flex flex-col items-center justify-center z-[110] p-12 text-center">
              <div className="w-20 h-20 rounded-full bg-accent-danger/20 flex items-center justify-center mb-6">
                 <X className="w-10 h-10 text-accent-danger" />
              </div>
              <h2 className="text-2xl font-black uppercase italic text-white mb-2">AI Engine Failed</h2>
              <p className="text-white/60 text-sm max-w-sm mb-8 leading-relaxed">
                {aiError}. This can happen if hardware acceleration is disabled or if the system is overloaded.
              </p>
              <button 
                onClick={() => window.location.reload()}
                className="btn-primary px-12 py-3 text-xs tracking-[0.2em]"
              >
                RELOAD AI ENGINE
              </button>
            </div>
          )}
          </div>
        </div>

        {/* Right Sidebar: AI Recommendations (User Request: Move off camera screen) */}
        <div className="w-80 bg-background/30 border-l border-white/10 p-6 flex flex-col gap-6 overflow-y-auto z-40">
          
          {/* Active Circle Co-Workout View */}
          {Boolean(circleId) && Object.keys(coWorkoutMates).length > 0 ? (
            <div className="bg-primary/10 rounded-xl border border-primary/30 p-4 shrink-0 shadow-lg shadow-primary/5 relative overflow-hidden">
               <div className="absolute top-0 right-0 w-16 h-16 bg-primary/20 rounded-full blur-xl -mr-8 -mt-8" />
               <div className="flex items-center gap-2 mb-4 relative z-10">
                 <div className="w-2 h-2 rounded-full bg-primary animate-ping" />
                 <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Live Co-Workout</h3>
               </div>
               <div className="flex flex-col gap-3 relative z-10">
                 {Object.keys(coWorkoutMates).map((mateId): React.ReactNode => {
                   const score = coWorkoutMates[mateId] as number;
                   return (
                     <div key={mateId} className="flex items-center justify-between bg-black/40 p-2 rounded-lg border border-white/5">
                        <span className="text-xs font-bold text-white/70 uppercase tracking-widest truncate max-w-[100px]">User {mateId.substring(0, 4)}</span>
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1 bg-white/10 rounded-full overflow-hidden">
                             <div className="h-full bg-primary transition-all duration-300" style={{ width: `${score}%` }} />
                          </div>
                          <span className="text-sm font-black italic text-glow text-primary w-8 text-right">{Math.round(score)}</span>
                        </div>
                     </div>
                   );
                 })}
               </div>
            </div>
          ) : null}

          {/* Dynamic AI Tracking */}
          {currentAnalysis && (currentAnalysis as DynamicFrameAnalysis).dynamic ? (
             <div className="bg-primary/10 rounded-xl border border-primary/30 p-4 shrink-0 shadow-lg shadow-primary/5 mb-4 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 h-16 bg-primary/20 rounded-full blur-xl -mr-8 -mt-8" />
                <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-primary mb-2 relative z-10">Dynamic Phase</h3>
                <div className="text-lg font-bold text-white uppercase tracking-wider mb-4 relative z-10">
                  {(currentAnalysis as DynamicFrameAnalysis).current_phase.replace(/_/g, ' ')}
                </div>
                
                <div className="flex gap-4 relative z-10">
                  <div className="flex-1 bg-black/40 rounded-lg p-3 border border-white/5">
                    <div className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-1">Reps</div>
                    <div className="text-2xl font-black text-primary italic">{(currentAnalysis as DynamicFrameAnalysis).rep_count}</div>
                  </div>
                  
                  {((currentAnalysis as DynamicFrameAnalysis).trajectory_similarity !== undefined && (currentAnalysis as DynamicFrameAnalysis).trajectory_similarity !== null) && (
                    <div className="flex-1 bg-black/40 rounded-lg p-3 border border-white/5">
                      <div className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-1">Similarity</div>
                      <div className="text-2xl font-black text-white italic">
                        {Math.round((currentAnalysis as DynamicFrameAnalysis).trajectory_similarity as number)}<span className="text-sm text-white/40">%</span>
                      </div>
                    </div>
                  )}
                  
                  {((currentAnalysis as DynamicFrameAnalysis).aqa_grade !== undefined && (currentAnalysis as DynamicFrameAnalysis).aqa_grade !== null) && (
                    <div className="flex-1 bg-black/40 rounded-lg p-3 border border-white/5 shadow-glow shadow-primary/20">
                      <div className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-1">AQA Grade</div>
                      <div className="text-2xl font-black text-primary italic">
                        {Math.round((currentAnalysis as DynamicFrameAnalysis).aqa_grade as number)}<span className="text-sm text-primary/40">/100</span>
                      </div>
                    </div>
                  )}
                </div>
             </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-black uppercase tracking-[0.2em] text-white/40 mb-2">Real-Time Recommendations</h3>
            <div className="h-px w-10 bg-primary/40" />
          </div>
          
          {/* AI Recommendations */}
          {analysisError ? (
            <div className="glass-card p-6 border-l-4 border-l-accent-danger bg-accent-danger/5">
              <p className="text-sm font-bold text-accent-danger">AI feedback unavailable</p>
              <p className="text-xs text-white/50 mt-2">{analysisError}</p>
            </div>
          ) : currentAnalysis ? (
            <ActionableFeedback issues={throttledAnalysis?.issues || []} />
          ) : (
            <div className="glass-card p-6 border-l-4 border-l-primary bg-primary/5">
              <p className="text-sm font-bold text-primary">Waiting for AI feedback</p>
              <p className="text-xs text-white/50 mt-2">Start recording and keep your full body visible.</p>
            </div>
          )}
          
          {/* Posture Reference (User Request: Show target posture) */}
          <PostureReference sport={sport} poseName={poseName} />

          {isRecording && (
            <div className="mt-auto pt-6 border-t border-white/5">
              <div className="bg-primary/10 rounded-xl p-4 border border-primary/20">
                <p className="text-[10px] text-primary font-bold uppercase tracking-widest mb-1">Session Data</p>
                <div className="text-2xl font-black italic text-white leading-none tracking-tight">
                  {Math.round(averageScore)}% <span className="text-[10px] not-italic text-white/40 uppercase">Avg Acc</span>
                </div>
              </div>
            </div>
          )}
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
