import type { ErrorCode } from './enums';

/**
 * Structured, recoverable error used across the Brain. Unknown model IDs and
 * incompatible contract versions are rejected closed by throwing this with
 * `recoverable = false`.
 */
export class BrainError extends Error {
  readonly code: ErrorCode;
  readonly recoverable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: { recoverable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
    this.recoverable = options.recoverable ?? true;
    this.details = options.details;
  }

  toJSON() {
    return { code: this.code, message: this.message, recoverable: this.recoverable, details: this.details ?? null };
  }
}

export function isBrainError(e: unknown): e is BrainError {
  return e instanceof BrainError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'BrainError');
}
