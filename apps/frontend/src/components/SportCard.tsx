"use client";

import React from 'react';
import { motion } from 'framer-motion';
import { LucideIcon } from 'lucide-react';
import { Sport } from '@smartcoach/types';

interface SportCardProps {
  id: Sport;
  title: string;
  description: string;
  icon: LucideIcon;
  color: string;
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  onClick: () => void;
}

export const SportCard: React.FC<SportCardProps> = ({ title, description, icon: Icon, color, difficulty, onClick }) => {
  return (
    <motion.button
      whileHover={{ y: -5, scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className="glass-card p-6 flex flex-col items-start gap-4 text-left group relative overflow-hidden h-full"
    >
      <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-br ${color} opacity-10 blur-3xl group-hover:opacity-20 transition-opacity`} />
      
      <div className={`p-4 rounded-2xl bg-gradient-to-br ${color} text-white shadow-lg`}>
        <Icon className="w-8 h-8" />
      </div>
      
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h3 className="text-xl font-bold tracking-tight">{title}</h3>
          <span className={`text-[10px] px-2 py-0.5 rounded-full border border-white/20 font-bold uppercase tracking-widest ${
            difficulty === 'Beginner' ? 'text-secondary border-secondary/20' : 
            difficulty === 'Intermediate' ? 'text-primary border-primary/20' : 'text-accent-warning border-accent-warning/20'
          }`}>
            {difficulty}
          </span>
        </div>
        <p className="text-sm text-white/50 leading-relaxed font-medium">
          {description}
        </p>
      </div>

      <div className="mt-auto pt-4 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-primary group-hover:translate-x-1 transition-transform">
        Start Training
        <motion.span animate={{ x: [0, 5, 0] }} transition={{ repeat: Infinity, duration: 1.5 }}>
          →
        </motion.span>
      </div>
    </motion.button>
  );
};
