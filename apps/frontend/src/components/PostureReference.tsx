"use client";

import React from 'react';
import { Sport } from '@smartcoach/types';
import { motion } from 'framer-motion';

interface PostureReferenceProps {
  sport: Sport;
}

export const PostureReference: React.FC<PostureReferenceProps> = ({ sport }) => {
  const imageUrl = `/postures/${sport}.png`;

  return (
    <div className="flex flex-col gap-3 mt-4">
      <div className="flex flex-col gap-1 px-1">
        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40">Target Posture Reference</h3>
        <div className="h-px w-8 bg-primary/40" />
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-card overflow-hidden border-primary/20 bg-black/40 group relative"
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent z-10 opacity-60 pointer-events-none" />
        
        <img 
          src={imageUrl} 
          alt={`Perfect ${sport} posture blueprint`}
          className="w-full aspect-[4/3] object-cover mix-blend-screen opacity-90 group-hover:scale-110 transition-transform duration-700"
          onError={(e) => {
            (e.target as HTMLImageElement).src = 'https://placehold.co/400x300/black/cyan?text=Reference+Loading';
          }}
        />

        <div className="absolute bottom-3 left-3 z-20">
          <div className="flex flex-col">
            <span className="text-[8px] font-bold text-primary uppercase tracking-[0.3em]">Perfect Form</span>
            <span className="text-[10px] font-black italic text-white uppercase tracking-tight">Technical Blueprint</span>
          </div>
        </div>

        {/* Scanline Effect */}
        <div className="absolute inset-0 z-15 pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%] opacity-20" />
      </motion.div>
      
      <p className="px-1 text-[9px] text-white/30 leading-relaxed font-medium uppercase tracking-wider italic">
        * Match your skeleton to the blueprints above for maximum accuracy.
      </p>
    </div>
  );
};
