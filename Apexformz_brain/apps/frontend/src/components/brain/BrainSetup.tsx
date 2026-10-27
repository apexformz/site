"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Activity, ChevronLeft, ChevronRight, Star, Target, Zap } from 'lucide-react';
import type { Calibration, MovementDefinition } from '@apexformz/contracts';
import type { Sport } from '@smartcoach/types';
import { DEFAULT_CALIBRATION, POSE_BACKENDS, loadSetup, saveSetup, type CoachingMode, type PoseBackendChoice } from '@/lib/brain/config';
import { loadPackOverview, type PackOverview } from '@/lib/brain/packs';
import { selectedMovement } from '@/lib/brain/presentation';
import { MovementPicker } from './MovementPicker';
import { recognitionModeFromParam, type RecognitionMode } from '@/lib/brain/recognition';
import { selectionForKind, type MovementKind } from '@/lib/brain/movementSelection';
import { cameraViewCoverage } from '@/lib/brain/viewCoverage';
import { dynamicReferenceCoverage } from '@/lib/brain/referenceCoverage';

interface Props {
  sport: Sport;
}

export default function BrainSetup({ sport }: Props) {
  const router = useRouter();
  const [overview, setOverview] = useState<PackOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [movementId, setMovementId] = useState<string | null>(null);
  const [movementKind, setMovementKind] = useState<MovementKind>('all');
  const [mode, setMode] = useState<CoachingMode>(sport === 'squash' ? 'development' : 'strict');
  const [cal, setCal] = useState<Calibration>(DEFAULT_CALIBRATION);
  const [poseBackend, setPoseBackend] = useState<PoseBackendChoice>('mediapipe');
  const [recognition, setRecognition] = useState<RecognitionMode>(recognitionModeFromParam(null));

  useEffect(() => {
    let active = true;
    // Browser preferences must be restored after the first render matches SSR.
    const existing = loadSetup(sport);
    setMovementId(existing?.movement_id ?? null);
    setMode(existing?.mode ?? (sport === 'squash' ? 'development' : 'strict'));
    setCal(existing?.calibration ?? DEFAULT_CALIBRATION);
    setPoseBackend(sport === 'squash' ? 'mediapipe' : existing?.pose_backend ?? 'mediapipe');
    setOverview(null);
    setError(null);
    loadPackOverview(sport)
      .then((o) => {
        if (!active) return;
        setOverview(o);
        const restored = selectedMovement(o.catalog, existing?.movement_id ?? null);
        const first = restored ?? (!existing?.movement_id ? o.catalog.movements[0] : null);
        setMovementId(first?.id ?? null);
        const hasCompleteReferences = Object.values(o.dynamic_reference_support ?? {}).some(support => support.views.some(view => view.complete_captures > 0));
        setMovementKind(hasCompleteReferences ? 'all' : first?.type ?? 'all');
      })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sport]);

  const selected = overview ? selectedMovement(overview.catalog, movementId) : null;
  const graph = overview?.phase_graphs.graphs.find((g) => g.id === selected?.phase_graph_id);
  const color = overview?.manifest.display.color ?? '#00d4ff';
  const viewCoverage = selected?.type === 'dynamic' && overview && !overview.dynamic_reference_support?.[selected.id]
    ? cameraViewCoverage(selected, overview.technique_criteria.criteria, cal.nominal_view) : null;
  const referenceCoverage = selected?.type === 'dynamic' && overview ? dynamicReferenceCoverage(overview.dynamic_reference_support?.[selected.id], cal.nominal_view, cal.handedness) : null;
  const changeMovementKind = (kind: MovementKind) => {
    setMovementKind(kind);
    setMovementId(id => selectionForKind(overview?.catalog.movements ?? [], id, kind));
  };

  const handleStart = () => {
    if (!selected || !graph || !selectionForKind(overview?.catalog.movements ?? [], selected.id, movementKind)) return;
    saveSetup(sport, { movement_id: selected.id, mode, pose_backend: poseBackend, calibration: { ...cal, handedness_assumed: cal.handedness === 'unknown' ? undefined : cal.handedness_assumed } });
    router.push(`/train/${sport}?movement=${encodeURIComponent(selected.id)}&mode=${mode}&backend=${poseBackend}&recognition=${recognition}`);
  };

  const icon = (m: MovementDefinition) => (m.difficulty === 'advanced' ? <Star className="w-5 h-5" /> : m.difficulty === 'intermediate' ? <Zap className="w-5 h-5" /> : <Target className="w-5 h-5" />);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-[20%] -right-[10%] w-[60%] h-[60%] blur-[120px] opacity-20 rounded-full" style={{ backgroundColor: color }} />
      </div>

      <header className="relative z-10 p-8 flex items-center justify-between border-b border-white/5 bg-black/40 backdrop-blur-md">
        <div className="flex items-center gap-6">
          <button onClick={() => router.push('/dashboard')} className="p-3 glass-card hover:bg-white/10 transition-colors">
            <ChevronLeft className="w-6 h-6" />
          </button>
          <div>
            <h1 className="text-3xl font-black italic uppercase tracking-tighter leading-none">{overview?.manifest.display.name ?? sport}</h1>
            <p className="text-xs text-white/40 font-bold tracking-widest uppercase mt-1">
              On-device Brain · pack {overview ? `${overview.manifest.id}@${overview.manifest.version}` : '…'} · {overview?.manifest.display.status ?? ''}
            </p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-4 px-6 py-2 glass-card border-white/10">
          <Activity className="w-4 h-4 text-primary" />
          <span className="text-[10px] font-bold tracking-[0.2em] uppercase text-white/60">Frames stay on this device</span>
        </div>
      </header>

      <main className="relative z-10 flex-1 max-w-7xl mx-auto w-full grid grid-cols-1 md:grid-cols-12 gap-12 p-8">
        <div className="md:col-span-7 flex flex-col gap-6">
          <div>
            <h2 className="text-4xl font-black italic uppercase tracking-tight mb-3">Choose your <span className="text-primary underline decoration-primary/20">Movement</span></h2>
            <p className="text-white/60 max-w-md leading-relaxed text-sm">{sport === 'squash' ? 'Choose a position or movement from the Brain’s full squash library. Set your camera view and dominant hand before entering the training studio.' : overview?.manifest.display.description}</p>
            {overview && <p className="mt-3 text-xs text-primary">{overview.catalog.movements.length} movements available · Search by name or browse the movement families</p>}
          </div>
          {error && <div className="glass-card p-4 border-l-4 border-l-accent-danger text-sm text-accent-danger">Could not load the sport pack: {error}</div>}
          {overview && (
            <MovementPicker movements={overview.catalog.movements} taxonomy={overview.catalog.taxonomy} selected={movementId} onSelect={setMovementId} kind={movementKind} onKindChange={changeMovementKind} icon={icon} referenceSupport={overview.dynamic_reference_support} />
          )}

          {/* Calibration */}
          <div className="glass-card p-5 grid grid-cols-2 gap-4">
            <h3 className="col-span-2 text-[10px] font-black uppercase tracking-[0.2em] text-white/40">Calibration</h3>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-white/50 uppercase tracking-wider text-[10px]">Camera view</span>
              <select value={cal.nominal_view} onChange={(e) => setCal({ ...cal, nominal_view: e.target.value as Calibration['nominal_view'] })} className="bg-black/40 border border-white/10 rounded-lg p-2">
                {['front', 'left', 'right', 'back'].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-white/50 uppercase tracking-wider text-[10px]">Dominant hand</span>
              <select value={cal.handedness} onChange={(e) => setCal({ ...cal, handedness: e.target.value as Calibration['handedness'] })} className="bg-black/40 border border-white/10 rounded-lg p-2">
                {['right', 'left', 'unknown'].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            {referenceCoverage && <div className={`col-span-2 rounded-lg border p-3 text-xs leading-relaxed ${referenceCoverage.state === 'unavailable' ? 'border-amber-300/40 bg-amber-300/5' : 'border-sky-300/30 bg-sky-300/5'}`} data-testid="dynamic-reference-coverage">
              <p className="font-semibold text-white/90">{referenceCoverage.title}</p>
              <p className="mt-1 text-white/70">{referenceCoverage.detail}</p>
              {referenceCoverage.armWarning && <p className="mt-2 text-amber-200" data-testid="dynamic-reference-arm-coverage">{referenceCoverage.armWarning}</p>}
              {!!referenceCoverage.views.length && <p className="mt-1 text-white/60">Available recorded views for your hand: {referenceCoverage.views.join(', ')}.</p>}
              <p className="mt-1 text-white/50">Reference differences are provisional; the recording does not establish ball contact or an approved technique score.</p>
            </div>}
            {viewCoverage && viewCoverage.total > 0 && <p className="col-span-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-white/70" data-testid="camera-view-guidance">
              <span className="font-semibold text-primary">Camera placement: </span>
              {viewCoverage.selected < viewCoverage.maximum ? `${viewCoverage.recommended.join(' or ')} view supports more of this drill’s body checks (${viewCoverage.maximum}/${viewCoverage.total}); ${cal.nominal_view} supports ${viewCoverage.selected}/${viewCoverage.total}. ` : `${cal.nominal_view} view supports ${viewCoverage.selected}/${viewCoverage.total} body checks for this drill. `}
              {viewCoverage.excluded.length > 0 && `This view excludes ${viewCoverage.excluded.join(' and ')}. `}Match the setting to the camera’s actual position.
            </p>}
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-white/50 uppercase tracking-wider text-[10px]">Athlete level</span>
              <select value={cal.athlete_context ?? 'unknown'} onChange={(e) => setCal({ ...cal, athlete_context: e.target.value as Calibration['athlete_context'] })} className="bg-black/40 border border-white/10 rounded-lg p-2">
                {['unknown', 'novice', 'intermediate', 'advanced'].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-white/50 uppercase tracking-wider text-[10px]">Camera tilt (deg, blank = unknown)</span>
              <input type="number" step={1} min={-90} max={90} value={cal.camera_tilt_deg ?? ''} placeholder="0 = level"
                onChange={(e) => setCal({ ...cal, camera_tilt_deg: e.target.value === '' ? null : Math.max(-90, Math.min(90, Number(e.target.value))) })}
                className="bg-black/40 border border-white/10 rounded-lg p-2" />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-white/50 uppercase tracking-wider text-[10px]">Scale marker length (m, blank = no metric output)</span>
              <input type="number" step={0.01} min={0.1} max={5} value={cal.scale_marker_m ?? ''} placeholder="e.g. 1.00"
                onChange={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); setCal({ ...cal, scale_marker_m: v, scale_known: v !== null && Number.isFinite(v) && v > 0 }); }}
                className="bg-black/40 border border-white/10 rounded-lg p-2" />
            </label>
            <label className="flex items-center gap-3 text-xs">
              <input type="checkbox" checked={cal.floor_orientation_available ?? false} onChange={(e) => setCal({ ...cal, floor_orientation_available: e.target.checked })} className="accent-primary w-4 h-4" />
              <span className="text-white/70">Floor / horizon line is visible for orientation</span>
            </label>
            <label className="flex items-center gap-3 text-xs">
              <input type="checkbox" checked={cal.full_body_framing} onChange={(e) => setCal({ ...cal, full_body_framing: e.target.checked })} className="accent-primary w-4 h-4" />
              <span className="text-white/70">Full body (head to feet) is in frame</span>
            </label>
            {!cal.scale_known && (
              <p className="col-span-2 text-[10px] text-white/40 uppercase tracking-wider">Without a scale marker the Brain reports normalized body units only, never metres or metres per second.</p>
            )}
            {selected && !selected.permitted_views.includes(cal.nominal_view) && (
              <p className="col-span-2 text-[10px] text-accent-warning uppercase tracking-wider">This movement is defined for views: {selected.permitted_views.join(', ')}. Other views abstain.</p>
            )}
          </div>

          {/* Pose backend */}
          {sport !== 'squash' && <div className="glass-card p-5 flex flex-col gap-3">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40">Pose model (runs in the worker)</h3>
            <div className="grid grid-cols-2 gap-3">
              {POSE_BACKENDS.map((b) => (
                <button key={b.id} onClick={() => setPoseBackend(b.id)} className={`p-4 rounded-xl border text-left transition-all ${poseBackend === b.id ? 'border-primary/60 bg-primary/10' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}>
                  <div className="text-sm font-black uppercase tracking-wider">{b.label}</div>
                  <p className="text-[11px] text-white/50 mt-1 leading-snug">{b.description}</p>
                </button>
              ))}
            </div>
            {poseBackend === 'onnx_rtmo' && (
              <p className="text-[10px] text-accent-warning uppercase tracking-wider">
                Requires /models/rtmo-s_640.onnx (run `npm run fetch:models` in apps/frontend) and WebGPU; falls back to WASM, then to MediaPipe on the main thread.
              </p>
            )}
          </div>}

          {sport === 'squash' && <div className="glass-card p-5 flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Selected-drill recognition</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(['preview', 'validated'] as RecognitionMode[]).map(value => <button key={value} aria-pressed={recognition === value} onClick={() => setRecognition(value)} className={`p-4 rounded-xl border text-left ${recognition === value ? 'border-primary/60 bg-primary/10' : 'border-white/10 bg-white/5'}`}>
                <span className="text-sm font-semibold">{value === 'preview' ? 'Recognition preview' : 'Reviewed recognition only'}</span>
                <p className="mt-2 text-xs leading-relaxed text-white/60">{value === 'preview' ? 'Use only the model for this drill’s static or dynamic type. The selected target stays fixed while the Brain checks your attempt.' : 'Only show recognition backed by reviewed thresholds. Unreviewed model predictions will be withheld.'}</p>
              </button>)}
            </div>
            <p className="text-xs text-white/50">Your chosen drill remains the coaching target. Recognition is separate from technique corrections.</p>
          </div>}

          {/* Coaching mode */}
          <div className="glass-card p-5 flex flex-col gap-3">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white/40">Coaching mode</h3>
            <div className="grid grid-cols-2 gap-3">
              {(['strict', 'development'] as CoachingMode[]).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`p-4 rounded-xl border text-left transition-all ${mode === m ? (m === 'strict' ? 'border-secondary/60 bg-secondary/10' : 'border-accent-warning/60 bg-accent-warning/10') : 'border-white/10 bg-white/5 hover:bg-white/10'}`}>
                  <div className="text-sm font-semibold">{m === 'strict' ? 'Reviewed coaching' : 'Coaching preview'}</div>
                  <p className="text-[11px] text-white/50 mt-1 leading-snug">
                    {m === 'strict' ? 'Provisional rubrics abstain (UNCERTAIN); only reviewed cues are issued. Production default.' : 'Provisional rubrics are evaluated and draft cues are shown, each labelled PROVISIONAL. For development and coach review only.'}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="md:col-span-5 flex flex-col items-center justify-start sticky top-0">
          <div className="relative w-full glass-card rounded-3xl p-8 border-white/5 overflow-hidden">
            <div className="absolute inset-0 opacity-10" style={{ background: `radial-gradient(circle at center, ${color}, transparent 70%)` }} />
            <div className="relative z-10 flex flex-col gap-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary" data-testid="selected-training-type">{selected ? selected.type === 'static' ? 'Static position · hold the pose' : 'Dynamic movement · perform the sequence' : movementKind === 'dynamic' ? 'Choose a dynamic movement' : movementKind === 'static' ? 'Choose a static position' : 'Choose a training type and drill'}</p>
              <h4 className="text-2xl font-black uppercase tracking-tighter italic text-white">{selected?.canonical_name ?? 'Select a movement'}</h4>
              {selected && <p className="text-sm text-white/70">{selected.type === 'static' ? 'This drill checks a held position. To practise a swing or a moving sequence, choose Dynamic movements.' : 'Perform the movement, return to the starting position, and pause briefly after each attempt for feedback.'}</p>}
              {selected?.description && <p className="text-xs text-white/50 leading-relaxed">{selected.description}</p>}
              {graph && (
                <div>
                  <p className="text-[10px] text-primary font-black tracking-[0.3em] uppercase mb-2">Phases ({graph.kind.replace('_', ' ')})</p>
                  <div className="flex flex-wrap gap-2">
                    {graph.phases.map((p) => (
                      <span key={p.id} className="text-[10px] px-2 py-1 rounded border border-white/10 text-white/70">
                        {p.name}{p.contact_evidence !== 'none' ? ' *' : ''}
                      </span>
                    ))}
                  </div>
                  {graph.phases.some((p) => p.contact_evidence !== 'none') && <p className="text-[9px] text-white/30 mt-2">* contact is estimated from body pose, never observed</p>}
                </div>
              )}
              {selected && (
                <p className="text-[10px] text-white/40 leading-relaxed">
                  {selected.criteria.length} criteria · views {selected.permitted_views.join('/')} · {selected.required_capabilities.join(', ')}
                </p>
              )}
            </div>
          </div>
          <button disabled={!selected || !graph} onClick={handleStart} className="w-full mt-8 py-5 rounded-2xl bg-primary text-black font-black uppercase italic tracking-widest text-lg shadow-glow hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-4 disabled:opacity-40">
            Enter training studio <ChevronRight className="w-6 h-6" />
          </button>
          <p className="mt-4 text-[9px] text-white/30 leading-relaxed uppercase tracking-widest font-bold text-center">
            All thresholds in this pack are provisional engineering seeds pending coach validation.
          </p>
        </div>
      </main>
    </div>
  );
}
