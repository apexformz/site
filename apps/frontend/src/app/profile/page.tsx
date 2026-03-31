"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trophy, ChevronLeft, LogOut, Mail, User as UserIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { User, UserStats } from '@smartcoach/types';

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [identity, setIdentity] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const res = await api.get('/users/me');
        setUser(res.data.data);
        setStats(res.data.data.stats);
        setIdentity(res.data.data.enhanced_streak);
      } catch (err) {
        console.error('Failed to load profile:', err);
        router.push('/login');
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    router.push('/login');
  };

  if (isLoading) return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground pb-20">
      <nav className="border-b border-white/10 px-8 py-4 flex items-center sticky top-0 bg-background/80 backdrop-blur-xl z-50">
        <button 
          onClick={() => router.push('/dashboard')}
          className="flex items-center gap-2 text-white/50 hover:text-white transition-colors"
        >
          <ChevronLeft className="w-5 h-5" /> Back to Dashboard
        </button>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <div className="flex flex-col gap-8">
          
          {/* Header Profile Info */}
          <div className="glass-card p-10 flex flex-col md:flex-row items-center md:items-start gap-8 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />
            
            <div className="w-32 h-32 rounded-full bg-gradient-to-br from-primary to-secondary p-1 shrink-0 relative z-10">
              <div className="w-full h-full rounded-full bg-background flex items-center justify-center overflow-hidden">
                <span className="font-bold text-5xl">{user?.name?.charAt(0)}</span>
              </div>
            </div>
            
            <div className="flex flex-col items-center md:items-start text-center md:text-left relative z-10 flex-1">
              <span className="text-xs font-bold text-primary tracking-[0.2em] uppercase mb-1">
                {identity?.identity_tier || 'Novice'}
              </span>
              <h1 className="text-4xl font-black mb-4">{user?.name}</h1>
              
              <div className="flex flex-col gap-3 w-full">
                <div className="flex items-center justify-center md:justify-start gap-3 text-white/50 bg-black/20 p-3 rounded-xl border border-white/5">
                  <Mail className="w-5 h-5" />
                  <span className="text-sm font-medium">{user?.email}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Validation Engine & AI Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="glass-card p-6 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Verified Streak</span>
              <span className="text-3xl font-black italic text-glow text-accent-warning">
                {identity?.current_streak || stats?.streak || 0}
              </span>
            </div>
            
            <div className="glass-card p-6 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Total XP</span>
              <span className="text-3xl font-black italic text-secondary">{stats?.xp || 0}</span>
            </div>
            
            <div className="glass-card p-6 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Risk Score</span>
              <span className={`text-3xl font-black italic ${identity?.risk_score > 50 ? 'text-red-500' : 'text-green-500'}`}>
                {identity?.risk_score || 0}
              </span>
            </div>

            <div className="glass-card p-6 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Save Tokens</span>
              <span className="text-3xl font-black italic text-primary">{identity?.save_tokens || 0}</span>
            </div>
          </div>

          {/* Settings / Actions */}
          <div className="glass-card p-6 mt-8 flex flex-col">
            <h3 className="text-sm font-bold tracking-widest uppercase text-white/40 mb-6 border-b border-white/10 pb-4">Account Settings</h3>
            
            <button 
              onClick={handleLogout}
              className="flex items-center gap-3 text-red-500 hover:text-red-400 hover:bg-red-500/10 p-4 rounded-xl transition-colors font-bold w-full md:w-auto self-start"
            >
              <LogOut className="w-5 h-5" />
              Sign Out
            </button>
          </div>

        </div>
      </main>
    </div>
  );
}
