import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AssetCandidate } from '@shorts/schemas';
import {
  AuthenticationError,
  ConfigurationError,
  InvalidResponseError,
  httpDownload,
  httpJson,
  logger,
  sha256Text,
} from '@shorts/core';
import type { AssetDownloadResult, AssetProvider, AssetSearchRequest, ProviderContext } from '../interfaces.js';

const PIXABAY_LICENSE = 'Pixabay Content License';

const RenditionSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
  size: z.number().optional(),
  thumbnail: z.string().optional(),
});

const VideoHitSchema = z.object({
  id: z.number(),
  pageURL: z.string().url(),
  tags: z.string(),
  duration: z.number(),
  user: z.string().optional(),
  videos: z.record(RenditionSchema),
});

const ImageHitSchema = z.object({
  id: z.number(),
  pageURL: z.string().url(),
  tags: z.string(),
  previewURL: z.string().optional(),
  webformatURL: z.string().optional(),
  largeImageURL: z.string().url(),
  imageWidth: z.number().positive(),
  imageHeight: z.number().positive(),
  user: z.string().optional(),
});

const ResponseSchema = z.object({
  total: z.number().optional(),
  totalHits: z.number().optional(),
  hits: z.array(z.unknown()),
});

export interface PixabayOptions {
  timeoutMs: number;
  downloadTimeoutMs: number;
  maxAttempts: number;
  maxDownloadBytes: number;
  /** Directory for 24h search-response caching (Pixabay API terms require caching). */
  cacheDir: string;
  cacheTtlMs?: number;
  /** Short side a rendition should reach before we prefer it over larger files. */
  targetShortSide?: number;
  /** Client-side cap on API searches per rolling minute (Pixabay allows 100 per 60 s). Default 90. */
  requestsPerMinute?: number;
}

/**
 * Rolling-minute request window shared by every Pixabay provider in the process (the limit is per
 * API key). Per-beat footage preflight issues bursts of searches; waiting is cheaper than a 429.
 */
