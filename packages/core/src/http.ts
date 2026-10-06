import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  AuthenticationError,
  InvalidResponseError,
  PipelineError,
  ProviderUnavailableError,
  RateLimitError,
  TimeoutError,
} from './errors.js';
import { logger, redactString } from './logger.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpPolicy {
  provider: string;
  operation: string;
  /** Applies to the whole attempt, including reading the body. */
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Longest Retry-After we are willing to wait in-process; longer ones fail as RateLimitError. */
  maxRetryAfterMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Provider-specific classification of a non-2xx response. Return undefined to use the default rules.
   */
  classify?: (status: number, bodyText: string) => PipelineError | undefined;
  /** Called after each attempt (success or failure) for observability. */
  onAttempt?: (info: { attempt: number; status?: number; error?: PipelineError; durationMs: number }) => void;
}

export interface HttpResult<T> {
  data: T;
  status: number;
  headers: Headers;
  attempts: number;
  durationMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** URL safe for logs: origin + path only (query strings frequently carry keys). */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function classifyHttpStatus(provider: string, status: number, bodyText: string, retryAfterMs?: number): PipelineError {
  const snippet = redactString(bodyText.replace(/\s+/g, ' ').slice(0, 300));
  if (status === 401 || status === 403) return new AuthenticationError(provider, `HTTP ${status}: ${snippet}`);
  if (status === 429) return new RateLimitError(provider, `HTTP 429: ${snippet}`, retryAfterMs);
  if (status === 408 || status === 425 || status >= 500) {
    return new ProviderUnavailableError(provider, `HTTP ${status}: ${snippet}`);
  }
  return new InvalidResponseError(provider, `HTTP ${status}: ${snippet}`, { details: { status } });
}

function classifyThrown(provider: string, err: unknown, timeoutMs: number): PipelineError {
  if (err instanceof PipelineError) return err;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new TimeoutError(provider, `no complete response within ${timeoutMs} ms`);
  }
  const code = e?.cause?.code ? ` (${e.cause.code})` : '';
  return new ProviderUnavailableError(provider, `network error: ${redactString(e?.message ?? String(err))}${code}`, err);
}

function backoffDelay(policy: HttpPolicy, attempt: number, err: PipelineError): number {
  const base = policy.baseDelayMs ?? 750;
  const max = policy.maxDelayMs ?? 15_000;
  if (err instanceof RateLimitError && err.retryAfterMs !== undefined) return err.retryAfterMs;
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

/**
 * Executes an HTTP request with a hard per-attempt timeout (headers + body), bounded retries for
 * transient failures only, Retry-After support, and typed error classification.
 */
export async function httpRequest<T>(
  url: string,
  init: RequestInit,
  policy: HttpPolicy,
  readBody: (res: Response) => Promise<T>
): Promise<HttpResult<T>> {
  const fetchImpl = policy.fetchImpl ?? (globalThis.fetch as FetchLike);
  const sleep = policy.sleep ?? defaultSleep;
  const started = Date.now();
  let lastError: PipelineError | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const attemptStart = Date.now();
    const signal = AbortSignal.timeout(policy.timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        throw policy.classify?.(res.status, body) ?? classifyHttpStatus(policy.provider, res.status, body, retryAfter);
      }
      const data = await readBody(res);
      policy.onAttempt?.({ attempt, status: res.status, durationMs: Date.now() - attemptStart });
      return { data, status: res.status, headers: res.headers, attempts: attempt, durationMs: Date.now() - started };
    } catch (raw) {
      const err = classifyThrown(policy.provider, raw, policy.timeoutMs);
      lastError = err;
      policy.onAttempt?.({ attempt, error: err, durationMs: Date.now() - attemptStart });
      const canRetry = err.retryable && attempt < policy.maxAttempts;
      const delay = canRetry ? backoffDelay(policy, attempt, err) : 0;
      if (canRetry && err instanceof RateLimitError && delay > (policy.maxRetryAfterMs ?? 60_000)) {
        throw err;
      }
      logger.warn(`${policy.provider} ${policy.operation} attempt ${attempt}/${policy.maxAttempts} failed: ${err.message}`, {
        provider: policy.provider,
        operation: policy.operation,
        url: safeUrl(url),
        errorKind: err.kind,
        willRetry: canRetry,
        retryInMs: canRetry ? delay : undefined,
      });
      if (!canRetry) throw err;
      await sleep(delay);
    }
  }
  throw lastError ?? new ProviderUnavailableError(policy.provider, 'request failed');
}

export async function httpJson<T = unknown>(url: string, init: RequestInit, policy: HttpPolicy): Promise<HttpResult<T>> {
  return httpRequest<T>(url, init, policy, async (res) => {
    const text = await res.text();
    if (!text.trim()) throw new InvalidResponseError(policy.provider, `${policy.operation}: empty response body`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new InvalidResponseError(policy.provider, `${policy.operation}: response is not valid JSON (${text.slice(0, 80)}…)`);
    }
  });
}

/**
 * Streams a download to `destPath` via a temp file, enforcing a byte cap and an allowed content-type
 * prefix list. The final file only appears once the body completed. Returns size and sha256.
 */
export async function httpDownload(
  url: string,
  destPath: string,
  policy: HttpPolicy & { maxBytes: number; allowedContentTypes?: string[] }
): Promise<HttpResult<{ path: string; bytes: number; sha256: string; contentType: string }>> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part-${process.pid}-${Date.now()}`;
  try {
    return await httpRequest(url, {}, policy, async (res) => {
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (policy.allowedContentTypes && !policy.allowedContentTypes.some((t) => contentType.startsWith(t))) {
        throw new InvalidResponseError(policy.provider, `${policy.operation}: unexpected content-type "${contentType}"`);
      }
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > policy.maxBytes) {
        throw new InvalidResponseError(policy.provider, `${policy.operation}: file too large (${declared} bytes > ${policy.maxBytes})`);
      }
      if (!res.body) throw new InvalidResponseError(policy.provider, `${policy.operation}: response has no body`);
      const hash = createHash('sha256');
      const out = fs.createWriteStream(tmp);
      let bytes = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += chunk.byteLength;
          if (bytes > policy.maxBytes) {
            throw new InvalidResponseError(policy.provider, `${policy.operation}: download exceeded ${policy.maxBytes} bytes`);
          }
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      if (bytes === 0) throw new InvalidResponseError(policy.provider, `${policy.operation}: downloaded 0 bytes`);
      if (declared > 0 && declared !== bytes) {
        throw new ProviderUnavailableError(policy.provider, `${policy.operation}: truncated download (${bytes}/${declared} bytes)`);
      }
      fs.renameSync(tmp, destPath);
      return { path: destPath, bytes, sha256: hash.digest('hex'), contentType };
    });
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}
