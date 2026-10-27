'use client';
import { MotionConfig } from 'framer-motion';
import { ReactNode } from 'react';
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ type: 'spring', stiffness: 320, damping: 32 }}
    >
      {children}
    </MotionConfig>
  );
}
