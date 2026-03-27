"use client";

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Camera, CameraOff, X, Play, RotateCcw, ChevronLeft } from 'lucide-react';
import { useHolisticDetection } from '@/hooks/useHolisticDetection';
import { useWebSocket } from '@/hooks/useWebSocket';
import { PoseSkeleton } from '@/components/PoseSkeleton';
import { TrainingStats } from '@/components/TrainingStats';
import { ActionableFeedback } from '@/components/ActionableFeedback';
import { FrameAnalysis, PoseKeypoints, Sport, Hand } from '@smartcoach/types';
import { api } from '@/lib/api';

export default function TrainingPage() {
  const { sport } = useParams() as { sport: Sport };
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
  const [currentAnalysis, setCurrentAnalysis] = useState<FrameAnalysis | null>(null);
  const [sessionDuration, setSessionDuration] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [averageScore, setAverageScore] = useState(0);
  const [dimensions, setDimensions] = useState({ width: 1280, height: 720 });
  const [isAiPulsing, setIsAiPulsing] = useState(false);

  const { detectHolistic, isLoading: isAiLoading, error: aiError } = useHolisticDetection();
  
  const onFeedback = useCallback((analysis: FrameAnalysis) => {
    setCurrentAnalysis(analysis);
    setFrameCount(prev => {
      const nextCount = prev + 1;
      setAverageScore(currentAvg => {
        const newScore = (currentAvg * prev + analysis.frame_score) / nextCount;
        return Number.isNaN(newScore) ? analysis.frame_score : newScore;
      });
      return nextCount;
    });
    setBestScore(prev => Math.max(prev, analysis.frame_score));
  }, []);

  const { isConnected, connectionError, startSession, submitFrame, stopSession } = useWebSocket(onFeedback);

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

  // Main Detection Loop with 30 FPS throttle
  useEffect(() => {
    let animationId: number;
    let lastTime = 0;
    const throttleMs = 1000 / 30;
    
    async function loop(timestamp: number) {
      if (timestamp - lastTime >= throttleMs) {
        if (videoRef.current && isCameraActive) {
          try {
            // Unified Holistic Detection (Body + Hands + Face)
            const result = await detectHolistic(videoRef.current);

            if (result?.pose) {
              setCurrentPose(result.pose);
              setCurrentHands(result.hands);
              
              setIsAiPulsing(true);
              setTimeout(() => setIsAiPulsing(false), 150);

              if (isRecording && isConnected) {
                submitFrame(result.pose, result.hands, sport, poseName);
              }
            }
          } catch (err) {
            console.error('Holistic detection error:', err);
          }
        }
        lastTime = timestamp;
      }
      animationId = requestAnimationFrame(loop);
    }
    
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
        }
      } catch (err) {
        console.error('Failed to start session:', err);
      }
    } else {
      // Stop Session
      if (sessionId) {
        try {
          await api.patch(`/sessions/${sessionId}`, {
            duration_s: sessionDuration,
            score: averageScore,
            feedback_summary: `Completed ${sport} (${poseName || 'standard'}) training session with avg score ${Math.round(averageScore)}`,
            frame_count: frameCount
          });
          stopSession();
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

      {/* Viewport Area */}
      <main className="flex-1 relative flex items-center justify-center p-4">
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
                analysis={currentAnalysis}
                width={dimensions.width}
                height={dimensions.height}
                videoWidth={videoRef.current?.videoWidth}
                videoHeight={videoRef.current?.videoHeight}
              />
              
              {/* Debug AI HUD */}
              <div className="absolute top-4 left-4 z-50 bg-black/80 p-3 rounded-lg border border-white/10 text-[10px] font-mono select-none pointer-events-none">
                <div className="flex items-center gap-2 mb-1">
                  <div className={`w-2 h-2 rounded-full ${isAiLoading ? 'bg-yellow-500 animate-pulse' : (aiError ? 'bg-red-500' : 'bg-green-500')}`}></div>
                  <span className="font-bold">HOLISTIC AI: {isAiLoading ? 'INITIALIZING' : (aiError ? 'ERROR' : 'ONLINE')}</span>
                </div>
                {aiError && <div className="text-red-400 mt-1 max-w-[200px] break-words uppercase font-bold">{aiError}</div>}
                {isCameraActive && (
                  <div className="mt-2 text-white/60 border-t border-white/10 pt-2">
                    <div>Hands: {currentHands?.length || 0}</div>
                    {currentHands && currentHands.length > 0 && (
                      <div className="text-[8px] text-cyan-400">
                        {currentHands[0].handedness} Wrist: {Math.round(currentHands[0].keypoints[0].x)}, {Math.round(currentHands[0].keypoints[0].y)}
                      </div>
                    )}
                    <div>Pose 33: {currentPose ? 'OK' : 'OFF'}</div>
                  </div>
                )}
              </div>
              
              {/* Camera Overlays */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />
              
              {/* Corner Info */}
              <div className="absolute top-6 left-6 z-20">
                <div className="flex flex-col">
                  <span className="text-2xl font-black uppercase italic text-primary leading-none tracking-tighter">SmartCoach AI</span>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-secondary/60 font-medium tracking-widest uppercase">{sport} {poseName ? `/ ${poseName.replace('_', ' ')}` : '/ LIVE INFERENCE'}</span>
                    <div className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${isAiPulsing ? 'bg-primary shadow-glow shadow-primary' : 'bg-white/10'}`} />
                  </div>
                </div>
              </div>

              {/* Feedback Stack */}
              <div className="absolute top-6 right-6 z-30">
                <ActionableFeedback feedbacks={currentAnalysis?.feedback || []} />
              </div>

              {/* Stats Overlay */}
              <div className="absolute bottom-6 left-6 z-30">
                <TrainingStats 
                  score={currentAnalysis?.frame_score || 0}
                  duration={sessionDuration}
                  frameCount={frameCount}
                  isConnected={isConnected}
                  connectionError={connectionError}
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
      </main>

      <style jsx>{`
        .mirror {
          transform: rotateY(180deg);
        }
      `}</style>
    </div>
  );
}
