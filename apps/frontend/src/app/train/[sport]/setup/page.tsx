"use client";

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ChevronRight, 
  ChevronLeft, 
  Target, 
  Zap, 
  Activity, 
  Dumbbell, 
  Trophy,
  Focus
} from 'lucide-react';
import { Sport } from '@smartcoach/types';

const SPORT_CONFIG: Record<string, { 
  title: string, 
  description: string,
  thematicColor: string,
  poses: { id: string, name: string, description: string, difficulty: 'Beginner' | 'Intermediate' | 'Pro' }[] 
}> = {
  cricket: {
    title: "Cricket Mastery",
    description: "Refine your technique with targeted shot and delivery analysis.",
    thematicColor: "#00E0FF",
    poses: [
      { id: "batting_stance", name: "Batting Stance", description: "Optimize your balance and elbow position for a perfect drive.", difficulty: "Beginner" },
      { id: "bowling_loadup", name: "Bowling Load-up", description: "Ensure your shoulder alignment and jump-off are synchronized.", difficulty: "Intermediate" },
      { id: "fielding_ready", name: "Fielding Ready", description: "Stay low and reactive for lightning-fast catches.", difficulty: "Beginner" }
    ]
  },
  tennis: {
    title: "Tennis Precision",
    description: "Master the court with AI-guided stroke analysis.",
    thematicColor: "#C9FF00",
    poses: [
      { id: "serve_trophy", name: "Serve Trophy", description: "Find the perfect 'Trophy Pose' for maximum explosive power.", difficulty: "Intermediate" },
      { id: "forehand_top", name: "Forehand Top", description: "Optimize your wrist lag and shoulder rotation on the windup.", difficulty: "Beginner" },
      { id: "ready_position", name: "Ready Position", description: "Balance your weight for quick lateral movement.", difficulty: "Beginner" }
    ]
  },
  yoga: {
    title: "Yoga Flow",
    description: "Achieve perfect alignment and inner harmony.",
    thematicColor: "#FF00E5",
    poses: [
      { id: "warrior_2", name: "Warrior II", description: "Focus on arm level and knee alignment for stability.", difficulty: "Beginner" },
      { id: "tree_pose", name: "Tree Pose", description: "Master your vertical balance and core engagement.", difficulty: "Intermediate" },
      { id: "downward_dog", name: "Downward Dog", description: "Optimize the inversion of your spine and hip elevation.", difficulty: "Intermediate" }
    ]
  },
  running: {
    title: "Running Form",
    description: "Drill down into your biomechanics for maximum efficiency.",
    thematicColor: "#FF5C00",
    poses: [
      { id: "mid_stride", name: "Mid-Stride", description: "Analyze your lean and arm pump at peak velocity.", difficulty: "Intermediate" },
      { id: "starting_block", name: "Starting Block", description: "Ensure the optimal 45-degree angle for explosive starts.", difficulty: "Pro" },
      { id: "sprint_form", name: "Sprint Form", description: "Focus on knee height and foot strike positioning.", difficulty: "Pro" }
    ]
  },
  boxing: {
    title: "Boxing Performance",
    description: "Sharpen your strikes and defensive architecture.",
    thematicColor: "#FF0000",
    poses: [
      { id: "guard_stance", name: "Guard Stance", description: "AI checks your chin tuck and glove placement.", difficulty: "Beginner" },
      { id: "lead_jab", name: "Lead Jab", description: "Focus on full extension and shoulder protection.", difficulty: "Beginner" },
      { id: "right_cross", name: "Right Cross", description: "Analyze your pivot and power transfer from the rear foot.", difficulty: "Intermediate" }
    ]
  },
  football: {
    title: "Football Technique",
    description: "Improve your technical execution on the pitch.",
    thematicColor: "#00FF47",
    poses: [
      { id: "kick_prepare", name: "Kick Preparation", description: "Optimize your plant foot and swing back for power accuracy.", difficulty: "Intermediate" },
      { id: "header_jump", name: "Header Projection", description: "Check your vertical alignment and back arch for powerful headers.", difficulty: "Pro" },
      { id: "ready_stance", name: "Defensive Stance", description: "Stay springy and low to intercept rapid attacks.", difficulty: "Beginner" }
    ]
  }
};

