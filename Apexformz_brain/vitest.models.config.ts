import { defineConfig } from 'vitest/config';
import { alias } from './vitest.config';

/** Explicit release-artifact suite: missing models are failures, never skips. */
export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['tests/models/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
