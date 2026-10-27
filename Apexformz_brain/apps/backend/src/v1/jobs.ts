/**
 * Advanced analysis job dispatcher (TRD 13): QUEUED -> RUNNING -> COMPLETED | FAILED/RETRYABLE.
 * Durable commits via the injected store, bounded retries with exponential backoff,
 * injectable HTTP client and clock so the state machine is unit-testable offline.
 */
import { randomUUID } from 'node:crypto';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'RETRYABLE';

export interface JobRecord {
  id: string;
  owner_id: string;
  asset_ref: string | null;
  consent_scope: string;
  status: JobStatus;
  output_ref: string | null;
  error: string | null;
  attempts: number;
  request: Record<string, unknown> | null;
  updated_at: number;
  remote_id?: string | null;
  output?: Record<string, unknown> | null;
  next_attempt_at?: number | null;
  lease_token?: string | null;
  lease_expires_at?: number | null;
}

export interface JobStore {
  claimNext(nowMs: number, notBeforeMs: number, leaseMs?: number): Promise<JobRecord | null>;
  /** Fenced updates: a worker cannot commit after another worker recovers its lease. */
  update(id: string, patch: Partial<JobRecord>, leaseToken?: string): Promise<boolean>;
}

export interface JobHttpClient {
  submit(job: JobRecord): Promise<{ remote_id: string }>;
  poll(remoteId: string): Promise<{ status: 'RUNNING' | 'COMPLETED' | 'FAILED'; output_ref?: string; output?: Record<string, unknown>; error?: string }>;
}

export interface DispatcherOptions {
  maxAttempts: number;
  baseBackoffMs: number;
  pollIntervalMs: number;
  maxPolls: number;
  leaseMs?: number;
}

export const DEFAULT_DISPATCHER_OPTIONS: DispatcherOptions = { maxAttempts: 5, baseBackoffMs: 1000, pollIntervalMs: 500, maxPolls: 120 };

export class TransientError extends Error {}
/** Remote state disappeared (e.g. an AI-service restart); durable input can be resubmitted. */
export class RemoteJobMissingError extends TransientError {}

export class InMemoryJobStore implements JobStore {
  readonly jobs = new Map<string, JobRecord>();

  add(job: JobRecord): void {
    this.jobs.set(job.id, job);
  }

  async claimNext(nowMs: number, notBeforeMs: number, leaseMs = 30000): Promise<JobRecord | null> {
    for (const j of this.jobs.values()) {
      if (j.status === 'QUEUED' || (j.status === 'RETRYABLE' && (j.next_attempt_at ?? j.updated_at) <= notBeforeMs)
          || (j.status === 'RUNNING' && (j.lease_expires_at ?? 0) <= nowMs)) {
        j.status = 'RUNNING';
        j.updated_at = nowMs;
        j.attempts++;
        j.lease_token = randomUUID();
        j.lease_expires_at = nowMs + leaseMs;
        j.next_attempt_at = null;
        return { ...j };
      }
    }
    return null;
  }

  async update(id: string, patch: Partial<JobRecord>, leaseToken?: string): Promise<boolean> {
    const j = this.jobs.get(id);
    if (!j || (leaseToken && (j.status !== 'RUNNING' || j.lease_token !== leaseToken))) return false;
    Object.assign(j, patch);
    return true;
  }
}

export class JobDispatcher {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: JobStore,
    private readonly http: JobHttpClient,
    private readonly clock: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly opts: DispatcherOptions = DEFAULT_DISPATCHER_OPTIONS,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void = () => undefined,
  ) {}

  backoffMs(attempts: number): number {
    return this.opts.baseBackoffMs * 2 ** Math.max(0, attempts - 1);
  }

  /** Process at most one job. Returns the final status or null when idle. */
  async step(): Promise<JobStatus | null> {
    const now = this.clock();
    const leaseMs = this.opts.leaseMs ?? 30000;
    const job = await this.store.claimNext(now, now, leaseMs);
    if (!job) return null;
    const attempts = job.attempts;
    const update = (patch: Partial<JobRecord>) => this.store.update(job.id, patch, job.lease_token ?? undefined);
    const terminal = { lease_token: null, lease_expires_at: null, next_attempt_at: null };
    if (attempts > this.opts.maxAttempts) {
      if (!await update({ ...terminal, status: 'FAILED', error: 'worker recovery attempt limit exceeded', updated_at: now })) return null;
      return 'FAILED';
    }
    try {
      const remote_id = job.remote_id ?? (await this.http.submit(job)).remote_id;
      if (!await update({ remote_id, updated_at: this.clock(), lease_expires_at: this.clock() + leaseMs })) return null;
      for (let i = 0; i < this.opts.maxPolls; i++) {
        if (!await update({ updated_at: this.clock(), lease_expires_at: this.clock() + leaseMs })) return null;
        const r = await this.http.poll(remote_id);
        if (r.status === 'COMPLETED') {
          if (!await update({ ...terminal, status: 'COMPLETED', output_ref: r.output_ref ?? null, output: r.output ?? null, error: null, updated_at: this.clock() })) return null;
          this.log('info', `analysis job ${job.id} completed`);
          return 'COMPLETED';
        }
        if (r.status === 'FAILED') {
          if (!await update({ ...terminal, status: 'FAILED', error: r.error ?? 'remote failure', updated_at: this.clock() })) return null;
          this.log('warn', `analysis job ${job.id} failed remotely`);
          return 'FAILED';
        }
        await this.sleep(this.opts.pollIntervalMs);
      }
      throw new TransientError('poll timeout');
    } catch (e) {
      const transient = e instanceof TransientError;
      if (transient && attempts < this.opts.maxAttempts) {
        if (!await update({ ...terminal, status: 'RETRYABLE', error: (e as Error).message,
          ...(e instanceof RemoteJobMissingError ? { remote_id: null } : {}),
          updated_at: this.clock(), next_attempt_at: this.clock() + this.backoffMs(attempts) })) return null;
        this.log('warn', `analysis job ${job.id} retryable (attempt ${attempts})`);
        return 'RETRYABLE';
      }
      if (!await update({ ...terminal, status: 'FAILED', error: (e as Error).message, updated_at: this.clock() })) return null;
      this.log('error', `analysis job ${job.id} failed after ${attempts} attempt(s)`);
      return 'FAILED';
    }
  }

  start(intervalMs: number): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.step();
      } catch (e) {
        this.log('error', `dispatcher loop error: ${(e as Error).message}`);
      }
      if (this.running) this.timer = setTimeout(loop, intervalMs);
    };
    this.timer = setTimeout(loop, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
