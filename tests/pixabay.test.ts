import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthenticationError, ConfigurationError, InvalidResponseError, TimeoutError, runFfmpeg } from '@shorts/core';
import { PixabayAssetProvider, selectVideoRendition } from '@shorts/providers';
import { rankCandidate, validateMediaFile } from '@shorts/agents';
import type { AssetCandidate } from '@shorts/schemas';
import { jsonResponse } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pixabay-test-'));
const noSleep = async () => {};

function provider(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, extra: Partial<ConstructorParameters<typeof PixabayAssetProvider>[1]> = {}) {
  return new PixabayAssetProvider(
    'test-key-123',
    { timeoutMs: 200, downloadTimeoutMs: 2000, maxAttempts: 3, maxDownloadBytes: 50_000_000, cacheDir: tmp(), ...extra },
    { fetchImpl, sleep: noSleep }
  );
}

const rendition = (w: number, h: number, size = 1_000_000) => ({ url: `https://cdn.pixabay.com/video/x_${w}x${h}.mp4`, width: w, height: h, size, thumbnail: 'https://cdn.pixabay.com/thumb.jpg' });
const videoHit = (id: number, tags: string, videos: Record<string, unknown>, duration = 12) => ({ id, pageURL: `https://pixabay.com/videos/id-${id}/`, tags, duration, user: 'someone', videos });

describe('PixabayAssetProvider', () => {
  it('requires an API key (configuration error, never a mock)', () => {
    expect(() => new PixabayAssetProvider('', { timeoutMs: 1, downloadTimeoutMs: 1, maxAttempts: 1, maxDownloadBytes: 1, cacheDir: tmp() })).toThrow(ConfigurationError);
  });

  it('normalizes video hits and picks the smallest rendition that reaches 1080 on the short side', async () => {
    let requested = '';
    const p = provider(async (url) => {
      requested = url;
      return jsonResponse({
        total: 2,
        totalHits: 2,
        hits: [
          videoHit(1, 'bridge, river, city', { large: rendition(3840, 2160, 70e6), medium: rendition(2560, 1440, 30e6), small: rendition(1920, 1080, 9e6), tiny: rendition(960, 540, 2e6) }),
          videoHit(2, 'crowd, walking', { large: { url: '', width: 0, height: 0, size: 0 }, medium: rendition(1080, 1920, 8e6) }),
        ],
      });
    });
    const res = await p.search({ query: 'bridge river', mediaType: 'VIDEO' });
    expect(new URL(requested).searchParams.get('q')).toBe('bridge river');
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ provider: 'pixabay', providerMediaId: '1', mediaType: 'VIDEO', width: 1920, height: 1080, durationSeconds: 12, fileSizeBytes: 9e6, tags: ['bridge', 'river', 'city'] });
    expect(res[0].aspectRatio).toBeCloseTo(16 / 9);
    expect(res[1]).toMatchObject({ width: 1080, height: 1920 });
    expect(res[0].license).toMatch(/Pixabay/);
  });

  it('selectVideoRendition falls back to the largest usable rendition', () => {
    expect(selectVideoRendition({ tiny: rendition(960, 540), small: rendition(1280, 720) }, 1080)?.width).toBe(1280);
    expect(selectVideoRendition({ large: { url: '', width: 0, height: 0 } }, 1080)).toBeNull();
  });

  it('returns an empty array for no results', async () => {
    const res = await provider(async () => jsonResponse({ total: 0, totalHits: 0, hits: [] })).search({ query: 'nothing', mediaType: 'VIDEO' });
    expect(res).toEqual([]);
  });

  it('skips individual malformed hits but rejects a malformed response', async () => {
    const res = await provider(async () => jsonResponse({ hits: [{ id: 'bad' }, videoHit(3, 'sea', { small: rendition(1920, 1080) })] })).search({ query: 'sea', mediaType: 'VIDEO' });
    expect(res.map((r) => r.providerMediaId)).toEqual(['3']);
    await expect(provider(async () => jsonResponse({ unexpected: true })).search({ query: 'sea', mediaType: 'VIDEO' })).rejects.toBeInstanceOf(InvalidResponseError);
    await expect(provider(async () => new Response('<html>oops</html>', { status: 200 })).search({ query: 'sea', mediaType: 'VIDEO' })).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('maps Pixabay invalid-key responses (HTTP 400) to AuthenticationError without retrying', async () => {
    let calls = 0;
    const p = provider(async () => (calls++, new Response('[ERROR 400] Invalid or missing API key (https://pixabay.com/api/docs/).', { status: 400 })));
    await expect(p.search({ query: 'x', mediaType: 'VIDEO' })).rejects.toBeInstanceOf(AuthenticationError);
    expect(calls).toBe(1);
  });

  it('retries transient failures then succeeds', async () => {
    let calls = 0;
    const p = provider(async () => (++calls < 3 ? jsonResponse({}, 502) : jsonResponse({ hits: [videoHit(4, 'sky', { small: rendition(1920, 1080) })] })));
    expect(await p.search({ query: 'sky', mediaType: 'VIDEO' })).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it('times out a hung provider', async () => {
    const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
    await expect(provider(hang, { maxAttempts: 1 }).search({ query: 'x', mediaType: 'VIDEO' })).rejects.toBeInstanceOf(TimeoutError);
  });

  it('caches search responses (24h policy) and never writes the API key to the cache', async () => {
    let calls = 0;
    const cacheDir = tmp();
    const p = provider(async () => (calls++, jsonResponse({ hits: [videoHit(5, 'forest', { small: rendition(1920, 1080) })] })), { cacheDir });
    await p.search({ query: 'forest', mediaType: 'VIDEO' });
    await p.search({ query: 'forest', mediaType: 'VIDEO' });
    expect(calls).toBe(1);
    const cached = fs.readdirSync(cacheDir).map((f) => fs.readFileSync(path.join(cacheDir, f), 'utf-8')).join();
    expect(cached).not.toContain('test-key-123');
  });

  it('normalizes vertical image hits with largeImageURL dimensions', async () => {
    const p = provider(async (url) => {
      expect(new URL(url).searchParams.get('orientation')).toBe('vertical');
      return jsonResponse({ hits: [{ id: 9, pageURL: 'https://pixabay.com/photos/id-9/', tags: 'bridge', largeImageURL: 'https://pixabay.com/get/x.jpg', imageWidth: 3000, imageHeight: 4500 }] });
    });
    const [img] = await p.search({ query: 'bridge', mediaType: 'IMAGE' });
    expect(img).toMatchObject({ mediaType: 'IMAGE', width: 853, height: 1280 });
  });

  it('downloads to disk, rejects wrong content types, and rejects truncated bodies', async () => {
    const dir = tmp();
    const cand = { provider: 'pixabay', providerMediaId: '1', mediaType: 'VIDEO', downloadUrl: 'https://cdn.pixabay.com/v.mp4' } as AssetCandidate;
    const ok = await provider(async () => new Response(Buffer.alloc(2048, 1), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '2048' } })).download(cand, path.join(dir, 'a.mp4'));
    expect(ok.bytes).toBe(2048);
    expect(fs.statSync(path.join(dir, 'a.mp4')).size).toBe(2048);
    await expect(provider(async () => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } })).download(cand, path.join(dir, 'b.mp4'))).rejects.toThrow(/content-type/);
    expect(fs.existsSync(path.join(dir, 'b.mp4'))).toBe(false);
    await expect(
      provider(async () => new Response(Buffer.alloc(100), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '5000' } }), { maxAttempts: 1 }).download(cand, path.join(dir, 'c.mp4'))
    ).rejects.toThrow(/truncated/);
    expect(fs.existsSync(path.join(dir, 'c.mp4'))).toBe(false);
  });
});

