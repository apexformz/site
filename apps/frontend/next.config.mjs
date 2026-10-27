import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brainRoot } from '../../scripts/brain-paths.mjs';
import { preparePackTrust } from './scripts/prepare-pack-trust.mjs';

const frontend = fileURLToPath(new URL('./', import.meta.url));
process.env.SPORT_PACKS_DIR ??= path.join(brainRoot, 'sport-packs');

export default async function configureNext(phase) {
  await preparePackTrust(phase);
  return {
    output: 'standalone',
    env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || '/api' },
    outputFileTracingRoot: path.resolve(brainRoot, '..'),
    async rewrites() {
      const backend = (process.env.APEXFORMZ_API_ORIGIN || 'http://127.0.0.1:4000').replace(/\/$/, '');
      return ['auth', 'users', 'sessions', 'gamification', 'leaderboard', 'circles', 'v1'].map(route => ({
        source: `/api/${route}/:path*`, destination: `${backend}/api/${route}/:path*`,
      }));
    },
    transpilePackages: ['contracts', 'signal', 'features', 'perception', 'sport-runtime', 'analysis', 'scoring', 'coaching', 'runtime', 'brain-client'].map(name => `@apexformz/${name}`).concat('@smartcoach/types'),
    webpack(config, { isServer, webpack }) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, 'node:fs': false, 'node:path': false };
      config.resolve.alias = { ...config.resolve.alias, 'onnxruntime-web': isServer ? false : path.join(frontend, 'src/lib/brain/ort-shim.mjs') };
      // Next dev compiles the studio lazily. Include the worker URL base in the
      // initial runtime, even when the first page does not import a worker.
      if (!isServer) config.plugins.push({
        apply(compiler) {
          compiler.hooks.compilation.tap('BrainWorkerBaseURI', compilation => {
            compilation.hooks.additionalTreeRuntimeRequirements.tap('BrainWorkerBaseURI', (_chunk, requirements) => {
              requirements.add(webpack.RuntimeGlobals.baseURI);
            });
          });
        },
      });
      return config;
    },
  };
}
