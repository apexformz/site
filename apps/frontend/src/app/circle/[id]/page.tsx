'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowLeft, Users, Zap, Target, Activity, ShieldAlert, Award, ChevronRight, Copy, Check } from 'lucide-react';
import { api } from '@/lib/api';

export default function CircleDetailsPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [circle, setCircle] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    const fetchCircle = async () => {
      try {
        const res = await api.get(`/circles/${params.id}`);
        setCircle(res.data.data);
      } catch (err: any) {
        setError(err.response?.data?.error || 'Failed to load circle details');
      } finally {
        setIsLoading(false);
      }
    };
    fetchCircle();
  }, [params.id]);

  const handleCopy = () => {
    if (circle?.id) {
      navigator.clipboard.writeText(circle.id);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  const getTierColor = (tier: string) => {
    switch(tier.toLowerCase()) {
      case 'novice': return 'text-slate-400 border-slate-400/30 bg-slate-400/10';
      case 'beginner': return 'text-blue-400 border-blue-400/30 bg-blue-400/10';
      case 'consistent': return 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10';
      case 'athlete': return 'text-purple-400 border-purple-400/30 bg-purple-400/10';
      case 'elite': return 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10 shadow-glow shadow-yellow-500/20';
      default: return 'text-white/50 border-white/10 bg-white/5';
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center text-white/50 gap-4">
        <Activity className="w-8 h-8 animate-pulse text-secondary" />
        <span className="text-xs font-black uppercase tracking-widest">Resolving Telemetry...</span>
      </div>
    );
  }

  if (error || !circle) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-center">
        <ShieldAlert className="w-16 h-16 text-accent-danger/50 mb-4" />
        <h2 className="text-xl font-black uppercase tracking-widest text-white mb-2">Access Denied</h2>
        <p className="text-white/40 text-sm">{error || "Signal lost."}</p>
        <button onClick={() => router.push('/dashboard')} className="mt-8 btn-secondary px-8 py-3">Return to Base</button>
      </div>
    );
  }

  // Sort members so anchor is at the top, then by streak
  const sortedMembers = [...circle.members].sort((a, b) => {
    if (a.role === 'anchor_user') return -1;
    if (b.role === 'anchor_user') return 1;
    return (b.user.enhanced_streak?.current_streak || 0) - (a.user.enhanced_streak?.current_streak || 0);
  });

  return (
    <div className="min-h-screen bg-background text-foreground pb-20 overflow-x-hidden relative">
      {/* Background Ambience */}
      <div className="fixed top-0 inset-x-0 h-[50vh] bg-gradient-to-b from-primary/10 via-background to-background pointer-events-none" />
      <div className="fixed top-1/4 left-1/4 w-96 h-96 bg-secondary/10 rounded-full blur-[120px] pointer-events-none" />

      <main className="container mx-auto px-4 relative z-10 max-w-4xl pt-8 lg:pt-16">
        
        {/* Navigation & Header */}
        <div className="flex items-center gap-4 mb-8">
          <button 
            onClick={() => router.push('/dashboard')} 
            className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-white/70" />
          </button>
          <div>
            <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-white/40">Streak Circle</span>
            <h1 className="text-2xl md:text-4xl font-black uppercase italic tracking-tighter mt-1 drop-shadow-lg flex items-center gap-3">
              {circle.name}
              {circle.circle_health >= 90 && <Award className="w-6 h-6 text-yellow-500" />}
            </h1>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          
          {/* Left Column: Command Center Metrics */}
          <div className="md:col-span-5 flex flex-col gap-6">
            
            <section className="glass-card p-6 md:p-8 relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-br from-secondary/5 to-transparent opacity-50" />
              
              <div className="relative z-10 flex flex-col gap-8">
                <div>
                  <div className="flex justify-between items-end mb-3">
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/50">Global Health</span>
                    <span className="text-3xl font-black text-secondary drop-shadow-[0_0_15px_rgba(var(--secondary),0.5)] leading-none">
                      {Math.round(circle.circle_health)}%
                    </span>
                  </div>
                  <div className="h-2 w-full bg-black/50 rounded-full overflow-hidden border border-white/5">
                    <motion.div 
                      initial={{ width: 0 }}
                      animate={{ width: `${circle.circle_health}%` }}
                      transition={{ duration: 1.5, ease: "easeOut" }}
                      className={`h-full rounded-full ${circle.circle_health > 50 ? 'bg-secondary' : 'bg-red-500'}`} 
                    />
                  </div>
                  <p className="text-[10px] text-white/30 mt-3 font-medium uppercase tracking-widest text-center">
                    Health decays when members miss syncs!
                  </p>
                </div>

                <div className="flex items-center gap-4 p-4 bg-black/40 border border-white/5 rounded-2xl">
                   <div className="w-12 h-12 bg-primary/20 rounded-xl flex items-center justify-center border border-primary/30">
                     <Zap className="w-6 h-6 text-primary" />
                   </div>
                   <div className="flex flex-col">
                     <span className="text-2xl font-black text-white leading-none">{circle.shared_streak}</span>
                     <span className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em] mt-1">Shared Days Synced</span>
                   </div>
                </div>
              </div>
            </section>

            <section className="glass-card p-6 border-primary/20 flex flex-col gap-4">
              <div>
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/50">Invite Code</span>
                <p className="text-xs text-white/40 mt-1">Share this string with new athletes so they can deploy into the squad.</p>
              </div>
              
              <div 
                onClick={handleCopy}
                className="group/code cursor-pointer w-full bg-black/60 border border-white/10 hover:border-primary/50 transition-colors rounded-xl p-4 flex items-center justify-between"
              >
                <code className="text-primary font-mono text-sm tracking-wider font-bold group-hover/code:text-glow transition-all">{circle.id}</code>
                <div className="bg-white/5 p-2 rounded-lg group-hover/code:bg-primary/20 transition-colors">
                  {isCopied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4 text-white/50 group-hover/code:text-primary transition-colors" />}
                </div>
              </div>
            </section>

          </div>

          {/* Right Column: Roster & Ranks */}
          <div className="md:col-span-7">
            <section className="glass-card p-6 md:p-8 h-full">
              <div className="flex items-center justify-between border-b border-white/10 pb-6 mb-6">
                <h3 className="text-sm font-black uppercase tracking-widest text-white/70 flex items-center gap-2">
                  <Users className="w-4 h-4 text-primary" /> Active Roster
                </h3>
                <span className="text-xs font-bold text-white/30 bg-white/5 px-2 py-1 rounded-md">{circle.members.length} Athletes</span>
              </div>

              <div className="flex flex-col gap-3">
                {sortedMembers.map((member: any) => {
                  const u = member.user;
                  const eStreak = u.enhanced_streak || { current_streak: 0, identity_tier: 'Rookie', risk_score: 0 };
                  const isAnchor = member.role === 'anchor_user';

                  return (
                    <div key={member.id} className="group flex items-center gap-4 bg-black/30 hover:bg-white/5 border border-white/5 hover:border-white/10 p-4 rounded-2xl transition-all cursor-default">
                      {/* Avatar */}
                      <div className="relative">
                        {u.avatar_url ? (
                          <img src={u.avatar_url} alt={u.name} className="w-12 h-12 rounded-full object-cover border-2 border-background" />
                        ) : (
                          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/40 to-secondary/40 flex items-center justify-center font-black text-lg border-2 border-background">
                            {u.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        {isAnchor && (
                          <div className="absolute -bottom-1 -right-1 bg-yellow-500 rounded-full p-1 border-2 border-background" title="Circle Anchor">
                            <Award className="w-3 h-3 text-background" />
                          </div>
                        )}
                      </div>

                      <div className="flex-1 flex flex-col justify-center min-w-0">
                         <div className="flex items-center gap-2">
                           <span className="font-bold text-sm tracking-wide text-white truncate">{u.name}</span>
                           <span className={`text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${getTierColor(eStreak.identity_tier)}`}>
                             {eStreak.identity_tier}
                           </span>
                         </div>
                         <div className="flex items-center gap-4 mt-1.5">
                            <span className="text-[10px] text-white/40 tracking-widest uppercase font-semibold flex items-center gap-1">
                              <Target className="w-3 h-3 text-secondary/70" /> {eStreak.current_streak} Day Solo
                            </span>
                            <div className="flex items-center gap-1.5 text-[10px] text-white/40 uppercase tracking-widest">
                               Risk: 
                               <div className="w-12 h-1 bg-black/50 rounded-full overflow-hidden inline-block ml-1 relative top-px">
                                 <div 
                                   className={`h-full ${eStreak.risk_score > 60 ? 'bg-red-500' : eStreak.risk_score > 30 ? 'bg-orange-400' : 'bg-emerald-400'}`} 
                                   style={{ width: `${Math.min(100, Math.max(0, eStreak.risk_score))}%` }} 
                                 />
                               </div>
                            </div>
                         </div>
                      </div>
                      
                      <button className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-primary group-hover:text-background transition-colors shrink-0 outline-none">
                         <ChevronRight className="w-4 h-4 opacity-50 group-hover:opacity-100" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

        </div>
      </main>
    </div>
  );
}
