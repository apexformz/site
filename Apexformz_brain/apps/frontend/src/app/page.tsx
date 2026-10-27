"use client";

import React from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Activity, Play, ChevronRight, Zap, Target, Trophy } from 'lucide-react';

export default function LandingPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-background text-white flex flex-col items-center justify-center p-8 relative overflow-hidden">
      {/* Background elements */}
      <div className="absolute top-0 left-0 w-full h-full bg-[url('/grid.svg')] bg-center [mask-image:linear-gradient(180deg,white,rgba(255,255,255,0))] -z-10" />
      <div className="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] bg-primary/20 rounded-full blur-[120px] -z-10 animate-pulse-slow" />
      <div className="absolute -bottom-[20%] -right-[10%] w-[60%] h-[60%] bg-secondary/10 rounded-full blur-[120px] -z-10" />

      <motion.div 
        initial={{ y: 30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8 }}
        className="text-center z-10 max-w-4xl"
      >
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 mb-8 backdrop-blur-md">
          <img src="/logo.png" alt="Apexformz Logo" className="w-5 h-5 object-contain" />
          <span className="text-xs font-bold tracking-[0.2em] uppercase text-white/60">Next-Gen AI Coaching</span>
        </div>
        
        <h1 className="text-7xl md:text-8xl font-black italic uppercase tracking-tighter leading-none mb-8">
          Master Your <br />
          <span className="text-primary text-glow italic">Technique</span>
        </h1>
        
        <p className="text-xl md:text-2xl text-white/40 font-medium mb-12 max-w-2xl mx-auto leading-relaxed">
          Democratizing elite sports coaching with real-time pose estimation and actionable AI-driven feedback.
        </p>
        
        <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
          <button 
            onClick={() => router.push('/login')}
            className="btn-primary py-5 px-10 text-lg flex items-center gap-3 group"
          >
            START TRAINING <Play className="w-5 h-5 fill-primary-foreground group-hover:scale-110 transition-transform" />
          </button>
          <button 
            onClick={() => router.push('/register')}
            className="glass-card py-5 px-10 text-lg font-bold border-white/20 hover:bg-white/10 transition-all flex items-center gap-3"
          >
            CREATE ACCOUNT <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </motion.div>

      {/* Feature Grid */}
      <motion.div 
        initial={{ y: 50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.4, duration: 0.8 }}
        className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-32 max-w-6xl w-full"
      >
        <div className="glass-card p-8 group hover:border-primary/40 transition-colors">
          <Zap className="w-10 h-10 text-primary mb-6 group-hover:scale-110 transition-transform" />
          <h3 className="text-xl font-bold mb-3 uppercase italic tracking-tighter">Real-Time Analysis</h3>
          <p className="text-white/40 text-sm leading-relaxed font-medium">
            Proprietary AI models analyze your form at 30+ FPS directly in your browser.
          </p>
        </div>
        <div className="glass-card p-8 group hover:border-secondary/40 transition-colors">
          <Target className="w-10 h-10 text-secondary mb-6 group-hover:scale-110 transition-transform" />
          <h3 className="text-xl font-bold mb-3 uppercase italic tracking-tighter">Precision Feedback</h3>
          <p className="text-white/40 text-sm leading-relaxed font-medium">
             Get actionable corrections on joint angles, balance, and stance.
          </p>
        </div>
        <div className="glass-card p-8 group hover:border-accent-warning/40 transition-colors">
          <Trophy className="w-10 h-10 text-accent-warning mb-6 group-hover:scale-110 transition-transform" />
          <h3 className="text-xl font-bold mb-3 uppercase italic tracking-tighter">Elite Progression</h3>
          <p className="text-white/40 text-sm leading-relaxed font-medium">
            Gamified leveling system tracks your journey from amateur to pro.
          </p>
        </div>
      </motion.div>

      {/* Footer Decoration */}
      <div className="mt-40 text-[10px] font-bold text-white/10 uppercase tracking-[0.5em]">
        Powered by TensorFlow.js & Apexformz AI Engine
      </div>
    </div>
  );
}
