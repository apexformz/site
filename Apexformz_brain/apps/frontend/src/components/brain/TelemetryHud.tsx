"use client";

import React from 'react';
import type { TelemetrySample } from '@apexformz/contracts';

interface Props {
  telemetry: TelemetrySample | null;
  sessionState: string;
  pack: { id: string; version: string } | null;
  detector: 'worker' | 'main-thread' | 'loading' | 'unavailable';
  poseLatencyMs: number | null;
  suppressedReason: string | null;
  /** Pose model reported by the worker on ready (e.g. mediapipe, onnx:webgpu). */
  poseBackend?: string | null;
  /** Adaptive capture mode from the TRD 01 fallback scheduler (full, reduced_frequency, reduced_resolution, minimum). */
  scheduleMode?: string | null;
}

export const TelemetryHud: React.FC<Props> = ({ telemetry, sessionState, pack, detector, poseLatencyMs, suppressedReason, poseBackend, scheduleMode }) => {
  const stages = telemetry ? Object.entries(telemetry.stage_durations_ms).filter(([k]) => k.endsWith('_ema')) : [];
  const abst = telemetry ? Object.entries(telemetry.abstention_reasons).sort((a, b) => b[1] - a[1]).slice(0, 4) : [];
  return (
    <div className="bg-black/80 p-3 rounded-lg border border-white/10 text-[10px] font-mono select-none pointer-events-none max-w-[260px]">
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-2 h-2 rounded-full ${detector === 'loading' ? 'bg-yellow-500 animate-pulse' : detector === 'unavailable' ? 'bg-red-500' : 'bg-green-500'}`} />
        <span className="font-bold uppercase tracking-tighter">BRAIN · {sessionState} · pose {detector}{poseBackend ? ` (${poseBackend})` : ''}{scheduleMode && scheduleMode !== 'full' ? ` · capture ${scheduleMode.replace('_', ' ')}` : ''}</span>
      </div>
      <div className="text-white/60 space-y-0.5">
        <div>pack {pack ? `${pack.id}@${pack.version}` : '—'}</div>
        <div>fps {telemetry?.observed_fps ?? '—'} · pose {poseLatencyMs !== null ? `${poseLatencyMs.toFixed(0)} ms` : '—'} · queue {telemetry ? `${telemetry.queue_age_ms.toFixed(0)} ms` : '—'}</div>
        <div>discarded {telemetry?.discarded_frames ?? 0} · dropped {telemetry?.dropped_inferences ?? 0} · unknown {telemetry?.unknown_movement_rate ?? '—'}</div>
        {stages.length > 0 && <div>{stages.map(([k, v]) => `${k.replace('_ms_ema', '')} ${v.toFixed(2)}`).join(' · ')} ms</div>}
        {abst.length > 0 && <div className="text-accent-warning/80">abstain {abst.map(([k, v]) => `${k.replace('criterion:', '').replace('feature:', 'f:')}=${v}`).join(' ')}</div>}
        {suppressedReason && <div className="text-white/40">cue suppressed: {suppressedReason}</div>}
      </div>
    </div>
  );
};
