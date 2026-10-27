"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, ChevronRight, Focus, Search, ShieldAlert } from 'lucide-react';
import type { MovementDefinition, MovementTaxonomy } from '@apexformz/contracts';
import type { MovementKind } from '@/lib/brain/movementSelection';
import type { DynamicReferenceSupport } from '@/lib/brain/referenceCoverage';

interface Props {
  movements: MovementDefinition[];
  taxonomy?: MovementTaxonomy;
  selected: string | null;
  onSelect: (id: string) => void;
  kind: MovementKind;
  onKindChange: (kind: MovementKind) => void;
  icon: (m: MovementDefinition) => React.ReactNode;
  referenceSupport?: Record<string, DynamicReferenceSupport>;
}

const DATA_BADGE: Record<string, string> = { no_training_data: 'No usable recording', no_capture_data: 'Not yet captured' };

function MovementCard({ m, selected, onSelect, icon, referenceLabel }: { m: MovementDefinition; selected: boolean; onSelect: (id: string) => void; icon: Props['icon']; referenceLabel?: string }) {
  const legacy = m.aliases.filter((a) => a.status === 'approved' && !a.name.includes('.')).map((a) => a.name).join(', ');
  return (
    <motion.button
      whileHover={{ x: 4 }}
      onClick={() => onSelect(m.id)}
      aria-pressed={selected}
      data-movement-id={m.id}
      className={`group relative p-3 text-left transition-all rounded-xl border flex items-center justify-between gap-3 ${selected ? 'bg-white/10 border-primary/50 shadow-glow shadow-primary/5' : 'bg-white/5 border-transparent hover:bg-white/10'}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center transition-colors ${selected ? 'bg-primary text-black' : 'bg-white/5 text-white/40'}`}>{icon(m)}</div>
        <div className="min-w-0">
          <h4 className="text-sm font-bold leading-tight">{m.canonical_name}</h4>
          <p className="text-[10px] text-primary/80 mt-1">{m.type === 'static' ? 'Static position · hold' : 'Dynamic movement · sequence'}</p>
          {referenceLabel && <p className="text-[10px] text-sky-200 mt-1">{referenceLabel}</p>}
          <p className="text-[10px] text-white/30 truncate max-w-[320px]" title={m.description}>{legacy || m.description || m.id}</p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {m.data_status && DATA_BADGE[m.data_status] && <span className="text-[8px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded border border-white/20 text-white/50">{DATA_BADGE[m.data_status]}</span>}
        {m.review_status !== 'approved' && <ShieldAlert className="w-3.5 h-3.5 text-accent-warning" aria-label="Coach review required" />}
        {selected && <Focus className="w-4 h-4 text-primary" />}
      </div>
    </motion.button>
  );
}

/**
 * Hierarchical movement picker: family -> group -> movement, following the sport pack taxonomy.
 * Falls back to a flat list for packs without a taxonomy.
 */
