import { BrainError, type ErrorCode, type SessionState, type SessionTransition } from '@apexformz/contracts';

/**
 * Session state machine (TRD 01).
 *   IDLE -> PERMISSIONS -> CALIBRATING -> READY -> ACTIVE
 *   ACTIVE <-> PAUSED, ACTIVE <-> DEGRADED
 *   ACTIVE -> COMPLETING -> LOCAL_COMMITTED -> SYNC_PENDING -> SYNCED
 *   any -> FAILED
 * Transitions are idempotent (same state is a no-op) and timestamped.
 */
const ALLOWED: Record<SessionState, SessionState[]> = {
  IDLE: ['PERMISSIONS', 'FAILED'],
  PERMISSIONS: ['CALIBRATING', 'IDLE', 'FAILED'],
  CALIBRATING: ['READY', 'PERMISSIONS', 'FAILED'],
  READY: ['ACTIVE', 'CALIBRATING', 'IDLE', 'FAILED'],
  ACTIVE: ['PAUSED', 'DEGRADED', 'COMPLETING', 'FAILED'],
  PAUSED: ['ACTIVE', 'COMPLETING', 'FAILED'],
  DEGRADED: ['ACTIVE', 'PAUSED', 'COMPLETING', 'FAILED'],
  COMPLETING: ['LOCAL_COMMITTED', 'FAILED'],
  LOCAL_COMMITTED: ['SYNC_PENDING', 'SYNCED', 'FAILED'],
  SYNC_PENDING: ['SYNCED', 'LOCAL_COMMITTED', 'FAILED'],
  SYNCED: ['IDLE'],
  FAILED: ['IDLE'],
};

export class SessionStateMachine {
  private current: SessionState = 'IDLE';
  private history: SessionTransition[] = [];

  constructor(private readonly onTransition?: (t: SessionTransition) => void) {}

  get state(): SessionState {
    return this.current;
  }

  get transitions(): readonly SessionTransition[] {
    return this.history;
  }

  can(to: SessionState): boolean {
    return to === this.current || ALLOWED[this.current].includes(to);
  }

  transition(to: SessionState, monotonicMs: number, reason: string, errorCode: ErrorCode | null = null): SessionTransition | null {
    if (to === this.current) return null; // idempotent
    if (!ALLOWED[this.current].includes(to)) {
      throw new BrainError('INVALID_TRANSITION', `session cannot move from ${this.current} to ${to}`, { recoverable: true, details: { from: this.current, to, reason } });
    }
    const t: SessionTransition = { from: this.current, to, monotonic_ms: monotonicMs, reason, error_code: errorCode };
    this.current = to;
    this.history.push(t);
    this.onTransition?.(t);
    return t;
  }

  isActiveLike(): boolean {
    return this.current === 'ACTIVE' || this.current === 'DEGRADED';
  }
}
