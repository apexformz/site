"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Mail, Lock, User as UserIcon, Activity, ChevronRight, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { Sport } from '@smartcoach/types';

export default function RegisterPage() {
  const router = useRouter();
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    preferred_sport: 'cricket' as Sport
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const { data } = await api.post('/auth/register', formData);
      if (data.success && data.data) {
        localStorage.setItem('access_token', data.data.access_token);
        localStorage.setItem('refresh_token', data.data.refresh_token);
        router.push('/dashboard');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Registration failed');
    } finally {
      setIsLoading(false);
    }
  };

  const sportsList: { id: Sport; label: string }[] = [
    { id: 'cricket', label: 'Cricket' },
    { id: 'tennis', label: 'Tennis' },
    { id: 'yoga', label: 'Yoga' },
    { id: 'running', label: 'Running' },
    { id: 'boxing', label: 'Boxing' },
    { id: 'football', label: 'Football' }
  ];

  return (
    <div className="min-h-screen flex text-white relative overflow-hidden bg-background">
      <div className="absolute top-[10%] left-[10%] w-[40%] h-[40%] bg-secondary/10 rounded-full blur-[100px] -z-10 animate-pulse-slow" />
      
      {/* Sidebar Info */}
      <div className="hidden lg:flex flex-col justify-center px-24 w-1/2 border-r border-white/5 relative">
        <div className="relative z-10">
          <div className="w-16 h-16 bg-primary rounded-2xl flex items-center justify-center font-black italic shadow-glow mb-8 text-2xl">S</div>
          <h1 className="text-6xl font-black uppercase italic tracking-tighter leading-none mb-6">
            Join the <span className="text-secondary italic">Elite</span><br />
            Level Up <span className="text-primary italic">Fast</span>
          </h1>
          <div className="space-y-6 mt-12">
            {[
              "Real-time pose estimation",
              "Actionable AI feedback",
              "Gamified progression system",
              "Global athlete leaderboards"
            ].map((text, i) => (
              <div key={i} className="flex items-center gap-4 text-white/60 font-medium">
                <div className="w-6 h-6 rounded-full bg-secondary/20 flex items-center justify-center border border-secondary/20">
                  <Check className="w-4 h-4 text-secondary" />
                </div>
                {text}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Register Form */}
      <div className="w-full lg:w-1/2 flex flex-col items-center justify-center p-8 overflow-y-auto">
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="w-full max-w-md glass-card p-10 py-12 border-white/10 my-8"
        >
          <div className="mb-10">
            <h2 className="text-3xl font-bold tracking-tight mb-2">Create Account</h2>
            <p className="text-white/40 text-sm font-medium">Start your journey with SmartCoach AI</p>
          </div>

          <form onSubmit={handleRegister} className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-white/50 ml-1">Full Name</label>
              <div className="relative group">
                <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/20 group-focus-within:text-primary transition-colors" />
                <input 
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  placeholder="Alex Rivera"
                  className="w-full bg-white/5 border border-white/10 rounded-xl py-4 pl-12 pr-4 outline-none focus:border-primary/50 focus:bg-white/10 transition-all font-medium"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-white/50 ml-1">Email Address</label>
              <div className="relative group">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/20 group-focus-within:text-primary transition-colors" />
                <input 
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({...formData, email: e.target.value})}
                  placeholder="alex@example.com"
                  className="w-full bg-white/5 border border-white/10 rounded-xl py-4 pl-12 pr-4 outline-none focus:border-primary/50 focus:bg-white/10 transition-all font-medium"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-white/50 ml-1">Password</label>
              <div className="relative group">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/20 group-focus-within:text-primary transition-colors" />
                <input 
                  type="password"
                  required
                  value={formData.password}
                  onChange={(e) => setFormData({...formData, password: e.target.value})}
                  placeholder="••••••••"
                  className="w-full bg-white/5 border border-white/10 rounded-xl py-4 pl-12 pr-4 outline-none focus:border-primary/50 focus:bg-white/10 transition-all font-medium"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-white/50 ml-1">Primary Discipline</label>
              <div className="grid grid-cols-2 gap-3">
                {sportsList.map(sport => (
                  <button
                    key={sport.id}
                    type="button"
                    onClick={() => setFormData({...formData, preferred_sport: sport.id})}
                    className={`py-3 rounded-xl border font-bold text-xs uppercase tracking-tighter transition-all ${
                      formData.preferred_sport === sport.id 
                      ? 'bg-primary/20 border-primary text-primary shadow-glow shadow-primary/10' 
                      : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10'
                    }`}
                  >
                    {sport.label}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="text-accent-danger text-sm font-bold tracking-tight bg-accent-danger/10 p-3 rounded-lg border border-accent-danger/20 text-center">
                {error}
              </div>
            )}

            <button 
              type="submit"
              disabled={isLoading}
              className="mt-4 btn-secondary py-4 flex items-center justify-center gap-2 group disabled:opacity-50"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  CREATE ACCOUNT <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>
          </form>

          <p className="mt-8 text-center text-sm text-white/40 font-medium">
            Already have an account? <Link href="/login" className="text-secondary font-bold hover:underline">Log in</Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
