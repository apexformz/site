"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { 
  Trophy, 
  Flame, 
  TrendingUp, 
  Dumbbell, 
  Activity, 
  ChevronRight, 
  Star,
  Zap,
  LayoutGrid,
  Target
} from 'lucide-react';
import { api } from '@/lib/api';
import { User, UserStats, TrainingSession, Sport, getXpForNextLevel } from '@smartcoach/types';
import { SportCard } from '@/components/SportCard';

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [recentSessions, setRecentSessions] = useState<TrainingSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const [userRes, sessionsRes] = await Promise.all([
          api.get('/users/me'),
          api.get('/sessions')
        ]);
        
        setUser(userRes.data.data);
        setStats(userRes.data.data.stats);
        setRecentSessions(sessionsRes.data.data);
      } catch (err) {
        console.error('Failed to load dashboard:', err);
        router.push('/login');
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, [router]);

  const [showAll, setShowAll] = useState(false);
  
  const ALL_SPORTS: any[] = [
    { id: 'cricket', title: 'Cricket', icon: Activity, color: 'from-blue-500 to-cyan-400', difficulty: 'Intermediate', description: 'Master your batting stance and bowling action.' },
    { id: 'tennis', title: 'Tennis', icon: Star, color: 'from-yellow-400 to-orange-500', difficulty: 'Advanced', description: 'Perfect your serve and backhand technique.' },
    { id: 'yoga', title: 'Yoga', icon: Zap, color: 'from-emerald-400 to-teal-500', difficulty: 'Beginner', description: 'Balance and form correction for core poses.' },
    { id: 'running', title: 'Running', icon: TrendingUp, color: 'from-red-500 to-rose-400', difficulty: 'Beginner', description: 'AI-driven gait analysis and stride correction.' },
    { id: 'boxing', title: 'Boxing', icon: Target, color: 'from-purple-500 to-indigo-400', difficulty: 'Advanced', description: 'Refine your guard, punches, and footwork.' },
    { id: 'football', title: 'Football', icon: Trophy, color: 'from-orange-400 to-amber-500', difficulty: 'Intermediate', description: 'Improve your kick accuracy and body balance.' }
  ];

  const displaySports = showAll ? ALL_SPORTS : ALL_SPORTS.slice(0, 4);

  if (isLoading) return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const xpProgress = stats ? (stats.xp % 200) / 200 * 100 : 0; // Simplified for demo
  const xpNeeded = stats ? 200 - (stats.xp % 200) : 0;

  return (
    <div className="min-h-screen bg-background text-foreground pb-20">
      {/* Top Navigation */}
      <nav className="border-b border-white/10 px-8 py-4 flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-xl z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center font-black italic shadow-glow">S</div>
          <span className="font-bold tracking-tighter text-xl uppercase italic">SmartCoach <span className="text-primary">AI</span></span>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 bg-white/5 px-4 py-1.5 rounded-full border border-white/10">
            <Flame className="w-4 h-4 text-accent-warning fill-accent-warning" />
            <span className="text-sm font-bold tracking-tighter">{stats?.streak || 0} DAY STREAK</span>
          </div>
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-secondary p-0.5">
            <div className="w-full h-full rounded-full bg-background flex items-center justify-center overflow-hidden">
              <span className="font-bold text-xs">{user?.name?.charAt(0)}</span>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-8 py-10 grid grid-cols-12 gap-10">
        {/* Left Column: Profile & Progress */}
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-8">
          <section className="glass-card p-8 relative overflow-hidden group">
             <div className="absolute -top-10 -right-10 w-40 h-40 bg-primary/20 rounded-full blur-3xl group-hover:bg-primary/30 transition-colors" />
             
             <div className="relative z-10">
               <span className="text-xs font-bold text-primary tracking-[0.2em] uppercase mb-2 block">Athlete Overview</span>
               <h1 className="text-3xl font-black mb-1">Welcome, {user?.name.split(' ')[0]}</h1>
               <p className="text-white/50 text-sm font-medium">Elevate your performance today.</p>
               
               <div className="mt-8 flex items-end justify-between mb-2">
                 <div className="flex flex-col">
                   <span className="text-4xl font-black italic text-glow">LVL {stats?.level || 1}</span>
                   <span className="text-xs font-bold text-white/30 uppercase tracking-widest">{stats?.xp || 0} Total XP</span>
                 </div>
                 <span className="text-xs font-bold text-primary uppercase mb-1">{Math.round(xpProgress)}% to Pro</span>
               </div>
               
               <div className="h-3 bg-white/5 border border-white/10 rounded-full overflow-hidden">
                 <motion.div 
                   initial={{ width: 0 }}
                   animate={{ width: `${xpProgress}%` }}
                   transition={{ duration: 1, ease: 'easeOut' }}
                   className="h-full bg-gradient-to-r from-primary to-secondary shadow-glow"
                 />
               </div>
               <p className="mt-3 text-[10px] text-white/30 uppercase tracking-[0.1em] font-bold text-center">
                 {xpNeeded} XP UNTIL LEVEL {stats ? stats.level + 1 : 2}
               </p>
             </div>
          </section>

          <section className="glass-card p-8">
            <h3 className="text-sm font-bold tracking-widest uppercase text-white/40 mb-6 border-b border-white/10 pb-4 flex items-center gap-2">
              <Trophy className="w-4 h-4" /> Lifetime Achievements
            </h3>
            <div className="grid grid-cols-4 gap-4">
              {[1,2,3,4].map(i => (
                <div key={i} className={`aspect-square rounded-xl flex items-center justify-center transition-all ${i === 1 ? 'bg-primary/20 border border-primary/40 text-primary shadow-glow' : 'bg-white/5 border border-white/10 text-white/10'}`}>
                  <Star className={`w-6 h-6 ${i === 1 ? 'fill-primary' : ''}`} />
                </div>
              ))}
            </div>
            <button className="w-full mt-6 py-3 text-[10px] font-black uppercase tracking-widest text-white/40 hover:text-primary transition-colors">
              VIEW ALL BADGES →
            </button>
          </section>
        </div>

        {/* Right Column: Sports & Recent */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-10">
          <section>
            <div className="flex items-end justify-between mb-6">
              <div>
                <h2 className="text-3xl font-black uppercase italic leading-none mb-2">Choose Your <span className="text-primary">Discipline</span></h2>
                <p className="text-white/40 text-sm font-medium">Select a sport to launch AI real-time analysis.</p>
              </div>
              <button 
                onClick={() => setShowAll(!showAll)}
                className={`flex items-center gap-2 text-xs font-bold transition-colors ${showAll ? 'text-primary' : 'text-white/30 hover:text-white'}`}
              >
                <LayoutGrid className="w-4 h-4" /> {showAll ? 'SHOW FEATURED' : 'BROWSE ALL'}
              </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {displaySports.map((sport: any) => (
                <SportCard 
                  key={sport.id}
                  {...sport}
                  onClick={() => router.push(`/train/${sport.id}`)}
                />
              ))}
            </div>
          </section>

          <section>
             <h3 className="text-sm font-bold tracking-widest uppercase text-white/40 mb-6 flex items-center gap-2">
               <TrendingUp className="w-4 h-4" /> Training History
             </h3>
             <div className="flex flex-col gap-4">
               {recentSessions.length > 0 ? recentSessions.slice(0, 3).map(session => (
                 <div key={session.id} className="glass-card p-5 flex items-center justify-between hover:bg-white/10 transition-colors">
                   <div className="flex items-center gap-5">
                     <div className="w-12 h-12 bg-white/5 rounded-full flex items-center justify-center border border-white/10">
                        <Dumbbell className="w-5 h-5 text-secondary" />
                     </div>
                     <div className="flex flex-col">
                       <span className="font-bold text-lg leading-none uppercase tracking-tight">{session.sport} Session</span>
                       <span className="text-xs text-white/30 font-medium">{new Date(session.created_at).toLocaleDateString()}</span>
                     </div>
                   </div>
                   
                   <div className="flex items-center gap-12">
                     <div className="flex flex-col items-end">
                       <span className="text-xl font-black text-glow">{Math.round(session.score)}</span>
                       <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest">Score</span>
                     </div>
                     <div className="flex flex-col items-end">
                       <span className="text-xl font-black text-secondary">+{session.xp_earned}</span>
                       <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest">XP gained</span>
                     </div>
                     <ChevronRight className="w-5 h-5 text-white/20" />
                   </div>
                 </div>
               )) : (
                 <div className="glass-card p-10 flex flex-col items-center gap-4 text-white/20">
                   <Activity className="w-12 h-12 stroke-[1]" />
                   <p className="text-sm font-bold uppercase tracking-widest">No training data yet</p>
                 </div>
               )}
             </div>
          </section>
        </div>
      </main>
    </div>
  );
}
