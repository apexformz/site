/**
 * Dedicated movement-model inference worker (spawned by brain.worker.ts), so pose tracking never waits
 * for the movement model. Everything happens in @apexformz/brain-client/inference-worker.
 */
import '@apexformz/brain-client/inference-worker';
