"use client";

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Camera, CameraOff, X, Play, RotateCcw, ChevronLeft } from 'lucide-react';
import { usePoseDetection } from '@/hooks/usePoseDetection';
import { useWebSocket } from '@/hooks/useWebSocket';
import { PoseSkeleton } from '@/components/PoseSkeleton';
import { TrainingStats } from '@/components/TrainingStats';
import { ActionableFeedback } from '@/components/ActionableFeedback';
import { FrameAnalysis, PoseKeypoints, Sport } from '@smartcoach/types';
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
  const [currentAnalysis, setCurrentAnalysis] = useState<FrameAnalysis | null>(null);
  const [sessionDuration, setSessionDuration] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [averageScore, setAverageScore] = useState(0);

  const { detectPose, isLoading: isModelLoading } = usePoseDetection();
  
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

  const { isConnected, startSession, submitFrame, stopSession } = useWebSocket(onFeedback);

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

  // Main Detection Loop with 30 FPS throttle (GPU accelerated)
  useEffect(() => {
    let animationId: number;
    let lastTime = 0;
    const throttleMs = 1000 / 30; // 30 FPS
    
    async function loop(timestamp: number) {
      if (timestamp - lastTime >= throttleMs) {
        if (videoRef.current && isCameraActive) {
          const pose = await detectPose(videoRef.current);
          if (pose) {
            setCurrentPose(pose);
            if (isRecording && isConnected) {
              submitFrame(pose, sport, poseName);
            }
          }
        }
        lastTime = timestamp;
      }
      animationId = requestAnimationFrame(loop);
    }
    
    animationId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationId);
  }, [detectPose, isCameraActive, isRecording, isConnected, sport, submitFrame, poseName]);

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
            disabled={!isCameraActive || isModelLoading}
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
                analysis={currentAnalysis}
                width={containerRef.current?.clientWidth || 1280}
                height={containerRef.current?.clientHeight || 720}
              />
              
              {/* Camera Overlays */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />
              
              {/* Corner Info */}
              <div className="absolute top-6 left-6 z-20">
                <div className="flex flex-col">
                  <span className="text-2xl font-black uppercase italic text-primary leading-none tracking-tighter">SmartCoach AI</span>
                  <span className="text-xs text-secondary/60 font-medium tracking-widest pl-1">{sport} {poseName ? `/ ${poseName.replace('_', ' ')}` : '/ LIVE INFERENCE'}</span>
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
          
          {isModelLoading && isCameraActive && (
            <div className="absolute inset-0 glass-card bg-black/80 flex flex-col items-center justify-center z-[100]">
              <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mb-6" />
              <p className="text-primary font-bold tracking-widest animate-pulse">LOADING AI POSE ENGINE...</p>
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
