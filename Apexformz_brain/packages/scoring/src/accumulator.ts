import type { MissingReason } from '@apexformz/contracts';
import type { FeatureMap } from '@apexformz/features';

export interface FeatureSample {
  frame_id: number;
  timestamp_ms: number;
  value: number;
  confidence: number;
}

export interface PhaseFeatureStats {
  samples: FeatureSample[];
  invalid_reasons: Record<string, number>;
  frames: number;
}

/**
 * Collects per-phase feature samples and quality flags during an execution so
 * criteria can be evaluated at phase boundaries with explicit aggregates.
 */
export class PhaseAccumulator {
  private byPhase = new Map<string, Map<string, PhaseFeatureStats>>();
  private qualityBad = new Map<string, { bad: number; total: number; reasons: Record<string, number> }>();
  private phaseFrames = new Map<string, number[]>();

  reset(): void {
    this.byPhase.clear();
    this.qualityBad.clear();
    this.phaseFrames.clear();
  }

  observe(phaseId: string, features: FeatureMap, frameId: number, timestampMs: number, qualityOk: boolean, qualityReasons: MissingReason[] = []): void {
    let fm = this.byPhase.get(phaseId);
    if (!fm) {
      fm = new Map();
      this.byPhase.set(phaseId, fm);
    }
    for (const [id, f] of features) {
      let st = fm.get(id);
      if (!st) {
        st = { samples: [], invalid_reasons: {}, frames: 0 };
        fm.set(id, st);
      }
      st.frames++;
      if (f.valid && f.value !== null) st.samples.push({ frame_id: frameId, timestamp_ms: timestampMs, value: f.value, confidence: f.confidence ?? 0 });
      else st.invalid_reasons[f.reason ?? 'MISSING_JOINT'] = (st.invalid_reasons[f.reason ?? 'MISSING_JOINT'] ?? 0) + 1;
    }
    let q = this.qualityBad.get(phaseId);
    if (!q) {
      q = { bad: 0, total: 0, reasons: {} };
      this.qualityBad.set(phaseId, q);
    }
    q.total++;
    if (!qualityOk) {
      q.bad++;
      for (const r of qualityReasons) q.reasons[r] = (q.reasons[r] ?? 0) + 1;
    }
    let frames = this.phaseFrames.get(phaseId);
    if (!frames) {
      frames = [];
      this.phaseFrames.set(phaseId, frames);
    }
    frames.push(frameId);
  }

  stats(phaseId: string, featureId: string): PhaseFeatureStats | null {
    return this.byPhase.get(phaseId)?.get(featureId) ?? null;
  }

  frames(phaseId: string): number[] {
    return this.phaseFrames.get(phaseId) ?? [];
  }

  quality(phaseId: string): { bad_fraction: number; dominant_reason: MissingReason | null; total: number } {
    const q = this.qualityBad.get(phaseId);
    if (!q || !q.total) return { bad_fraction: 0, dominant_reason: null, total: 0 };
    const dominant = Object.entries(q.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] as MissingReason | undefined;
    return { bad_fraction: q.bad / q.total, dominant_reason: dominant ?? null, total: q.total };
  }

  /** Merge stats across several phases (for criteria with phase_ids null => whole execution). */
  merged(phaseIds: string[], featureId: string): PhaseFeatureStats {
    const out: PhaseFeatureStats = { samples: [], invalid_reasons: {}, frames: 0 };
    for (const p of phaseIds) {
      const st = this.stats(p, featureId);
      if (!st) continue;
      out.samples.push(...st.samples);
      out.frames += st.frames;
      for (const [r, n] of Object.entries(st.invalid_reasons)) out.invalid_reasons[r] = (out.invalid_reasons[r] ?? 0) + n;
    }
    out.samples.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    return out;
  }

  phaseIds(): string[] {
    return [...this.byPhase.keys()];
  }
}
