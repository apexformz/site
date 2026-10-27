import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

export const alias = {
  '@apexformz/contracts': path.join(root, 'packages/contracts/src/index.ts'),
  '@apexformz/signal': path.join(root, 'packages/signal/src/index.ts'),
  '@apexformz/features': path.join(root, 'packages/features/src/index.ts'),
  '@apexformz/perception': path.join(root, 'packages/perception/src/index.ts'),
  '@apexformz/sport-runtime/node': path.join(root, 'packages/sport-runtime/src/node.ts'),
  '@apexformz/sport-runtime': path.join(root, 'packages/sport-runtime/src/index.ts'),
  '@apexformz/analysis': path.join(root, 'packages/analysis/src/index.ts'),
  '@apexformz/scoring': path.join(root, 'packages/scoring/src/index.ts'),
  '@apexformz/coaching': path.join(root, 'packages/coaching/src/index.ts'),
  '@apexformz/runtime': path.join(root, 'packages/runtime/src/index.ts'),
  '@apexformz/brain-client': path.join(root, 'packages/brain-client/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          globals: true,
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'golden',
          globals: true,
          include: ['tests/golden/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'contracts',
          globals: true,
          include: ['tests/contracts/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'backend',
          globals: true,
          include: ['apps/backend/src/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'frontend',
          globals: true,
          // pure frontend logic only (no DOM); components are covered by the build and typecheck
          include: ['apps/frontend/src/lib/**/*.test.ts'],
        },
      },
    ],
  },
});
