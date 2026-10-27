import { validateMovementModelConfig } from '@apexformz/analysis';
import type { MovementModelLoadOptions } from './movement_model_loader';

/** Index document: [{ deployment_url, model_url }], with URLs relative to the index. */
export async function fetchMovementModelIndex(indexUrl: string, sportId: string, options: {
  allow_provisional: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  ort_wasm_base_url?: string;
}): Promise<MovementModelLoadOptions[]> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(indexUrl, { signal: options.signal, cache: 'no-store' });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`movement model index unavailable (${response.status})`);
  const index: unknown = await response.json();
  if (!Array.isArray(index) || index.length > 2) throw new Error('movement model index must be an array with at most two models');
  const base = new URL(indexUrl);
  const url = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('movement model index has a missing artifact URL');
    const resolved = new URL(value, base);
    if (!['http:', 'https:'].includes(resolved.protocol)) throw new Error('movement model artifact URL must use HTTP(S)');
    return resolved.href;
  };
  const models = await Promise.all(index.map(async (entry: unknown): Promise<MovementModelLoadOptions> => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid movement model index entry');
    const item = entry as { deployment_url?: unknown; model_url?: unknown };
    const deploymentUrl = url(item.deployment_url);
    const modelUrl = url(item.model_url);
    const deployment = await fetcher(deploymentUrl, { signal: options.signal, cache: 'no-store' });
    if (!deployment.ok) throw new Error(`movement model metadata unavailable (${deployment.status})`);
    const config = validateMovementModelConfig(await deployment.json());
    if (config.sport_id !== sportId) throw new Error(`movement model sport does not match ${sportId}`);
    return { config, model_url: modelUrl, allow_provisional: options.allow_provisional, execution_providers: ['wasm'], ort_wasm_base_url: options.ort_wasm_base_url };
  }));
  const tasks = models.map(({ config }) => config.model_task ?? (config.input.window_frames === 1 ? 'static_pose' : 'dynamic_movement'));
  if (new Set(tasks).size !== tasks.length) throw new Error('movement model index contains duplicate model tasks');
  return models;
}