export function MovementPicker({ movements, taxonomy, selected, onSelect, kind, onKindChange, icon, referenceSupport }: Props) {
  const byId = useMemo(() => new Map(movements.map((m) => [m.id, m])), [movements]);
  const [query, setQuery] = useState('');
  const [openFamily, setOpenFamily] = useState<string | null>(null);

  // Open the family that holds the current selection.
  useEffect(() => {
    if (!taxonomy || !selected) return;
    const fam = byId.get(selected)?.family_id;
    if (fam) setOpenFamily(fam);
  }, [taxonomy, selected, byId]);

  const q = query.trim().toLowerCase();
  const matches = (m: MovementDefinition | undefined) => !!m && (!q || m.canonical_name.toLowerCase().includes(q) || m.aliases.some((a) => a.name.toLowerCase().includes(q)));
  const completeMovements = movements.filter(m => m.type === 'dynamic' && referenceSupport?.[m.id]?.views.some(view => view.complete_captures > 0));
  const completeIds = new Set(completeMovements.map(m => m.id));
  const priority = kind === 'static' ? [] : completeMovements.filter(matches);
  const matchesLibrary = (m: MovementDefinition | undefined) => !!m && matches(m) && !completeIds.has(m.id);
  const families = taxonomy?.families.filter((f) => kind === 'all' || f.type === kind) ?? [];
  const selectedMovement = selected ? byId.get(selected) : undefined;
  const selectedFamily = selectedMovement ? taxonomy?.families.find((f) => f.id === selectedMovement.family_id) : undefined;
  const selectedGroup = selectedFamily?.groups.find((g) => g.id === selectedMovement?.group_id);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 flex-1 min-w-[200px] bg-black/40 border border-white/10 rounded-lg px-3 py-2">
          <Search className="w-4 h-4 text-white/40" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search movements" className="bg-transparent outline-none text-sm flex-1" aria-label="Search movements" />
        </label>
        {(['static', 'dynamic', 'all'] as const).map((k) => (
          <button key={k} aria-pressed={kind === k} onClick={() => { onKindChange(k); setOpenFamily(null); }} className={`text-xs font-semibold px-3 py-2 rounded-lg border ${kind === k ? 'border-primary/60 bg-primary/10 text-primary' : 'border-white/10 text-white/50 hover:bg-white/5'}`}>{k === 'all' ? 'Browse all' : k === 'static' ? 'Static positions' : 'Dynamic movements'}</button>
        ))}
      </div>
      {selectedMovement && (
        <p className="text-[10px] uppercase tracking-wider text-white/40">
          {selectedFamily?.name}{selectedGroup ? ` › ${selectedGroup.name}` : ''} › <span className="text-primary">{selectedMovement.canonical_name}</span>
        </p>
      )}
      <div className="flex flex-col gap-2 max-h-[46vh] overflow-y-auto pr-3 custom-scrollbar" data-testid="movement-options">
        {!!priority.length && <section className="rounded-2xl border border-sky-300/30 bg-sky-300/5 p-4" data-testid="complete-recorded-movements">
          <h3 className="text-base font-bold text-sky-200">Complete recorded movements ({priority.length})</h3>
          <p className="mt-1 text-xs leading-relaxed text-white/60">Start with these movements for full recording comparisons. Match the camera view and dominant hand shown on each movement. Coaching remains provisional.</p>
          <div className="mt-3 flex flex-col gap-2">
            {priority.map(m => <MovementCard key={m.id} m={m} selected={selected === m.id} onSelect={onSelect} icon={icon}
              referenceLabel={`Full reference: ${referenceSupport![m.id].views.filter(view => view.complete_captures > 0).map(view => `${view.view} view · ${view.handedness}-handed`).join('; ')}`} />)}
          </div>
        </section>}
        {!!priority.length && <h3 className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-white/50">More movements</h3>}
        {!taxonomy && movements.filter(m => (kind === 'all' || m.type === kind) && matchesLibrary(m)).map((m) => <MovementCard key={m.id} m={m} selected={selected === m.id} onSelect={onSelect} icon={icon} />)}
        {families.map((f) => {
          const groups = f.groups.map((g) => ({ g, members: g.members.map((id) => byId.get(id)).filter(matchesLibrary) as MovementDefinition[] })).filter((x) => x.members.length);
          const count = groups.reduce((n, x) => n + x.members.length, 0);
          if (!count) return null;
          const open = !!q || openFamily === f.id;
          return (
            <div key={f.id} className="rounded-2xl border border-white/10 bg-white/[0.03]">
              <button onClick={() => setOpenFamily(open && !q ? null : f.id)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 p-4 text-left">
                <div className="min-w-0">
                  <h3 className="text-base font-bold leading-tight">{f.name}</h3>
                  {f.description && <p className="text-[11px] text-white/40 leading-snug mt-1 line-clamp-2">{f.description}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded border border-white/20 text-white/60">{f.type}</span>
                  <span className="text-[10px] font-mono text-white/50">{count}</span>
                  {open ? <ChevronDown className="w-4 h-4 text-white/50" /> : <ChevronRight className="w-4 h-4 text-white/50" />}
                </div>
              </button>
              {open && (
                <div className="flex flex-col gap-3 px-4 pb-4">
                  {groups.map(({ g, members }) => (
                    <div key={g.id} className="flex flex-col gap-1.5">
                      {f.groups.length > 1 && <h5 className="text-[10px] font-black uppercase tracking-[0.15em] text-white/40 pl-1">{g.name}</h5>}
                      {members.map((m) => <MovementCard key={m.id} m={m} selected={selected === m.id} onSelect={onSelect} icon={icon} />)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
