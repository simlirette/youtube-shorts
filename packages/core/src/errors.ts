import type { JobErrorKind } from '@shorts/schemas';

/**
 * Base class for every failure the pipeline knows how to classify.
 * `retryable` tells retry loops and job resume whether repeating the same operation can succeed.
 */
export class PipelineError extends Error {
  readonly kind: JobErrorKind;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: JobErrorKind,
    message: string,
    opts: { retryable?: boolean; provider?: string; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.kind = kind;
    this.retryable = opts.retryable ?? false;
    this.provider = opts.provider;
    this.details = opts.details;
  }
}

export class ConfigurationError extends PipelineError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFIGURATION', message, { retryable: false, details });
  }
}

export class AuthenticationError extends PipelineError {
  constructor(provider: string, message: string) {
    super('AUTHENTICATION', `${provider}: ${message}`, { retryable: false, provider });
  }
}

export class RateLimitError extends PipelineError {
  readonly retryAfterMs?: number;
  constructor(provider: string, message: string, retryAfterMs?: number) {
    super('RATE_LIMIT', `${provider}: ${message}`, { retryable: true, provider });
    this.retryAfterMs = retryAfterMs;
  }
}

export class TimeoutError extends PipelineError {
  constructor(provider: string, message: string) {
    super('TIMEOUT', `${provider}: ${message}`, { retryable: true, provider });
  }
}

export class ProviderUnavailableError extends PipelineError {
  constructor(provider: string, message: string, cause?: unknown) {
    super('PROVIDER_UNAVAILABLE', `${provider}: ${message}`, { retryable: true, provider, cause });
  }
}

/** Provider answered, but the answer cannot be used (bad status, malformed body, wrong shape). */
export class InvalidResponseError extends PipelineError {
  constructor(provider: string, message: string, opts: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super('INVALID_RESPONSE', `${provider}: ${message}`, { retryable: opts.retryable ?? false, provider, details: opts.details });
  }
}

/** Generated or downloaded data violates a contract. */
export class ValidationError extends PipelineError {
  readonly violations: string[];
  constructor(message: string, violations: string[] = [], details?: Record<string, unknown>) {
    super('VALIDATION', violations.length ? `${message}: ${violations.join('; ')}` : message, { retryable: false, details });
    this.violations = violations;
  }
}

export class QAFailedError extends PipelineError {
  readonly blockingReasons: string[];
  constructor(message: string, blockingReasons: string[]) {
    super('QA_FAILED', `${message}: ${blockingReasons.join('; ')}`, { retryable: false });
    this.blockingReasons = blockingReasons;
  }
}

/** Process/FFmpeg failures and invariant violations inside our own code. */
export class InternalError extends PipelineError {
  constructor(message: string, cause?: unknown, details?: Record<string, unknown>) {
    super('INTERNAL', message, { retryable: false, cause, details });
  }
}

export function toPipelineError(err: unknown): PipelineError {
  if (err instanceof PipelineError) return err;
  if (err instanceof Error) return new InternalError(err.message, err);
  return new InternalError(String(err));
}
