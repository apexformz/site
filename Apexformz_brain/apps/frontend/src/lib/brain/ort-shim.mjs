/**
 * onnxruntime-web shim for the browser bundle.
 *
 * `@apexformz/brain-client` does `const ort = await import('onnxruntime-web')` inside the Brain
 * worker, then sets `ort.env.wasm.wasmPaths`, calls `ort.InferenceSession.create(...)` and later
 * `new ort.Tensor(...)`. Bundling the ORT ESM distribution with webpack breaks (its self-referencing
 * `new URL(..., import.meta.url)` makes webpack emit it as a static asset that Terser rejects), so
 * next.config.mjs aliases the package to this module, which lazily loads the WebGPU+WASM bundle
 * copied from node_modules into this app's versioned /runtime directory by prepare:runtime.
 *
 * No top-level await: the real module is fetched on the first `InferenceSession.create` call and
 * `env` settings are forwarded at session creation. The generated asset metadata keeps the JS
 * and WASM versions identical to the installed package without any CDN request.
 */
import runtimeAssets from './runtime-assets.generated.json';

let real = null;
let loading = null;

/** Settings applied before the real module exists are replayed onto it at load time. */
export const env = { wasm: { wasmPaths: runtimeAssets.onnxruntime.wasm_base_url }, webgpu: {}, logLevel: undefined, debug: undefined };

function applyEnvironment(m) {
  Object.assign(m.env.wasm, env.wasm);
  Object.assign(m.env.webgpu, env.webgpu);
  if (env.logLevel !== undefined) m.env.logLevel = env.logLevel;
  if (env.debug !== undefined) m.env.debug = env.debug;
  return m;
}

function load() {
  if (real) return Promise.resolve(applyEnvironment(real));
  if (!loading) {
    loading = import(/* webpackIgnore: true */ runtimeAssets.onnxruntime.module_url).then((m) => {
      real = m;
      return applyEnvironment(m);
    }).catch((error) => { loading = null; throw error; });
  }
  return loading;
}

export const InferenceSession = {
  create: async (...args) => (await load()).InferenceSession.create(...args),
};

export class Tensor {
  constructor(...args) {
    if (!real) throw new Error('onnxruntime-web is not loaded yet; create an InferenceSession first');
    return new real.Tensor(...args);
  }
}

export default { env, InferenceSession, Tensor };
