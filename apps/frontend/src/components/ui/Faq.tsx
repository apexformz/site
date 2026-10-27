'use client';

import { useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Plus } from 'lucide-react';

export function Faq({
  items,
}: {
  items: { question: string; answer: string }[];
}) {
  const [open, setOpen] = useState<number | null>(0);
  const id = useId();
  const reduced = useReducedMotion();
  return (
    <div className="divide-y divide-border/60">
      {items.map((item, index) => (
        <div key={item.question}>
          <h3>
            <button
              id={`${id}-question-${index}`}
              aria-controls={`${id}-answer-${index}`}
              aria-expanded={open === index}
              onClick={() => setOpen(open === index ? null : index)}
              className="flex w-full items-center justify-between gap-6 py-7 text-left text-lg font-semibold tracking-tight"
            >
              <span>{item.question}</span>
              <Plus
                size={21}
                className={`shrink-0 text-primary transition-transform ${open === index ? 'rotate-45' : ''}`}
              />
            </button>
          </h3>
          <AnimatePresence initial={false}>
            {open === index && (
              <motion.div
                id={`${id}-answer-${index}`}
                role="region"
                aria-labelledby={`${id}-question-${index}`}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.25 }}
                className="overflow-hidden"
              >
                <p className="max-w-3xl pb-7 text-base leading-relaxed text-muted">
                  {item.answer}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}
