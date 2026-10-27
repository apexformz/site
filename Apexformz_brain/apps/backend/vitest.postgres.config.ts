import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alias } from '../../vitest.config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export default defineConfig({
  root,
  resolve: { alias: { ...alias, '@smartcoach/types': path.join(root, 'packages/legacy-types/index.ts') } },
  test: { name: 'postgres-integration', environment: 'node',
    include: ['apps/backend/tests/postgres.integration.ts'], fileParallelism: false,
    testTimeout: 30000, hookTimeout: 30000 },
});
