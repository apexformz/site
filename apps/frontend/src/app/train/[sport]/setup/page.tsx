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
  Focus,
  Star,
  Flame,
  TrendingUp,
  Wind
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
      { id: "batting_stance", name: "Batting Stance", description: "Optimize your balance and head position.", difficulty: "Beginner" },
      { id: "bowling_loadup", name: "Bowling Load-up", description: "Sync your shoulder and jump-off.", difficulty: "Intermediate" },
      { id: "fielding_ready", name: "Fielding Ready", description: "Stay low and reactive for catches.", difficulty: "Beginner" },
      { id: "cover_drive", name: "Cover Drive", description: "Perfect the elbow-head alignment.", difficulty: "Intermediate" },
      { id: "pull_shot", name: "Pull Shot", description: "Analysis of weight transfer and pivot.", difficulty: "Intermediate" },
      { id: "wicket_keeping", name: "Wicket Keeping", description: "Deep crouch and hand positioning.", difficulty: "Intermediate" },
      { id: "spin_release", name: "Spin Release", description: "Focus on wrist flick and follow-through.", difficulty: "Pro" },
      { id: "backfoot_defense", name: "Backfoot Defense", description: "Solidify your defensive wall.", difficulty: "Beginner" },
      { id: "slip_catching", name: "Slip Catching", description: "Refine the low-capture reflex.", difficulty: "Intermediate" },
      { id: "sweep_shot", name: "Sweep Shot", description: "Balance check for the sweep.", difficulty: "Pro" }
    ]
  },
  tennis: {
    title: "Tennis Precision",
    description: "Master the court with AI-guided stroke analysis.",
    thematicColor: "#C9FF00",
    poses: [
      { id: "serve_trophy", name: "Serve Trophy", description: "Find the explosive 'Trophy Pose'.", difficulty: "Intermediate" },
      { id: "forehand_top", name: "Forehand Top", description: "Wrist lag and shoulder rotation.", difficulty: "Beginner" },
      { id: "ready_position", name: "Ready Position", description: "Weight distribution for speed.", difficulty: "Beginner" },
      { id: "backhand_split", name: "Backhand Split", description: "Timing on the split step.", difficulty: "Intermediate" },
      { id: "volley_ready", name: "Volley Ready", description: "Compact form for net play.", difficulty: "Beginner" },
      { id: "overhead_smash", name: "Overhead Smash", description: "Full extension and timing check.", difficulty: "Pro" },
      { id: "return_stance", name: "Return Stance", description: "Reactive posture for power serves.", difficulty: "Intermediate" },
      { id: "slice_backhand", name: "Slice Backhand", description: "Angle and follow-through check.", difficulty: "Intermediate" },
      { id: "half_volley", name: "Half Volley", description: "Low balance and soft hands.", difficulty: "Pro" },
      { id: "drop_shot", name: "Drop Shot", description: "Deception and wrist control.", difficulty: "Pro" }
    ]
  },
  yoga: {
    title: "Yoga Flow",
    description: "Achieve perfect alignment and inner harmony.",
    thematicColor: "#FF00E5",
    poses: [
      { id: "warrior_2", name: "Warrior II", description: "Focus on arm level and knee alignment.", difficulty: "Beginner" },
      { id: "tree_pose", name: "Tree Pose", description: "Master vertical balance and core.", difficulty: "Intermediate" },
      { id: "downward_dog", name: "Downward Dog", description: "Spine inversion and hip elevation.", difficulty: "Intermediate" },
      { id: "triangle_pose", name: "Triangle Pose", description: "Lateral stretch and hand placement.", difficulty: "Intermediate" },
      { id: "cobra_pose", name: "Cobra Pose", description: "Upper back strength and gaze.", difficulty: "Beginner" },
      { id: "plank_pose", name: "Plank Pose", description: "Perfect horizontal core alignment.", difficulty: "Beginner" },
      { id: "bridge_pose", name: "Bridge Pose", description: "Glute activation and shoulder base.", difficulty: "Beginner" },
      { id: "childs_pose", name: "Child's Pose", description: "Restorative depth and relaxation.", difficulty: "Beginner" },
      { id: "cat_cow", name: "Cat-Cow Flow", description: "Spinal mobility and breath sync.", difficulty: "Beginner" },
      { id: "chair_pose", name: "Chair Pose", description: "Quad endurance and alignment.", difficulty: "Intermediate" }
    ]
  },
  running: {
    title: "Running Form",
    description: "Drill down into your biomechanics for maximum efficiency.",
    thematicColor: "#FF5C00",
    poses: [
      { id: "mid_stride", name: "Mid-Stride", description: "Analyze peak velocity arm pump.", difficulty: "Intermediate" },
      { id: "starting_block", name: "Starting Block", description: "Explosive 45-degree start angle.", difficulty: "Pro" },
      { id: "sprint_form", name: "Sprint Form", description: "Knee height and foot strike.", difficulty: "Pro" },
      { id: "heel_strike", name: "Heel Strike Check", description: "Ensure safe impact transition.", difficulty: "Intermediate" },
      { id: "knee_drive", name: "High Knee Drive", description: "Power generation technique.", difficulty: "Pro" },
      { id: "arm_swing", name: "Arm Swing Path", description: "Minimize lateral energy loss.", difficulty: "Beginner" },
      { id: "uphill_lean", name: "Uphill Lean", description: "Center of mass for climbing.", difficulty: "Intermediate" },
      { id: "downhill_brake", name: "Downhill Braking", description: "Impact management and control.", difficulty: "Intermediate" },
      { id: "recovery_phase", name: "Recovery Mechanics", description: "Efficient leg swing throughput.", difficulty: "Pro" },
      { id: "posture_check", name: "Vertical Posture", description: "Maintain core during fatigue.", difficulty: "Beginner" }
    ]
  },
  boxing: {
    title: "Boxing Performance",
    description: "Sharpen your strikes and defensive architecture.",
    thematicColor: "#FF0000",
    poses: [
      { id: "guard_stance", name: "Guard Stance", description: "AI checks chin and glove placement.", difficulty: "Beginner" },
      { id: "lead_jab", name: "Lead Jab", description: "Extension and shoulder protection.", difficulty: "Beginner" },
      { id: "right_cross", name: "Right Cross", description: "Pivot and rear-foot power.", difficulty: "Intermediate" },
      { id: "lead_hook", name: "Lead Hook", description: "Elbow height and torso torque.", difficulty: "Intermediate" },
      { id: "lead_uppercut", name: "Lead Uppercut", description: "Drive from the legs up.", difficulty: "Intermediate" },
      { id: "rear_uppercut", name: "Rear Uppercut", description: "Hip rotation and impact angle.", difficulty: "Intermediate" },
      { id: "bob_and_weave", name: "Bob & Weave", description: "Head movement and low balance.", difficulty: "Intermediate" },
      { id: "slip_left", name: "Slip Left", description: "Quick weight shift and evasion.", difficulty: "Pro" },
      { id: "slip_right", name: "Slip Right", description: "Defensive angle and readiness.", difficulty: "Pro" },
      { id: "pivot_check", name: "Foot Pivot", description: "360-degree mobility verification.", difficulty: "Pro" }
    ]
  },
  football: {
    title: "Football Technique",
    description: "Improve your technical execution on the pitch.",
    thematicColor: "#00FF47",
    poses: [
      { id: "kick_prepare", name: "Kick Preparation", description: "Plant foot and swing back.", difficulty: "Intermediate" },
      { id: "header_jump", name: "Header Projection", description: "Vertical alignment and arch.", difficulty: "Pro" },
      { id: "ready_stance", name: "Defensive Stance", description: "Springy posture for intercept.", difficulty: "Beginner" },
      { id: "throw_in", name: "Throw-In Form", description: "Full arc and balanced release.", difficulty: "Beginner" },
      { id: "goalkeeper_dive", name: "Keeper Dive", description: "Full extension and hand spread.", difficulty: "Pro" },
      { id: "chest_trap", name: "Chest Control", description: "Impact absorption and lean.", difficulty: "Intermediate" },
      { id: "sprint_dribble", name: "Dribble Posture", description: "Keep ball close under control.", difficulty: "Intermediate" },
      { id: "sliding_tackle", name: "Tackle Safety", description: "Leg extension and impact point.", difficulty: "Pro" },
      { id: "volley_kick", name: "Full Volley", description: "In-air timing and weight shift.", difficulty: "Pro" },
      { id: "penalty_look", name: "Penalty Focus", description: "Composed stance and alignment.", difficulty: "Intermediate" }
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

      <main className="relative z-10 flex-1 max-w-7xl mx-auto w-full grid grid-cols-1 md:grid-cols-12 gap-12 p-8">
        {/* Left Aspect: Selection */}
        <div className="md:col-span-7 flex flex-col gap-8 h-[calc(100vh-200px)] overflow-hidden">
          <div className="mb-0">
             <h2 className="text-4xl font-black italic uppercase tracking-tight mb-4">Choose your <span className="text-primary underline decoration-primary/20">Focus</span></h2>
             <p className="text-white/60 max-w-md leading-relaxed text-sm">{config.description}</p>
          </div>

          <div className="flex-1 overflow-y-auto pr-4 custom-scrollbar flex flex-col gap-3">
            {config.poses.map((pose) => (
              <motion.button
                key={pose.id}
                whileHover={{ x: 5 }}
                onClick={() => setSelectedPose(pose.id)}
                className={`group relative p-4 text-left transition-all rounded-2xl border flex items-center justify-between ${
                  selectedPose === pose.id 
                    ? 'bg-white/10 border-primary/50 shadow-glow shadow-primary/5' 
                    : 'bg-white/5 border-transparent hover:bg-white/10'
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${
                    selectedPose === pose.id ? 'bg-primary text-black' : 'bg-white/5 text-white/40'
                  }`}>
                    {pose.difficulty === 'Pro' ? <Star className="w-5 h-5" /> : 
                     pose.difficulty === 'Intermediate' ? <Zap className="w-5 h-5" /> : 
                     <Target className="w-5 h-5" />}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold leading-none mb-1">{pose.name}</h3>
                    <p className="text-[10px] text-white/30 truncate max-w-[250px]">{pose.description}</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-4">
                  <span className={`text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${
                    pose.difficulty === 'Pro' ? 'text-accent-danger border-accent-danger/20' : 
                    pose.difficulty === 'Intermediate' ? 'text-secondary border-secondary/20' : 
                    'text-primary border-primary/20'
                  }`}>
                    {pose.difficulty}
                  </span>
                  {selectedPose === pose.id && (
                    <Focus className="w-4 h-4 text-primary" />
                  )}
                </div>
              </motion.button>
            ))}
          </div>
        </div>

        {/* Right Aspect: Preview/Start */}
        <div className="md:col-span-5 flex flex-col items-center justify-center sticky top-0">
           <div className="relative w-full aspect-square glass-card rounded-3xl flex items-center justify-center border-white/5 overflow-hidden group">
              <div 
                className="absolute inset-0 opacity-10 group-hover:opacity-20 transition-opacity" 
                style={{ 
                  background: `radial-gradient(circle at center, ${config.thematicColor}, transparent 70%)` 
                }} 
              />
              
              <div className="relative z-10 flex flex-col items-center gap-6 p-12 text-center">
                 <div className="w-20 h-20 rounded-full border-2 border-primary/20 flex items-center justify-center relative">
                    <Trophy className="w-10 h-10 text-primary drop-shadow-glow" />
                    <div className="absolute inset-0 border border-primary animate-ping rounded-full opacity-20" />
                 </div>
                 
                 <div>
                   <h4 className="text-xl font-bold uppercase tracking-widest">{config.poses.find(p => p.id === selectedPose)?.name}</h4>
                   <p className="text-xs text-secondary mt-2 font-bold tracking-widest uppercase">{config.poses.find(p => p.id === selectedPose)?.difficulty} DRILL</p>
                 </div>
                 
                 <p className="text-xs text-white/40 leading-relaxed italic">"AI Tracking optimized for this specific movement. Ensure full body visibility for millisecond precision."</p>
              </div>
              
              <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/5">
                 <motion.div 
                   initial={{ width: 0 }}
                   animate={{ width: '100%' }}
                   transition={{ duration: 2, repeat: Infinity }}
                   className="h-full bg-primary"
                 />
              </div>
           </div>

           <button 
             onClick={handleStart}
             className="w-full mt-8 py-5 rounded-2xl bg-primary text-black font-black uppercase italic tracking-widest text-lg shadow-glow hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-4"
           >
              Enter Arena <ChevronRight className="w-6 h-6" />
           </button>
           
           <div className="mt-6 grid grid-cols-2 gap-4 w-full">
              <div className="p-3 glass-card border-white/5 rounded-xl flex items-center gap-3">
                 <Zap className="w-4 h-4 text-secondary" />
                 <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">30 FPS Sync</span>
              </div>
              <div className="p-3 glass-card border-white/5 rounded-xl flex items-center gap-3">
                 <Focus className="w-4 h-4 text-primary" />
                 <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">GPU Active</span>
              </div>
           </div>
        </div>
      </main>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.02);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(var(--primary-rgb), 0.2);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(var(--primary-rgb), 0.5);
        }
      `}</style>
    </div>
  );
}
