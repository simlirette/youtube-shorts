import { describe, expect, it } from 'vitest';
import { AuthenticationError, InvalidResponseError, ProviderUnavailableError, RateLimitError, TimeoutError, httpJson, redactString } from '@shorts/core';
import { jsonResponse } from './helpers.js';

const noSleep = async () => {};
const policy = (fetchImpl: any, extra: Record<string, unknown> = {}) => ({
  provider: 'test',
  operation: 'op',
  timeoutMs: 200,
  maxAttempts: 3,
  fetchImpl,
  sleep: noSleep,
  ...extra,
});

describe('http policy', () => {
  it('returns parsed JSON on success', async () => {
    const res = await httpJson('https://x.invalid', {}, policy(async () => jsonResponse({ ok: 1 })));
    expect(res.data).toEqual({ ok: 1 });
    expect(res.attempts).toBe(1);
  });

  it('retries transient 5xx and succeeds', async () => {
    let n = 0;
    const res = await httpJson('https://x.invalid', {}, policy(async () => (++n < 3 ? jsonResponse({}, 503) : jsonResponse({ ok: true }))));
    expect(res.attempts).toBe(3);
  });

  it('does not retry authentication failures', async () => {
    let n = 0;
    await expect(httpJson('https://x.invalid', {}, policy(async () => (n++, jsonResponse({ e: 1 }, 401))))).rejects.toBeInstanceOf(AuthenticationError);
    expect(n).toBe(1);
  });

  it('does not retry other 4xx and classifies them as invalid responses', async () => {
    let n = 0;
    await expect(httpJson('https://x.invalid', {}, policy(async () => (n++, jsonResponse({}, 404))))).rejects.toBeInstanceOf(InvalidResponseError);
    expect(n).toBe(1);
  });

  it('honours bounded attempts for persistent 429 and surfaces RateLimitError', async () => {
    let n = 0;
    await expect(httpJson('https://x.invalid', {}, policy(async () => (n++, jsonResponse({}, 429, { 'retry-after': '0' }))))).rejects.toBeInstanceOf(RateLimitError);
    expect(n).toBe(3);
  });

  it('fails immediately when Retry-After exceeds the in-process wait budget', async () => {
    let n = 0;
    await expect(httpJson('https://x.invalid', {}, policy(async () => (n++, jsonResponse({}, 429, { 'retry-after': '3600' })), { maxRetryAfterMs: 1000 }))).rejects.toBeInstanceOf(RateLimitError);
    expect(n).toBe(1);
  });

  it('times out a hung request (timeout covers the whole attempt)', async () => {
    const hang = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    await expect(httpJson('https://x.invalid', {}, policy(hang, { maxAttempts: 1 }))).rejects.toBeInstanceOf(TimeoutError);
  });

  it('classifies network errors as provider unavailable', async () => {
    await expect(httpJson('https://x.invalid', {}, policy(async () => { throw new TypeError('fetch failed'); }, { maxAttempts: 1 }))).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('rejects empty and non-JSON bodies', async () => {
    await expect(httpJson('https://x.invalid', {}, policy(async () => new Response('', { status: 200 })))).rejects.toBeInstanceOf(InvalidResponseError);
    await expect(httpJson('https://x.invalid', {}, policy(async () => new Response('<html>', { status: 200 })))).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('redacts credentials from strings', () => {
    const s = redactString('GET https://pixabay.com/api/?key=abc123secret&q=x Bearer sk-abcdefghijklmnopqrstuvwxyz tvly-abcdefghijk');
    expect(s).not.toContain('abc123secret');
    expect(s).not.toContain('sk-abcdefghijklmnop');
    expect(s).not.toContain('tvly-abcdefghijk');
  });
});
