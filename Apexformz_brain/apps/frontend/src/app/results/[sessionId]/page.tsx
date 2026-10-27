"use client";

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { 
  Trophy, 
  Calendar, 
  Clock, 
  Target, 
  ChevronRight, 
  Share2, 
  RotateCcw,
  LayoutDashboard,
  Zap,
  Star,
  Check,
  CheckCircle,
  XCircle,
  Lightbulb,
  Activity
} from 'lucide-react';
import { api } from '@/lib/api';
import { TrainingSession, PoseFrame } from '@smartcoach/types';
import { loadBrainSession, type StoredBrainSession } from '@/lib/brain/session';
import { BrainResults } from '@/components/brain/BrainResults';

export default function ResultsPage() {
  const { sessionId } = useParams();
  const router = useRouter();
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [frames, setFrames] = useState<PoseFrame[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCopied, setIsCopied] = useState(false);
  const [brain, setBrain] = useState<StoredBrainSession | null>(null);

  useEffect(() => {
    async function loadSession() {
      // On-device Brain sessions keep their summary locally; a local-only session has no backend row.
      const local = loadBrainSession(String(sessionId));
      if (local) {
        setBrain(local);
        setIsLoading(false);
        if (!local.backend_backed) return;
      }
      try {
        const { data } = await api.get(`/sessions/${sessionId}`);
        setSession(data.data);
        setFrames(data.data.frames || []);
      } catch (err) {
        console.error('Failed to load session results:', err);
      } finally {
        setIsLoading(false);
      }
    }
    loadSession();
  }, [sessionId]);

  const handleShare = async () => {
    if (!session) return;
    
    const shareText = `🧠 Apexformz AI Analysis\n\nSport: ${session.sport}\nProficiency Score: ${Math.round(session.score)}/100\nXP Earned: +${session.xp_earned}\nDuration: ${Math.floor(session.duration_s / 60)}:${(session.duration_s % 60).toString().padStart(2, '0')}\n\nCan you beat my score? 🚀`;
    const shareUrl = window.location.href;

    try {
      if (navigator.share) {
        await navigator.share({
          title: 'My Apexformz Training Session',
          text: shareText,
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(`${shareText}\n\n${shareUrl}`);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 3000);
      }
    } catch (err) {
      // AbortError is expected if user cancels the native share sheet
      if ((err as Error).name !== 'AbortError') {
        console.error('Error sharing:', err);
      }
    }
  };

  if (!isLoading && brain) {
    return (
      <div className="min-h-screen bg-background text-white p-8">
        <div className="max-w-5xl mx-auto">
          <header className="mb-12 flex items-center justify-between">
            <div>
              <span className="text-secondary font-bold tracking-widest uppercase text-xs mb-2 block">Training Complete</span>
              <h1 className="text-5xl font-black italic uppercase leading-none tracking-tighter">Brain <span className="text-primary underline decoration-primary/20">Summary</span></h1>
            </div>
            <div className="flex gap-4">
              <button onClick={() => router.push(`/train/${brain.sport}/setup`)} className="p-4 glass-card hover:bg-white/10 transition-colors" title="Train again">
                <RotateCcw className="w-5 h-5 text-secondary" />
              </button>
              <button onClick={() => router.push('/dashboard')} className="p-4 glass-card hover:bg-white/10 transition-colors" title="Dashboard">
                <LayoutDashboard className="w-5 h-5 text-primary" />
              </button>
            </div>
          </header>
          <BrainResults session={brain} />
        </div>
      </div>
    );
  }

  if (isLoading || !session) return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-white p-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-12 flex items-center justify-between">
          <div>
            <span className="text-secondary font-bold tracking-widest uppercase text-xs mb-2 block">Training Complete</span>
            <h1 className="text-5xl font-black italic uppercase leading-none tracking-tighter">Session <span className="text-primary underline decoration-primary/20">Summary</span></h1>
          </div>
          
          <div className="flex gap-4">
            <button 
              onClick={handleShare}
              className="p-4 glass-card hover:bg-white/10 transition-colors flex items-center justify-center"
              title="Share Session"
            >
              {isCopied ? (
                <Check className="w-5 h-5 text-secondary" />
              ) : (
                <Share2 className="w-5 h-5 text-white/50 hover:text-white" />
              )}
            </button>
            <button onClick={() => router.push('/dashboard')} className="p-4 glass-card hover:bg-white/10 transition-colors">
              <LayoutDashboard className="w-5 h-5 text-primary" />
            </button>
          </div>
        </header>

        <div className="grid grid-cols-12 gap-8">
          {/* Main Score Card */}
          <section className="col-span-12 lg:col-span-12 glass-card p-10 bg-gradient-to-br from-primary/10 to-transparent border-primary/20 relative overflow-hidden">
             <div className="absolute top-0 right-0 p-8">
               <Trophy className="w-24 h-24 text-primary opacity-20 rotate-12" />
             </div>
             
             <div className="relative z-10 flex items-center gap-16">
               <div className="flex flex-col">
                 <span className="text-7xl font-black italic tracking-tighter text-glow">{Math.round(session.score)}</span>
                 <span className="text-xs font-bold text-white/30 uppercase tracking-[0.3em]">Final Proficiency Score</span>
               </div>
               
               <div className="h-20 w-px bg-white/10" />
               
               <div className="flex items-center gap-10">
                 <div className="flex flex-col items-center">
                    <span className="text-2xl font-bold text-secondary">+{session.xp_earned}</span>
                    <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest">XP earned</span>
                 </div>
                 <div className="flex flex-col items-center">
                    <span className="text-2xl font-bold">{Math.floor(session.duration_s / 60)}:{(session.duration_s % 60).toString().padStart(2, '0')}</span>
                    <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest">Duration</span>
                 </div>
               </div>
             </div>
          </section>

          {/* Feedback Breakdown */}
          <section className="col-span-7 flex flex-col gap-8">
             {(() => {
               const parts = session.feedback_summary.split('Detailed Form Analysis:');
               const techSummaryLines = parts[0].replace('Technical Summary:', '').split('\n').filter(l => l.trim().length > 0);
               const detailedAnalysisLines = parts.length > 1 ? parts[1].split('\n').filter(l => l.trim().length > 0) : [];

               const renderLine = (line: string, i: number) => {
                  const isTechnical = line.trim().startsWith('•');
                  
                  let icon = <Zap className={`w-4 h-4 mt-1 shrink-0 ${isTechnical ? 'text-primary' : 'text-white/20'}`} />;
                  let borderColor = isTechnical ? 'border-primary/20' : 'border-white/5';
                  let bgColor = isTechnical ? 'bg-primary/5' : 'bg-white/5';
                  let shadowClass = isTechnical ? 'shadow-glow shadow-primary/5' : '';

                  if (line.includes('✅')) {
                    icon = <CheckCircle className="w-4 h-4 mt-1 shrink-0 text-green-400" />;
                    borderColor = 'border-green-500/30';
                    bgColor = 'bg-green-500/10';
                    shadowClass = 'shadow-glow shadow-green-500/10';
                  } else if (line.includes('❌')) {
                    icon = <XCircle className="w-4 h-4 mt-1 shrink-0 text-red-400" />;
                    borderColor = 'border-red-500/30';
                    bgColor = 'bg-red-500/10';
                    shadowClass = 'shadow-glow shadow-red-500/10';
                  } else if (line.includes('💡')) {
                    icon = <Lightbulb className="w-4 h-4 mt-1 shrink-0 text-yellow-400" />;
                    borderColor = 'border-yellow-500/30';
                    bgColor = 'bg-yellow-500/10';
                    shadowClass = 'shadow-glow shadow-yellow-500/10';
                  }

                  const cleanLine = line.replace(/[✅❌💡]/g, '').replace('•', '').trim();

                  return (
                    <div key={i} className={`flex items-start gap-4 p-4 rounded-xl transition-all border ${borderColor} ${bgColor} ${shadowClass}`}>
                      {icon}
                      <p className={`text-sm font-medium leading-relaxed ${isTechnical ? 'text-white' : 'text-white/60'}`}>{cleanLine}</p>
                    </div>
                  );
               };

               return (
                 <>
                   <div className="glass-card p-8">
                     <h3 className="text-sm font-bold tracking-widest uppercase text-white/40 mb-6 flex items-center gap-2">
                       <Target className="w-4 h-4" /> AI Analysis Feedback
                     </h3>
                     <div className="flex flex-col gap-4">
                       {techSummaryLines.map(renderLine)}
                     </div>
                   </div>

                   {detailedAnalysisLines.length > 0 && (
                     <div className="glass-card p-8 border-primary/20 shadow-glow shadow-primary/5 relative overflow-hidden">
                       <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
                       <h3 className="text-sm font-bold tracking-widest uppercase text-primary mb-6 flex items-center gap-2 relative z-10">
                         <Activity className="w-4 h-4" /> Detailed Form Analysis
                       </h3>
                       <div className="flex flex-col gap-4 relative z-10">
                         {detailedAnalysisLines.map(renderLine)}
                       </div>
                     </div>
                   )}
                 </>
               );
             })()}
          </section>

          {/* Training Stats Block */}
          <section className="col-span-5 flex flex-col gap-8">
             <div className="glass-card p-8 flex flex-col gap-6">
                <div className="flex items-center justify-between">
                   <div className="flex flex-col">
                     <span className="text-xs font-bold text-white/20 uppercase tracking-widest mb-1">Consistency</span>
                     <span className="text-2xl font-black">
                       {frames.length > 0 ? Math.round((frames.filter(f => f.frame_score >= 70).length / frames.length) * 100) : 0}%
                     </span>
                   </div>
                   <div className="w-12 h-12 bg-secondary/20 rounded-xl flex items-center justify-center border border-secondary/20 shadow-glow shadow-secondary/10">
                     <Star className="w-6 h-6 text-secondary fill-secondary" />
                   </div>
                </div>
                
                <div className="flex items-center justify-between">
                   <div className="flex flex-col">
                     <span className="text-xs font-bold text-white/20 uppercase tracking-widest mb-1">Power Output</span>
                     <span className="text-2xl font-black">
                       {session.score >= 85 ? 'Elite' : session.score >= 70 ? 'High' : session.score >= 50 ? 'Medium' : 'Low'}
                     </span>
                   </div>
                   <div className="w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center border border-primary/20 shadow-glow shadow-primary/10">
                     <Zap className="w-6 h-6 text-primary fill-primary" />
                   </div>
                </div>
             </div>

             <button 
                onClick={() => router.push(`/train/${session.sport}`)}
                className="w-full btn-secondary text-sm tracking-[0.2em] flex items-center justify-center gap-3 py-4"
             >
               <RotateCcw className="w-4 h-4" /> RETRAIN SESSION
             </button>
          </section>
        </div>
      </div>
    </div>
  );
}