export default function SetupPage() {
  const { sport } = useParams() as { sport: Sport };
  const router = useRouter();
  const config = SPORT_CONFIG[sport] || SPORT_CONFIG.cricket;
  const [selectedPose, setSelectedPose] = useState(config.poses[0].id);

  const handleStart = () => {
    router.push(`/train/${sport}?pose=${selectedPose}`);
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div 
          className="absolute -top-[20%] -right-[10%] w-[60%] h-[60%] blur-[120px] opacity-20 rounded-full" 
          style={{ backgroundColor: config.thematicColor }}
        />
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] opacity-10" />
      </div>

      <header className="relative z-10 p-8 flex items-center justify-between border-b border-white/5 bg-black/40 backdrop-blur-md">
        <div className="flex items-center gap-6">
          <button onClick={() => router.push('/dashboard')} className="p-3 glass-card hover:bg-white/10 transition-colors">
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div>
            <h1 className="text-3xl font-black italic uppercase tracking-tighter leading-none">{config.title}</h1>
            <p className="text-xs text-white/40 font-bold tracking-widest uppercase mt-1">Training Configuration</p>
          </div>
        </div>
        
        <div className="hidden md:flex items-center gap-4 px-6 py-2 glass-card border-white/10">
          <Activity className="w-4 h-4 text-primary" />
          <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-white/60">AI Engine Ready</span>
        </div>
      </header>

      <main className="relative z-10 flex-1 max-w-6xl mx-auto w-full grid grid-cols-1 md:grid-cols-12 gap-12 p-8 items-center">
        {/* Left Aspect: Selection */}
        <div className="md:col-span-7 flex flex-col gap-8">
          <div className="mb-4">
             <h2 className="text-4xl font-black italic uppercase tracking-tight mb-4">Choose your <span className="text-primary underline decoration-primary/20">Focus</span></h2>
             <p className="text-white/60 max-w-md leading-relaxed">{config.description}</p>
          </div>

          <div className="flex flex-col gap-4">
            {config.poses.map((pose) => (
              <motion.button
                key={pose.id}
                whileHover={{ x: 10 }}
                onClick={() => setSelectedPose(pose.id)}
                className={`group relative p-6 text-left transition-all rounded-3xl border-2 flex items-center justify-between ${
                  selectedPose === pose.id 
                    ? 'bg-white/10 border-primary shadow-glow shadow-primary/10' 
                    : 'bg-white/5 border-transparent hover:bg-white/10'
                }`}
              >
                <div className="flex items-center gap-6">
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                    selectedPose === pose.id ? 'bg-primary text-black' : 'bg-white/5 text-white/40'
                  }`}>
                    {pose.id.includes('stance') || pose.id.includes('ready') ? <Target className="w-6 h-6" /> : <Zap className="w-6 h-6" />}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">{pose.name}</h3>
                    <p className="text-xs text-white/40 mt-1">{pose.description}</p>
                  </div>
                </div>
                
                <div className="flex flex-col items-end gap-2">
                  <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-md border ${
                    pose.difficulty === 'Pro' ? 'text-accent-danger border-accent-danger/20' : 
                    pose.difficulty === 'Intermediate' ? 'text-secondary border-secondary/20' : 
                    'text-primary border-primary/20'
                  }`}>
                    {pose.difficulty}
                  </span>
                  {selectedPose === pose.id && (
                    <motion.div layoutId="check" className="text-primary">
                      <Focus className="w-5 h-5" />
                    </motion.div>
                  )}
                </div>
              </motion.button>
            ))}
          </div>
        </div>

        {/* Right Aspect: Preview/Start */}
        <div className="md:col-span-5 flex flex-col items-center justify-center">
           <div className="relative w-full aspect-square glass-card rounded-full flex items-center justify-center border-white/5 overflow-hidden group">
              <div 
                className="absolute inset-0 opacity-10 group-hover:opacity-20 transition-opacity" 
                style={{ 
                  background: `radial-gradient(circle at center, ${config.thematicColor}, transparent 70%)` 
                }} 
              />
              
              <Dumbbell className="w-32 h-32 text-white/10 group-hover:scale-110 transition-transform duration-700" />
              
              <div className="absolute inset-10 border border-white/5 rounded-full animate-[spin_20s_linear_infinite]" />
              <div className="absolute inset-20 border border-dashed border-primary/20 rounded-full animate-[spin_15s_linear_infinite_reverse]" />

              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-12 text-center">
                 <Trophy className="w-12 h-12 text-primary drop-shadow-glow" />
                 <h4 className="text-lg font-bold uppercase tracking-widest mt-4">Live Tracking</h4>
                 <p className="text-xs text-white/40">Our AI Pose Engine will provide millisecond precision feedback on your {config.poses.find(p => p.id === selectedPose)?.name}.</p>
              </div>
           </div>

           <button 
             onClick={handleStart}
             className="w-full mt-12 py-5 rounded-full bg-primary text-black font-black uppercase italic tracking-widest text-lg shadow-glow hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-4"
           >
              Enter Arena <ChevronRight className="w-6 h-6" />
           </button>
           
           <p className="mt-6 text-[10px] text-white/20 uppercase tracking-[0.3em] font-bold">Recommended: Stable lighting & Full silhouette visibility</p>
        </div>
      </main>
    </div>
  );
}
