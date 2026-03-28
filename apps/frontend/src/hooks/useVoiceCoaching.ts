"use client";

import { useCallback, useRef, useState } from 'react';

export const useVoiceCoaching = () => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const synthRef = useRef<SpeechSynthesis | null>(
    typeof window !== 'undefined' ? window.speechSynthesis : null
  );

  const announce = useCallback((text: string): Promise<void> => {
    return new Promise((resolve) => {
      if (!synthRef.current) {
        resolve();
        return;
      }

      // Cancel any ongoing speech to ensure the sequence doesn't get backed up
      synthRef.current.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      
      // Try to find a premium English voice
      const voices = synthRef.current.getVoices();
      const englishVoice = voices.find(v => v.lang.startsWith('en-') && (v.name.includes('Google') || v.name.includes('Premium')));
      if (englishVoice) {
        utterance.voice = englishVoice;
      }

      utterance.rate = 0.95; // Slightly slower for clear instruction
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => {
        setIsSpeaking(false);
        resolve();
      };
      utterance.onerror = (e) => {
        console.error('TTS Error:', e);
        setIsSpeaking(false);
        resolve();
      };

      synthRef.current.speak(utterance);
    });
  }, []);

  const stop = useCallback(() => {
    if (synthRef.current) {
      synthRef.current.cancel();
      setIsSpeaking(false);
    }
  }, []);

  return { announce, stop, isSpeaking };
};
