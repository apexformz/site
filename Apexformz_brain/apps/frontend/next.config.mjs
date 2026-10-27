import { fileURLToPath } from 'node:url';
import { preparePackTrust } from './scripts/prepare-pack-trust.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  // Brain packages and the legacy types shim ship TypeScript source from the workspace.
  transpilePackages: [
    '@apexformz/contracts',
    '@apexformz/signal',
    '@apexformz/features',
    '@apexformz/perception',
    '@apexformz/sport-runtime',
    '@apexformz/analysis',
    '@apexformz/scoring',
    '@apexformz/coaching',
    '@apexformz/runtime',
    '@apexformz/brain-client',
    '@smartcoach/types',
  ],
  webpack: (config, { isServer, webpack }) => {
    // Node-only helpers must never be bundled into the browser build.
    config.resolve.fallback = { ...(config.resolve.fallback ?? {}), fs: false, path: false, 'node:fs': false, 'node:path': false };
    // onnxruntime-web is used only inside the Brain worker. Its ESM distribution self-references with
    // `new URL(..., import.meta.url)`, which webpack turns into a static asset that Terser rejects, so the
    // browser bundle aliases the package to a shim that loads the installed WebGPU+WASM bundle from
    // this app's /runtime assets. The prepare:runtime script keeps versions aligned. The server never needs it.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'onnxruntime-web': isServer ? false : fileURLToPath(new URL('./src/lib/brain/ort-shim.mjs', import.meta.url)),
    };
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

export default async function configureNext(phase) {
  await preparePackTrust(phase);
  return nextConfig;
}
