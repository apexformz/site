import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { AiServiceJobClient } from './prismaJobs';
import { RemoteJobMissingError } from './jobs';

afterEach(() => vi.restoreAllMocks());
it('resubmits durable input after a transient remote storage failure', async () => {
  vi.spyOn(axios, 'get').mockResolvedValue({ data: { status: 'FAILED', error: { retryable: true, code: 'INTERNAL' } } });
  await expect(new AiServiceJobClient().poll('job')).rejects.toBeInstanceOf(RemoteJobMissingError);
});
it('keeps a terminal validation failure terminal', async () => {
  vi.spyOn(axios, 'get').mockResolvedValue({ data: { status: 'FAILED', error: { retryable: false, code: 'ASSET_INTEGRITY', message: 'checksum mismatch' } } });
  await expect(new AiServiceJobClient().poll('job')).resolves.toMatchObject({ status: 'FAILED', error: 'ASSET_INTEGRITY: checksum mismatch' });
});
