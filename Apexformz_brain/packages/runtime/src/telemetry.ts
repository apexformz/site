import { CONTRACT_VERSION, type TelemetrySample } from '@apexformz/contracts';

const now = (): number => {
  const p = (globalThis as unknown as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
};

/**
 * Per-stage duration and counter collector (TRD 00/14). Never records images.
 */
export class TelemetryCollector {
  private durations = new Map<string, { last: number; ema: number; max: number; n: number }>();
  private counters = new Map<string, number>();
  private abstentions = new Map<string, number>();
  private unknownUpdates = 0;
  private totalUpdates = 0;
  private lastCoverage: number | null = null;
  private fpsEma: number | null = null;
  private lastFrameTs: number | null = null;

  time<T>(stage: string, fn: () => T): T {
    const t0 = now();
    try {
      return fn();
    } finally {
      this.record(stage, now() - t0);
    }
  }

  record(stage: string, ms: number): void {
    const cur = this.durations.get(stage);
    if (!cur) this.durations.set(stage, { last: ms, ema: ms, max: ms, n: 1 });
    else {
      cur.last = ms;
      cur.ema = cur.ema * 0.9 + ms * 0.1;
      cur.max = Math.max(cur.max, ms);
      cur.n++;
    }
  }

  increment(counter: string, by = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
  }

  count(counter: string): number {
    return this.counters.get(counter) ?? 0;
  }

  abstain(reason: string, by = 1): void {
    this.abstentions.set(reason, (this.abstentions.get(reason) ?? 0) + by);
  }

  recognition(state: string): void {
    this.totalUpdates++;
    if (state === 'UNKNOWN' || state === 'ABORTED') this.unknownUpdates++;
  }

  coverage(ratio: number | null): void {
    if (ratio !== null) this.lastCoverage = ratio;
  }

  frame(timestampMs: number): void {
    if (this.lastFrameTs !== null) {
      const dt = timestampMs - this.lastFrameTs;
      if (dt > 0 && dt < 2000) {
        const fps = 1000 / dt;
        this.fpsEma = this.fpsEma === null ? fps : this.fpsEma * 0.8 + fps * 0.2;
      }
    }
    this.lastFrameTs = timestampMs;
  }

  stageDurations(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.durations) {
      out[`${k}_ms_ema`] = round(v.ema);
      out[`${k}_ms_max`] = round(v.max);
    }
    return out;
  }

  sample(sessionId: string, monotonicMs: number, queueAgeMs: number, executedPacks: string[], memoryMb: number | null = null): TelemetrySample {
    return {
      schema_version: CONTRACT_VERSION,
      session_id: sessionId,
      monotonic_ms: monotonicMs,
      stage_durations_ms: this.stageDurations(),
      queue_age_ms: Math.max(0, queueAgeMs),
      discarded_frames: this.count('discarded_frames'),
      dropped_inferences: this.count('dropped_inferences'),
      timeouts: this.count('timeouts'),
      memory_mb: memoryMb,
      observed_fps: this.fpsEma === null ? null : round(this.fpsEma),
      abstention_reasons: Object.fromEntries(this.abstentions),
      unknown_movement_rate: this.totalUpdates ? round(this.unknownUpdates / this.totalUpdates) : null,
      criteria_coverage: this.lastCoverage,
      executed_packs: executedPacks,
      thermal_state: null,
    };
  }
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
