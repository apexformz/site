/**
 * Dedicated movement-inference worker entry. The app's brain worker spawns it, for example:
 *   setInferenceWorkerFactory(() => new Worker(new URL('./movement_inference.worker.ts', import.meta.url), { type: 'module' }))
 */
import { hostInference, type PortLike } from './inference_host';
import { openAnyOrtSession, openOrtSession } from './movement_model_loader';

hostInference(self as unknown as PortLike, (bytes, options) => (options.expect === 'any' ? openAnyOrtSession : openOrtSession)(bytes, options));
