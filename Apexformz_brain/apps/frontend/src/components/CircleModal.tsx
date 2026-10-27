import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, X, Plus, LogIn, Loader2, Share2, Copy, Check } from 'lucide-react';
import { api } from '@/lib/api';

interface CircleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function CircleModal({ isOpen, onClose, onSuccess }: CircleModalProps) {
  const [activeTab, setActiveTab] = useState<'join' | 'create'>('join');
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [createdCircleId, setCreatedCircleId] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      if (activeTab === 'create') {
        const res = await api.post('/circles', { name: inputValue });
        setCreatedCircleId(res.data.data.id);
        setInputValue('');
      } else {
        await api.post('/circles/join', { circleId: inputValue });
        onSuccess();
        handleClose();
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = () => {
    if (createdCircleId) {
      navigator.clipboard.writeText(createdCircleId);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  const handleFinishCreate = () => {
    onSuccess();
    handleClose();
  };

  const handleClose = () => {
    setInputValue('');
    setError(null);
    setCreatedCircleId(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
          className="absolute inset-0 bg-black/60 backdrop-blur-xl"
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 30 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="relative w-full max-w-[420px] bg-background/80 border border-white/5 rounded-[2rem] p-8 shadow-2xl overflow-hidden z-10"
          style={{boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5), 0 0 100px -20px rgba(var(--primary), 0.15)'}}
        >
          {/* Ambient Glows */}
          <div className="absolute -top-32 -right-32 w-64 h-64 bg-primary/20 rounded-full blur-[100px] pointer-events-none" />
          <div className="absolute -bottom-32 -left-32 w-64 h-64 bg-secondary/20 rounded-full blur-[100px] pointer-events-none" />

          {/* Header */}
          <div className="flex items-center justify-between mb-8 relative z-10">
            <h2 className="text-2xl font-black uppercase italic tracking-wider flex items-center gap-3">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-secondary">
                {createdCircleId ? 'Circle Minted' : 'Streak Circle'}
              </span>
            </h2>
            <button
              onClick={handleClose}
              className="p-2 text-white/40 hover:text-white hover:bg-white/10 rounded-full transition-all duration-300 transform hover:scale-110"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {!createdCircleId ? (
            <div className="relative z-10">
              {/* Premium Pill Tabs */}
              <div className="flex bg-black/50 rounded-full p-1.5 mb-8 border border-white/5 relative">
                <button
                  onClick={() => { setActiveTab('join'); setError(null); setInputValue(''); }}
                  className={`flex-1 py-2.5 text-[10px] font-black uppercase tracking-[0.2em] rounded-full transition-all duration-300 relative z-10 ${
                    activeTab === 'join' ? 'text-white' : 'text-white/40 hover:text-white/70'
                  }`}
                >
                  Join Circle
                </button>
                <button
                  onClick={() => { setActiveTab('create'); setError(null); setInputValue(''); }}
                  className={`flex-1 py-2.5 text-[10px] font-black uppercase tracking-[0.2em] rounded-full transition-all duration-300 relative z-10 ${
                    activeTab === 'create' ? 'text-white' : 'text-white/40 hover:text-white/70'
                  }`}
                >
                  Create New
                </button>
                {/* Active Pill Background indicator */}
                <div 
                  className={`absolute top-1.5 bottom-1.5 w-[calc(50%-6px)] bg-gradient-to-r from-white/10 to-white/5 border border-white/10 rounded-full shadow-lg transition-transform duration-300 ease-out`}
                  style={{ transform: activeTab === 'create' ? 'translateX(100%)' : 'translateX(0)' }}
                />
              </div>

              <form onSubmit={handleSubmit} className="flex flex-col gap-6">
                <div className="flex flex-col gap-2 relative group">
                  <label className="text-[10px] font-black uppercase tracking-widest text-primary ml-1 transition-colors group-focus-within:text-white">
                    {activeTab === 'join' ? 'Invite Code' : 'Circle Identity Name'}
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder={activeTab === 'join' ? 'e.g. A1B2C3D4' : 'e.g. The Iron Sharpeners'}
                      className="w-full bg-black/40 border border-white/10 rounded-2xl px-5 py-4 outline-none text-white placeholder-white/20 text-sm font-medium transition-all duration-300 focus:border-primary/50 focus:bg-black/60 shadow-inner"
                    />
                    {/* Animated Edge Glow on Focus */}
                    <div className="absolute inset-0 -z-10 rounded-2xl bg-gradient-to-r from-primary to-secondary blur opacity-0 group-focus-within:opacity-20 transition-opacity duration-500" />
                  </div>
                  
                  {error && (
                    <motion.span 
                      initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} 
                      className="text-[10px] text-accent-danger font-bold uppercase tracking-widest px-2 mt-1 flex items-center gap-1"
                    >
                      <X className="w-3 h-3" /> {error}
                    </motion.span>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={isLoading || !inputValue.trim()}
                  className="group relative w-full overflow-hidden rounded-2xl p-px mt-2 disabled:opacity-50 disabled:cursor-not-allowed transform transition-transform active:scale-95"
                >
                  {/* Animated Border Gradient */}
                  <div className="absolute inset-0 bg-gradient-to-r from-primary via-secondary to-primary opacity-70 group-hover:opacity-100 transition-opacity duration-300" style={{ backgroundSize: '200% auto', animation: 'aurora 3s linear infinite' }} />
                  
                  <div className="relative flex items-center justify-center gap-3 bg-background group-hover:bg-background/80 px-4 py-4 rounded-[15px] transition-colors duration-300">
                    {isLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    ) : (
                      activeTab === 'join' ? <LogIn className="w-4 h-4 text-primary" /> : <Plus className="w-4 h-4 text-primary" />
                    )}
                    <span className="text-xs font-black uppercase tracking-[0.2em] text-white">
                      {activeTab === 'join' ? 'INITIALIZE JOIN' : 'MINT CIRCLE'}
                    </span>
                  </div>
                </button>
              </form>
            </div>
          ) : (
             <motion.div 
               initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
               className="relative z-10 flex flex-col items-center justify-center text-center py-6 gap-6"
             >
                <div className="relative">
                  <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl animate-pulse" />
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary to-secondary p-1 relative z-10">
                     <div className="w-full h-full bg-background rounded-full flex items-center justify-center">
                        <Check className="w-8 h-8 text-primary" />
                     </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-2xl font-black uppercase italic tracking-wider mb-2">Circle Live</h3>
                  <p className="text-[11px] text-white/50 leading-relaxed max-w-[250px] mx-auto font-medium">
                    Share this unique 8-character invite code with fellow athletes. Their performance will now sync directly to your HUD.
                  </p>
                </div>
                
                <div 
                  onClick={handleCopy}
                  className="group cursor-pointer bg-black/60 hover:bg-black/80 border border-white/10 hover:border-primary/50 transition-all duration-300 rounded-2xl p-5 flex items-center justify-between gap-4 w-full relative overflow-hidden"
                >
                  <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  <span className="text-xs font-mono text-primary/80 group-hover:text-primary truncate relative z-10 select-none">
                    {createdCircleId}
                  </span>
                  <div className="p-2 bg-white/5 rounded-xl shrink-0 relative z-10 group-hover:bg-primary/20 transition-colors">
                    {isCopied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4 text-white/50 group-hover:text-primary transition-colors" />}
                  </div>
                </div>

                {isCopied && <span className="text-[10px] font-bold text-primary tracking-widest uppercase absolute bottom-24">Token Copied</span>}
                
                <button
                  onClick={handleFinishCreate}
                  className="w-full py-4 mt-2 text-xs font-black uppercase tracking-[0.2em] text-white/50 hover:text-white transition-colors"
                >
                  RETURN TO DASHBOARD
                </button>
             </motion.div>
          )}
        </motion.div>

        <style jsx>{`
          @keyframes aurora {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
        `}</style>
      </div>
    </AnimatePresence>
  );
}
