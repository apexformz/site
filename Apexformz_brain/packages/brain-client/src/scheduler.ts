/**
 * Adaptive perception scheduler (TRD 01 "Scheduling, buffers and backpressure").
 *
 * The client schedules perception from measured inference time and the thermal budget. When the
 * loop cannot keep up, the fallback order is fixed by the TRD: first reduce the capture frequency,
 * then reduce the input resolution, and only then would core movement checks be at risk. This
 * scheduler never goes below a floor that keeps the core checks running; it has no sport knowledge.
 *
 * Pure and deterministic so it can be unit-tested; the UI feeds it observations and reads the
 * current interval and scale.
 */
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical' | null | undefined;

export interface SchedulerOptions {
  /** Target capture rate when the device keeps up. */
  target_fps: number;
  /** Floor below which core movement checks lose temporal resolution; the scheduler never goes lower. */
  min_fps: number;
  /** Fraction of the frame interval the pose + brain work may consume before we degrade. */
  budget_fraction: number;
  /** Consecutive over-budget observations before stepping down one level. */
  degrade_after: number;
  /** Consecutive comfortably-under-budget observations before stepping up one level. */
  recover_after: number;
  /** Queue age (ms) that counts as backlog regardless of processing time. */
  max_queue_age_ms: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  target_fps: 24,
  min_fps: 8,
  budget_fraction: 0.8,
  degrade_after: 6,
  recover_after: 45,
  max_queue_age_ms: 120,
};

export interface ScheduleLevel {
  level: number;
  /** Capture interval in ms. */
  interval_ms: number;
  /** Input scale factor applied to the camera frame before inference (1 = native). */
  scale: number;
  /** Human-readable reason for telemetry. */
  mode: 'full' | 'reduced_frequency' | 'reduced_resolution' | 'minimum';
}

/** Level table: frequency first, resolution second, never below min_fps and 0.5 scale. */
const LEVELS: Array<{ fps_factor: number; scale: number; mode: ScheduleLevel['mode'] }> = [
  { fps_factor: 1.0, scale: 1.0, mode: 'full' },
  { fps_factor: 0.6, scale: 1.0, mode: 'reduced_frequency' },
  { fps_factor: 0.5, scale: 0.75, mode: 'reduced_resolution' },
  { fps_factor: 0.35, scale: 0.5, mode: 'minimum' },
];

export class AdaptiveScheduler {
  readonly options: SchedulerOptions;
  private level = 0;
  private over = 0;
  private under = 0;
  private thermalFloor = 0;
  private transitions = 0;

  constructor(options: Partial<SchedulerOptions> = {}) {
    this.options = { ...DEFAULT_SCHEDULER_OPTIONS, ...options };
  }

  get current(): ScheduleLevel {
    const l = LEVELS[this.level];
    const fps = Math.max(this.options.min_fps, this.options.target_fps * l.fps_factor);
    return { level: this.level, interval_ms: 1000 / fps, scale: l.scale, mode: l.mode };
  }

  get stats() {
    return { level: this.level, transitions: this.transitions, thermal_floor: this.thermalFloor };
  }

  /** Thermal pressure forces a minimum level; it is released when the state returns to nominal/fair. */
  thermal(state: ThermalState): void {
    this.thermalFloor = state === 'critical' ? 3 : state === 'serious' ? 2 : 0;
    if (this.level < this.thermalFloor) this.set(this.thermalFloor);
  }

  /**
   * Observe one processed frame: total processing time (pose + brain) and the age of the frame
   * when processing started. Returns the schedule to apply to the next capture.
   */
  observe(processingMs: number, queueAgeMs = 0): ScheduleLevel {
    const budget = this.current.interval_ms * this.options.budget_fraction;
    const overBudget = processingMs > budget || queueAgeMs > this.options.max_queue_age_ms;
    if (overBudget) {
      this.over++;
      this.under = 0;
      if (this.over >= this.options.degrade_after && this.level < LEVELS.length - 1) {
        this.set(this.level + 1);
        this.over = 0;
      }
    } else {
      this.over = 0;
      if (processingMs < budget * 0.5 && queueAgeMs < this.options.max_queue_age_ms * 0.5) this.under++;
      else this.under = 0;
      if (this.under >= this.options.recover_after && this.level > this.thermalFloor) {
        this.set(this.level - 1);
        this.under = 0;
      }
    }
    return this.current;
  }

  reset(): void {
    this.level = this.thermalFloor;
    this.over = 0;
    this.under = 0;
  }

  private set(level: number): void {
    const next = Math.max(this.thermalFloor, Math.min(LEVELS.length - 1, level));
    if (next !== this.level) this.transitions++;
    this.level = next;
  }
}
