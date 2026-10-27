import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { resolveOwnedAsset, storageConfig } from './assets';
import { JobDispatcher, RemoteJobMissingError, TransientError, type JobHttpClient, type JobRecord, type JobStore } from './jobs';

export class PrismaJobStore implements JobStore {
  async claimNext(nowMs: number, notBeforeMs: number, leaseMs = 30000): Promise<JobRecord | null> {
    const row = await prisma.$transaction(async tx => {
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "AnalysisJob"
        WHERE "status" = 'QUEUED'
          OR ("status" = 'RETRYABLE' AND COALESCE("next_attempt_at", "updated_at") <= (to_timestamp(${notBeforeMs}::double precision / 1000.0) AT TIME ZONE 'UTC'))
          OR ("status" = 'RUNNING' AND "lease_expires_at" <= (to_timestamp(${nowMs}::double precision / 1000.0) AT TIME ZONE 'UTC'))
        ORDER BY "created_at", "id" LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!candidates.length) return null;
      return tx.analysisJob.update({ where: { id: candidates[0].id }, data: {
        status: 'RUNNING', attempts: { increment: 1 }, updated_at: new Date(nowMs), next_attempt_at: null,
        lease_token: randomUUID(), lease_expires_at: new Date(nowMs + leaseMs),
      } });
    });
    if (!row) return null;
    return {
      id: row.id, owner_id: row.owner_id, asset_ref: row.asset_ref, consent_scope: row.consent_scope, status: 'RUNNING',
      output_ref: row.output_ref, error: row.error, attempts: row.attempts, request: (row.request as Record<string, unknown> | null) ?? null, updated_at: nowMs,
      remote_id: row.remote_id, lease_token: row.lease_token, lease_expires_at: row.lease_expires_at?.getTime() ?? null,
      output: row.output as Record<string, unknown> | null,
      next_attempt_at: row.next_attempt_at?.getTime() ?? null,
    };
  }

  async update(id: string, patch: Partial<JobRecord>, leaseToken?: string): Promise<boolean> {
    const { updated_at, next_attempt_at, lease_expires_at, id: _id, request, output, ...rest } = patch;
    const date = (value: number | null | undefined) => value === undefined ? undefined : value === null ? null : new Date(value);
    const result = await prisma.analysisJob.updateMany({ where: { id, ...(leaseToken ? { status: 'RUNNING', lease_token: leaseToken } : {}) }, data: {
      ...rest, updated_at: updated_at === undefined ? undefined : new Date(updated_at),
      next_attempt_at: date(next_attempt_at), lease_expires_at: date(lease_expires_at),
      request: request === undefined ? undefined : request === null ? Prisma.DbNull : request as Prisma.InputJsonObject,
      output: output === undefined ? undefined : output === null ? Prisma.DbNull : output as Prisma.InputJsonObject,
    } });
    return result.count === 1;
  }
}

export class AiServiceJobClient implements JobHttpClient {
  constructor(private readonly baseUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000') {}

  async submit(job: JobRecord): Promise<{ remote_id: string }> {
    const asset = job.asset_ref ? await resolveOwnedAsset(job.asset_ref, job.owner_id, job.consent_scope) : null;
    try {
      const { data } = await axios.post(`${this.baseUrl}/v1/analysis/jobs`, { ...(job.request ?? {}), job_id: job.id, asset_ref: job.asset_ref, consent_scope: job.consent_scope,
        ...(asset ? { asset: { bucket: storageConfig().Bucket, key: asset.storage_key, version_id: asset.version_id, sha256: asset.hash, content_type: asset.content_type, byte_size: asset.byte_size } } : {}) },
        { timeout: 10000, headers: { 'X-Service-Token': process.env.APEXFORMZ_SERVICE_TOKEN ?? '' } });
      return { remote_id: data.job_id ?? job.id };
    } catch (e) {
      if (axios.isAxiosError(e) && e.response && e.response.status >= 400 && e.response.status < 500 && ![408, 429].includes(e.response.status)) throw new Error(`submit rejected: HTTP ${e.response.status}`);
      throw new TransientError(`submit failed: ${(e as Error).message}`);
    }
  }

  async poll(remoteId: string): ReturnType<JobHttpClient['poll']> {
    try {
      const { data } = await axios.get(`${this.baseUrl}/v1/analysis/jobs/${remoteId}`, { timeout: 10000, headers: { 'X-Service-Token': process.env.APEXFORMZ_SERVICE_TOKEN ?? '' } });
      const status = String(data.status ?? 'RUNNING').toUpperCase();
      if (status === 'COMPLETED') return { status: 'COMPLETED', output_ref: data.output_ref,
        ...(data.output && typeof data.output === 'object' && !Array.isArray(data.output) ? { output: data.output } : {}) };
      if (status === 'FAILED' && data.error?.retryable === true) throw new RemoteJobMissingError('remote transient failure; retrying durable request');
      if (status === 'FAILED') return { status: 'FAILED', error: typeof data.error === 'string' ? data.error
        : [data.error?.code, data.error?.message].filter(Boolean).join(': ') || 'remote failure' };
      return { status: 'RUNNING' };
    } catch (e) {
      if (e instanceof RemoteJobMissingError) throw e;
      if (axios.isAxiosError(e) && e.response?.status === 404) throw new RemoteJobMissingError('remote job no longer exists; resubmitting durable request');
      throw new TransientError(`poll failed: ${(e as Error).message}`);
    }
  }
}

export function startJobDispatcher(): JobDispatcher | null {
  if (process.env.ENABLE_JOB_DISPATCHER === 'false') return null;
  const d = new JobDispatcher(new PrismaJobStore(), new AiServiceJobClient(), undefined, undefined, undefined, (level, msg) => logger[level](msg));
  d.start(Number(process.env.JOB_DISPATCHER_INTERVAL_MS || 2000));
  logger.info('🧠 Analysis job dispatcher started');
  return d;
}
