/**
 * Module worker entry bundled by Next/webpack. Everything happens in
 * @apexformz/brain-client/worker (pose detection + BrainRuntime).
 *
 * Movement-model inference gets its own worker so the skeleton stays smooth on slower devices; if the
 * browser cannot start it, inference runs inline as before.
 */
import { setInferenceWorkerFactory } from '@apexformz/brain-client/worker';

setInferenceWorkerFactory(() => new Worker(new URL('./movement_inference.worker.ts', import.meta.url), { type: 'module' }));