describe('media ranking & validation', () => {
  const base = (over: Partial<AssetCandidate>): AssetCandidate => ({
    provider: 'pixabay', providerMediaId: Math.random().toString(), mediaType: 'VIDEO', pageUrl: 'https://pixabay.com/x', downloadUrl: 'https://cdn.pixabay.com/x.mp4',
    width: 1080, height: 1920, aspectRatio: 0.5625, durationSeconds: 10, tags: ['bridge', 'river'], description: '', license: 'Pixabay Content License',
    commercialUseAllowed: true, attributionRequired: false, ...over,
  });
  const ctx = { keywords: ['suspension bridge', 'river'], sceneDurationSeconds: 6, usedMediaKeys: new Set<string>(), minRelevance: 0.3, maxBytes: 1e8 };

  it('prefers vertical footage over equally relevant landscape footage', () => {
    const portrait = rankCandidate(base({}), ctx);
    const landscape = rankCandidate(base({ width: 1920, height: 1080, aspectRatio: 16 / 9 }), ctx);
    expect(portrait.ok && landscape.ok).toBe(true);
    if (portrait.ok && landscape.ok) expect(portrait.ranking.score).toBeGreaterThan(landscape.ranking.score);
  });

  it('rejects irrelevant, low-resolution, oversized and duplicate candidates', () => {
    expect(rankCandidate(base({ tags: ['cat', 'kitten'] }), ctx).ok).toBe(false);
    expect(rankCandidate(base({ width: 540, height: 960 }), ctx).ok).toBe(false);
    expect(rankCandidate(base({ fileSizeBytes: 2e8 }), ctx).ok).toBe(false);
    const c = base({ providerMediaId: 'dup' });
    expect(rankCandidate(c, { ...ctx, usedMediaKeys: new Set(['pixabay:dup']) }).ok).toBe(false);
  });

  it('validates real files with ffprobe and rejects corrupt or black-faded media', async () => {
    const dir = tmp();
    const good = path.join(dir, 'good.mp4');
    const black = path.join(dir, 'black.mp4');
    const corrupt = path.join(dir, 'corrupt.mp4');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', good]);
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:size=1080x1920:rate=30:duration=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', black]);
    fs.writeFileSync(corrupt, fs.readFileSync(good).subarray(0, 2000));
    const exp = base({});
    expect((await validateMediaFile(good, exp)).ok).toBe(true);
    expect((await validateMediaFile(black, exp)).problems.join()).toMatch(/black segment/);
    expect((await validateMediaFile(corrupt, exp)).ok).toBe(false);
    expect((await validateMediaFile(good, base({ width: 1920, height: 1080 }))).problems.join()).toMatch(/aspect ratio/);
  });
});
