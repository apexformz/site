"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

export const useVoiceCoaching = () => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const activeRef = useRef<{ synth: SpeechSynthesis; finish: () => void } | null>(null);

  const stop = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    // Settle and detach first: browsers may emit a late canceled/interrupted event.
    active.finish();
    try { active.synth.cancel(); } catch { /* Optional audio must not block training. */ }
  }, []);

  useEffect(() => () => stop(), [stop]);

  const announce = useCallback((text: string): Promise<void> => {
    stop();
    return new Promise((resolve) => {
      if (!text.trim() || typeof window === 'undefined' ||
          !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
        resolve();
        return;
      }
      const synth = window.speechSynthesis;
      let utterance: SpeechSynthesisUtterance | null = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (utterance) utterance.onstart = utterance.onend = utterance.onerror = null;
        if (activeRef.current?.finish === finish) {
          activeRef.current = null;
          setIsSpeaking(false);
        }
        resolve();
      };
      activeRef.current = { synth, finish };
      try {
        utterance = new SpeechSynthesisUtterance(text);
        const voices = synth.getVoices();
        const englishVoice = voices.find(v => v.lang.startsWith('en-') && (v.name.includes('Google') || v.name.includes('Premium')));
        if (englishVoice) utterance.voice = englishVoice;
        utterance.rate = 0.95;
        utterance.pitch = 1;
        utterance.volume = 1;
        utterance.onstart = () => { if (!finished) setIsSpeaking(true); };
        utterance.onend = finish;
        utterance.onerror = (event) => {
          if (finished) return;
          // Cancellation is normal when a newer cue replaces speech or audio is muted.
          if (event.error !== 'canceled' && event.error !== 'interrupted') {
            console.warn(`Voice coaching unavailable (${event.error || 'speech-error'}). On-screen coaching remains available.`);
          }
          finish();
        };
        synth.speak(utterance);
      } catch {
        console.warn('Voice coaching unavailable. On-screen coaching remains available.');
        finish();
      }
    });
  }, [stop]);

  return { announce, stop, isSpeaking };
};
