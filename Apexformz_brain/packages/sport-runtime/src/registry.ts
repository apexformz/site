import { BrainError, compareSemver, type SportPackBundle } from '@apexformz/contracts';

interface Installed {
  bundle: SportPackBundle;
  installed_at: number;
  known_good: boolean;
}

/**
 * Sport pack registry (TRD 05/13). Immutable versions, explicit activation
 * between sessions only, previous known-good retained for rollback, and
 * per-session pinning so updates never affect an active session (G10).
 */
export class SportPackRegistry {
  private installed = new Map<string, Map<string, Installed>>();
  private active = new Map<string, string>();
  private pins = new Map<string, { id: string; version: string }>();
  private readonly maxResidentPerSport: number;
  private clock: () => number;

  constructor(options: { max_resident_per_sport?: number; clock?: () => number } = {}) {
    this.maxResidentPerSport = options.max_resident_per_sport ?? 2;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Install an already validated bundle. Does not activate. */
  install(bundle: SportPackBundle): void {
    const { id, version } = bundle.manifest;
    let versions = this.installed.get(id);
    if (!versions) {
      versions = new Map();
      this.installed.set(id, versions);
    }
    if (versions.has(version)) throw new BrainError('PACK_VALIDATION_FAILED', `pack ${id}@${version} already installed; versions are immutable`, { recoverable: true });
    versions.set(version, { bundle, installed_at: this.clock(), known_good: false });
    this.evict(id);
  }

  /**
   * Activate a version. Refused while any session pins this sport (activation only between sessions).
   * The previously active version is retained as known-good for rollback.
   */
  activate(id: string, version: string): SportPackBundle {
    const inst = this.installed.get(id)?.get(version);
    if (!inst) throw new BrainError('UNKNOWN_SPORT_PACK', `pack ${id}@${version} is not installed`, { recoverable: false });
    const pinnedSessions = [...this.pins.entries()].filter(([, p]) => p.id === id);
    if (pinnedSessions.length) {
      throw new BrainError('PACK_ACTIVATION_LOCKED', `pack ${id} is pinned by ${pinnedSessions.length} active session(s); activate between sessions`, {
        recoverable: true,
        details: { sessions: pinnedSessions.map(([s]) => s) },
      });
    }
    const prev = this.active.get(id);
    if (prev) {
      const p = this.installed.get(id)?.get(prev);
      if (p) p.known_good = true;
    }
    this.active.set(id, version);
    this.evict(id);
    return inst.bundle;
  }

  /** Roll back to the most recent known-good version. */
  rollback(id: string): SportPackBundle {
    const versions = this.installed.get(id);
    if (!versions) throw new BrainError('UNKNOWN_SPORT_PACK', `no versions of ${id}`, { recoverable: false });
    const current = this.active.get(id);
    const candidates = [...versions.entries()].filter(([v, i]) => i.known_good && v !== current).sort((a, b) => compareSemver(b[0], a[0]));
    if (!candidates.length) throw new BrainError('UNKNOWN_SPORT_PACK', `no known-good version of ${id} to roll back to`, { recoverable: false });
    this.active.set(id, candidates[0][0]);
    return candidates[0][1].bundle;
  }

  getActive(id: string): SportPackBundle | null {
    const v = this.active.get(id);
    return v ? this.installed.get(id)?.get(v)?.bundle ?? null : null;
  }

  activeVersion(id: string): string | null {
    return this.active.get(id) ?? null;
  }

  get(id: string, version: string): SportPackBundle | null {
    return this.installed.get(id)?.get(version)?.bundle ?? null;
  }

  listInstalled(): Array<{ id: string; version: string; active: boolean; known_good: boolean }> {
    const out: Array<{ id: string; version: string; active: boolean; known_good: boolean }> = [];
    for (const [id, versions] of this.installed) {
      for (const [v, i] of versions) out.push({ id, version: v, active: this.active.get(id) === v, known_good: i.known_good });
    }
    return out;
  }

  /** Pin the active version of a sport for a session. Returns the pinned bundle. */
  pin(sessionId: string, id: string, version?: string): SportPackBundle {
    const v = version ?? this.active.get(id);
    if (!v) throw new BrainError('UNKNOWN_SPORT_PACK', `no active version of ${id} to pin`, { recoverable: false });
    const inst = this.installed.get(id)?.get(v);
    if (!inst) throw new BrainError('UNKNOWN_SPORT_PACK', `pack ${id}@${v} is not installed`, { recoverable: false });
    this.pins.set(sessionId, { id, version: v });
    return inst.bundle;
  }

  pinned(sessionId: string): SportPackBundle | null {
    const p = this.pins.get(sessionId);
    return p ? this.get(p.id, p.version) : null;
  }

  pinnedVersion(sessionId: string): { id: string; version: string } | null {
    return this.pins.get(sessionId) ?? null;
  }

  unpin(sessionId: string): void {
    this.pins.delete(sessionId);
    for (const id of this.installed.keys()) this.evict(id);
  }

  /** Cap residency: evict oldest versions that are neither active, pinned nor the newest known-good. */
  private evict(id: string): void {
    const versions = this.installed.get(id);
    if (!versions || versions.size <= this.maxResidentPerSport) return;
    const protectedVersions = new Set<string>();
    const act = this.active.get(id);
    if (act) protectedVersions.add(act);
    for (const p of this.pins.values()) if (p.id === id) protectedVersions.add(p.version);
    const knownGood = [...versions.entries()].filter(([, i]) => i.known_good).sort((a, b) => compareSemver(b[0], a[0]))[0];
    if (knownGood) protectedVersions.add(knownGood[0]);
    const evictable = [...versions.entries()].filter(([v]) => !protectedVersions.has(v)).sort((a, b) => a[1].installed_at - b[1].installed_at);
    while (versions.size > this.maxResidentPerSport && evictable.length) {
      const [v] = evictable.shift()!;
      versions.delete(v);
    }
  }
}