const searchWindow: number[] = [];
export async function pixabayThrottle(limit: number, now: () => number = Date.now, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<number> {
  let waited = 0;
  for (;;) {
    const t = now();
    while (searchWindow.length && t - searchWindow[0] >= 60_000) searchWindow.shift();
    if (searchWindow.length < limit) {
      searchWindow.push(t);
      return waited;
    }
    const ms = 60_000 - (t - searchWindow[0]) + 50;
    waited += ms;
    await sleep(ms);
  }
}
/** Test hook: clears the shared window. */
export function resetPixabayThrottle(): void {
  searchWindow.length = 0;
}

function splitTags(tags: string): string[] {
  return tags
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** Choose the smallest rendition whose short side reaches the target; otherwise the largest available. */
export function selectVideoRendition(
  videos: Record<string, z.infer<typeof RenditionSchema>>,
  targetShortSide: number
): { name: string; url: string; width: number; height: number; size?: number; thumbnail?: string } | null {
  const usable = Object.entries(videos)
    .filter(([, r]) => r.url && r.width > 0 && r.height > 0)
    .map(([name, r]) => ({ name, ...r }));
  if (usable.length === 0) return null;
  const pixels = (r: { width: number; height: number }) => r.width * r.height;
  const sufficient = usable.filter((r) => Math.min(r.width, r.height) >= targetShortSide).sort((a, b) => pixels(a) - pixels(b));
  if (sufficient.length > 0) return sufficient[0];
  return usable.sort((a, b) => pixels(b) - pixels(a))[0];
}

/**
 * Pixabay stock video/image provider.
 * Docs: https://pixabay.com/api/docs/ — the API key is a query parameter, so URLs containing it are
 * never logged (http layer logs origin+path only) and never cached on disk.
 */
export class PixabayAssetProvider implements AssetProvider {
  readonly name = 'pixabay';

  constructor(
    private readonly apiKey: string,
    private readonly opts: PixabayOptions,
    private readonly ctx: ProviderContext = {}
  ) {
    if (!apiKey) throw new ConfigurationError('PIXABAY_API_KEY is required for the Pixabay provider');
  }

  /** Pixabay reports a bad key as HTTP 400 with a text body. */
  private classify = (status: number, body: string) => {
    if ((status === 400 || status === 401 || status === 403) && /api key/i.test(body)) {
      return new AuthenticationError(this.name, `HTTP ${status}: invalid or missing API key`);
    }
    return undefined;
  };

  async search(req: AssetSearchRequest): Promise<AssetCandidate[]> {
    const query = req.query.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!query) return [];
    const perPage = Math.min(200, Math.max(3, req.perPage ?? 30));
    const endpoint = req.mediaType === 'VIDEO' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/';
    const params: Record<string, string> =
      req.mediaType === 'VIDEO'
        ? { q: query, video_type: 'film', safesearch: 'true', per_page: String(perPage) }
        : { q: query, image_type: 'photo', orientation: 'vertical', safesearch: 'true', per_page: String(perPage), min_width: '640' };

    const cacheKey = sha256Text(`${endpoint}?${new URLSearchParams(params).toString()}`);
    const cached = this.readCache(cacheKey);
    if (cached) return cached;

    const url = `${endpoint}?${new URLSearchParams({ key: this.apiKey, ...params }).toString()}`;
    const waited = await pixabayThrottle(this.opts.requestsPerMinute ?? 90);
    if (waited > 0) logger.info(`pixabay: waited ${Math.round(waited / 1000)} s for the per-minute search limit`);
    const started = Date.now();
    let raw: unknown;
    let attempts = 1;
    try {
      const res = await httpJson<unknown>(url, {}, {
        provider: this.name,
        operation: `search:${req.mediaType.toLowerCase()}`,
        timeoutMs: this.opts.timeoutMs,
        maxAttempts: this.opts.maxAttempts,
        classify: this.classify,
        fetchImpl: this.ctx.fetchImpl,
        sleep: this.ctx.sleep,
      });
      raw = res.data;
      attempts = res.attempts;
    } catch (err) {
      this.ctx.observer?.({ provider: this.name, operation: 'search', status: 'ERROR', attempts, durationMs: Date.now() - started, costUsd: 0, error: (err as Error).message });
      throw err;
    }

    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.ctx.observer?.({ provider: this.name, operation: 'search', status: 'ERROR', attempts, durationMs: Date.now() - started, costUsd: 0, error: 'malformed response' });
      throw new InvalidResponseError(this.name, `malformed search response: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }

    const candidates: AssetCandidate[] = [];
    let skipped = 0;
    for (const hit of parsed.data.hits) {
      const c = req.mediaType === 'VIDEO' ? this.normalizeVideo(hit) : this.normalizeImage(hit);
      if (c) candidates.push(c);
      else skipped++;
    }
    if (skipped > 0) logger.debug(`Pixabay: skipped ${skipped} hit(s) with unusable metadata`, { provider: this.name, query });
    this.ctx.observer?.({ provider: this.name, operation: 'search', status: 'OK', attempts, durationMs: Date.now() - started, costUsd: 0, units: { results: candidates.length } });
    this.writeCache(cacheKey, candidates);
    return candidates;
  }

  normalizeVideo(hit: unknown): AssetCandidate | null {
    const h = VideoHitSchema.safeParse(hit);
    if (!h.success || h.data.duration <= 0) return null;
    const r = selectVideoRendition(h.data.videos, this.opts.targetShortSide ?? 1080);
    if (!r) return null;
    try {
      new URL(r.url);
    } catch {
      return null;
    }
    const thumb = r.thumbnail && /^https?:\/\//.test(r.thumbnail) ? r.thumbnail : undefined;
    return {
      provider: this.name,
      providerMediaId: String(h.data.id),
      mediaType: 'VIDEO',
      pageUrl: h.data.pageURL,
      previewUrl: thumb,
      downloadUrl: r.url,
      width: r.width,
      height: r.height,
      aspectRatio: r.width / r.height,
      durationSeconds: h.data.duration,
      fileSizeBytes: r.size && r.size > 0 ? r.size : undefined,
      tags: splitTags(h.data.tags),
      description: h.data.tags,
      author: h.data.user,
      license: PIXABAY_LICENSE,
      commercialUseAllowed: true,
      attributionRequired: false,
    };
  }

  normalizeImage(hit: unknown): AssetCandidate | null {
    const h = ImageHitSchema.safeParse(hit);
    if (!h.success) return null;
    // largeImageURL is scaled to at most 1280px on its longest side.
    const scale = Math.min(1, 1280 / Math.max(h.data.imageWidth, h.data.imageHeight));
    const width = Math.round(h.data.imageWidth * scale);
    const height = Math.round(h.data.imageHeight * scale);
    return {
      provider: this.name,
      providerMediaId: String(h.data.id),
      mediaType: 'IMAGE',
      pageUrl: h.data.pageURL,
      previewUrl: h.data.previewURL && /^https?:\/\//.test(h.data.previewURL) ? h.data.previewURL : undefined,
      downloadUrl: h.data.largeImageURL,
      width,
      height,
      aspectRatio: width / height,
      tags: splitTags(h.data.tags),
      description: h.data.tags,
      author: h.data.user,
      license: PIXABAY_LICENSE,
      commercialUseAllowed: true,
      attributionRequired: false,
    };
  }

  async download(candidate: AssetCandidate, destPath: string): Promise<AssetDownloadResult> {
    if (candidate.provider !== this.name) throw new InvalidResponseError(this.name, `cannot download ${candidate.provider} asset`);
    const started = Date.now();
    try {
      const res = await httpDownload(candidate.downloadUrl, destPath, {
        provider: this.name,
        operation: `download:${candidate.mediaType.toLowerCase()}`,
        timeoutMs: this.opts.downloadTimeoutMs,
        maxAttempts: this.opts.maxAttempts,
        maxBytes: this.opts.maxDownloadBytes,
        allowedContentTypes: candidate.mediaType === 'VIDEO' ? ['video/', 'application/octet-stream'] : ['image/'],
        fetchImpl: this.ctx.fetchImpl,
        sleep: this.ctx.sleep,
      });
      this.ctx.observer?.({ provider: this.name, operation: 'download', status: 'OK', attempts: res.attempts, durationMs: Date.now() - started, costUsd: 0, units: { bytes: res.data.bytes } });
      return res.data;
    } catch (err) {
      this.ctx.observer?.({ provider: this.name, operation: 'download', status: 'ERROR', attempts: 1, durationMs: Date.now() - started, costUsd: 0, error: (err as Error).message });
      throw err;
    }
  }

  private cachePath(key: string): string {
    return path.join(this.opts.cacheDir, `pixabay_${key}.json`);
  }

  private readCache(key: string): AssetCandidate[] | null {
    const p = this.cachePath(key);
    if (!fs.existsSync(p)) return null;
    try {
      const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as { fetchedAt: number; candidates: AssetCandidate[] };
      if (Date.now() - doc.fetchedAt > (this.opts.cacheTtlMs ?? 24 * 3600 * 1000)) return null;
      return Array.isArray(doc.candidates) ? doc.candidates : null;
    } catch {
      return null;
    }
  }

  private writeCache(key: string, candidates: AssetCandidate[]): void {
    fs.mkdirSync(this.opts.cacheDir, { recursive: true });
    fs.writeFileSync(this.cachePath(key), JSON.stringify({ fetchedAt: Date.now(), candidates }));
  }
}
