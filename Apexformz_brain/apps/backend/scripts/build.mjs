import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const app = fileURLToPath(new URL('../', import.meta.url));
// Bundle workspace TypeScript and JSON schemas. Prisma's native engine remains external.
await build({
  absWorkingDir: app,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'external',
  external: ['@prisma/client'],
  tsconfig: path.join(app, 'tsconfig.json'),
  logLevel: 'info',
});
