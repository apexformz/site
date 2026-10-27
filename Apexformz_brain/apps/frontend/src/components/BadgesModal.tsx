import React from 'react';
import { Trophy, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export interface Badge {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  unlocked: boolean;
  date?: string;
  color: string;
}

interface BadgesModalProps {
  isOpen: boolean;
  onClose: () => void;
  badges: Badge[];
}

export const BadgesModal: React.FC<BadgesModalProps> = ({ isOpen, onClose, badges }) => {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: 20 }}
          onClick={(e) => e.stopPropagation()}
          className="w-[90vw] max-w-4xl lg:max-w-5xl bg-slate-900 border border-white/10 rounded-3xl shadow-2xl overflow-hidden relative"
        >
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-secondary to-primary/50" />
          
          <div className="p-6 sm:p-8 border-b border-white/10 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/20 flex shrink-0 items-center justify-center border border-primary/30">
                <Trophy className="w-5 h-5 text-primary" />
              </div>
              <h2 className="text-xl sm:text-2xl font-black uppercase italic tracking-wider text-white">Lifetime Achievements</h2>
            </div>
            <button 
              onClick={onClose}
              className="p-2 shrink-0 rounded-full hover:bg-white/10 transition-colors text-white/50 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-6 sm:p-8 max-h-[70vh] overflow-y-auto custom-scrollbar">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 sm:gap-6">
              {badges.map((badge) => {
                const Icon = badge.icon;
                return (
                  <div 
                    key={badge.id}
                    className={`p-4 sm:p-5 rounded-2xl border flex flex-col items-center text-center gap-3 transition-all duration-300 ${
                      badge.unlocked 
                        ? 'bg-gradient-to-b from-white/5 to-transparent border-white/10 hover:bg-white/10 hover:shadow-glow hover:-translate-y-1' 
                        : 'bg-black/20 border-white/5 opacity-50 grayscale hover:grayscale-0 hover:opacity-100'
                    }`}
                  >
                    <div className={`w-14 h-14 sm:w-16 sm:h-16 shrink-0 rounded-full flex items-center justify-center border-2 shadow-inner ${
                      badge.unlocked 
                        ? `${badge.color} shadow-current/20` 
                        : 'bg-white/5 border-white/10 text-white/20'
                    }`}>
                      <Icon className={`w-7 h-7 sm:w-8 sm:h-8 flex-shrink-0 ${badge.unlocked ? `text-current ${badge.color.includes('border-primary/40') ? 'fill-current' : ''}` : ''}`} />
                    </div>
                    
                    <div className="flex flex-col items-center mt-1 w-full flex-1">
                      <h4 className="font-black text-white text-[11px] sm:text-xs uppercase tracking-widest mb-1.5 line-clamp-2 leading-tight">{badge.title}</h4>
                      <p className="text-[10px] sm:text-[11px] text-white/50 leading-snug font-medium line-clamp-3 mb-2">{badge.description}</p>
                      
                      <div className="mt-auto pt-2 w-full">
                        {badge.unlocked && badge.date ? (
                          <span className="text-[9px] text-primary uppercase font-black tracking-widest bg-primary/10 border border-primary/20 px-2 py-1 rounded-full inline-block">
                            {badge.date}
                          </span>
                        ) : (
                          <span className="text-[9px] text-white/30 uppercase font-black tracking-widest bg-white/5 border border-white/10 px-2 py-1 rounded-full inline-block">
                            LOCKED
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
