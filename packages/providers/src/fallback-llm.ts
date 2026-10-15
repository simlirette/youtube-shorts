import { PipelineError, RateLimitError, logger } from '@shorts/core';
import type { LLMProvider, LLMResponse, StructuredRequest } from './interfaces.js';

/** Failures that say "this service is busy or out of allowance right now", not "the request is wrong". */
const FALL_BACK_ON = new Set(['RATE_LIMIT', 'QUOTA_EXCEEDED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT']);

export function shouldFallBack(err: unknown): boolean {
  return err instanceof PipelineError && FALL_BACK_ON.has(err.kind);
}

export interface FallbackOptions {
  /** How long to skip the primary after it was busy, when it gives no reset time (default 10 min). */
  cooldownMs?: number;
  now?: () => number;
}

/**
 * Sends each request to the primary provider and, when it is rate-limited, out of quota,
 * overloaded or timing out, to the fallback instead. After such a failure the primary is skipped
 * until its reset time (or a cooldown) so a job does not wait on it call after call. Every other
 * error (invalid output, validation, authentication) is raised as is: the fallback never hides a
 * broken request or configuration.
 */
export class FallbackLLMProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private skipPrimaryUntil = 0;

  constructor(
    private readonly primary: LLMProvider,
    private readonly fallback: LLMProvider,
    private readonly opts: FallbackOptions = {}
  ) {
    this.name = `${primary.name}>${fallback.name}`;
    this.model = primary.model;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<LLMResponse<T>> {
    const now = this.opts.now ?? Date.now;
    if (now() >= this.skipPrimaryUntil) {
      try {
        return await this.primary.generateStructured(req);
      } catch (err) {
        if (!shouldFallBack(err)) throw err;
        const wait = err instanceof RateLimitError && err.retryAfterMs ? err.retryAfterMs : (this.opts.cooldownMs ?? 600_000);
        this.skipPrimaryUntil = now() + wait;
        logger.warn(`${this.primary.name} unavailable (${(err as PipelineError).kind}); using ${this.fallback.name} for the next ${Math.round(wait / 60_000)} min`, {
          provider: this.primary.name,
          operation: req.task,
          error: (err as Error).message.slice(0, 300),
        });
      }
    }
    // The request's model (if any) names a primary model; the fallback uses its own.
    return this.fallback.generateStructured({ ...req, model: undefined });
  }
}
