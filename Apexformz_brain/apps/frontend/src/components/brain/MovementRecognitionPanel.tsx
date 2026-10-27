"use client";

import React from 'react';
import { ScanLine } from 'lucide-react';
import type { MovementDefinition } from '@apexformz/contracts';
import type { MovementDetection, MovementModelConfig } from '@apexformz/brain-client';
import { presentGuidedRecognition, taskForMovement, type RecognitionMode } from '@/lib/brain/recognition';

export type RecognitionLoadState = 'loading' | 'ready' | 'unavailable';

interface Props {
  status: RecognitionLoadState;
  message: string | null;
  models: MovementModelConfig[];
  detections: Partial<Record<'static_pose' | 'dynamic_movement', MovementDetection>>;
  recording: boolean;
  live: boolean;
  mode: RecognitionMode;
  selectedMovement: MovementDefinition | null;
}

export function MovementRecognitionPanel({ status, message, models, detections, recording, live, mode, selectedMovement }: Props) {
  const task = selectedMovement ? taskForMovement(selectedMovement) : null;
  const model = task ? models.find(m => (m.model_task ?? (m.input.window_frames === 1 ? 'static_pose' : 'dynamic_movement')) === task) : null;
  const detection = task && recording && live ? detections[task] : undefined;
  const presentation = detection && selectedMovement ? presentGuidedRecognition(detection, selectedMovement, mode) : null;
  const provisional = (detection?.calibration_status ?? model?.calibration.status) === 'provisional';
  const waiting = status === 'loading' ? 'Loading selected-drill model…'
    : !selectedMovement ? 'Choose a drill in setup'
      : !recording ? 'Start the selected drill'
        : !live ? 'Waiting for an active camera and fresh pose'
          : !model ? 'Recognition unavailable; technique checks remain available'
            : selectedMovement.type === 'static' ? 'Hold the selected position' : 'Perform the selected movement';
  return (
    <section className="glass-card p-4 flex flex-col gap-3 border-l-4 border-l-sky-400/60" aria-label="Selected drill recognition">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/60 flex items-center gap-2"><ScanLine className="w-3.5 h-3.5" /> Selected drill</h3>
        <span className="text-[9px] uppercase tracking-wider text-sky-300">{selectedMovement?.type === 'static' ? 'Static hold' : selectedMovement?.type === 'dynamic' ? 'Dynamic movement' : 'Loading'}</span>
      </div>
      <p className="text-base font-semibold text-white">{selectedMovement?.canonical_name ?? 'Loading selected drill…'}</p>
      {selectedMovement?.source?.instruction && <p className="text-sm text-white/75 leading-relaxed">{selectedMovement.source.instruction}</p>}
      <div className="rounded-xl border border-white/10 bg-black/30 p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-semibold text-white/70">Attempt recognition</h4>
          {provisional && <span className="text-[8px] uppercase tracking-widest text-accent-warning border border-accent-warning/30 rounded px-1.5 py-0.5">Provisional</span>}
        </div>
        <p className="text-sm font-semibold text-white" role="status">{presentation?.label ?? waiting}</p>
        {presentation && <p className="text-xs text-white/60 leading-relaxed">{presentation.detail}</p>}
      </div>
      {message && <p className="text-xs text-white/50 leading-relaxed">{message}</p>}
      <p className="text-[10px] text-white/45 leading-relaxed">This classifier compares movement identity. The live technique panel checks your selected target independently, even when recognition is uncertain.</p>
      {selectedMovement?.type === 'dynamic' && <p className="text-[10px] text-white/45 leading-relaxed">This camera checks body movement. Ball contact and racket impact are not observed by the body-pose model.</p>}
    </section>
  );
}
