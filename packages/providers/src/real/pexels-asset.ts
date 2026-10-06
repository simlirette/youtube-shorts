import { z } from 'zod';
import type { AssetCandidate } from '@shorts/schemas';
import { ConfigurationError, InvalidResponseError, httpDownload, httpJson } from '@shorts/core';
import type { AssetDownloadResult, AssetProvider, AssetSearchRequest, ProviderContext } from '../interfaces.js';

const PEXELS_LICENSE = 'Pexels License';

const VideoSchema = z.object({
  id: z.number(),
  url: z.string().url(),
  duration: z.number(),
  user: z.object({ name: z.string() }).partial().optional(),
  video_files: z.array(z.object({ link: z.string(), width: z.number().nullable(), height: z.number().nullable(), file_type: z.string().optional() })),
});
const PhotoSchema = z.object({
  id: z.number(),
  url: z.string().url(),
  alt: z.string().optional(),
  photographer: z.string().optional(),
  width: z.number(),
  height: z.number(),
  src: z.object({ original: z.string().url(), large2x: z.string().url().optional(), portrait: z.string().url().optional(), tiny: z.string().optional() }),
});

/** Pexels provider conforming to the normalized AssetProvider contract (not the default). */
export class PexelsAssetProvider implements AssetProvider {
  readonly name = 'pexels';

  constructor(
    private readonly apiKey: string,
    private readonly opts: { timeoutMs: number; downloadTimeoutMs: number; maxAttempts: number; maxDownloadBytes: number },
    private readonly ctx: ProviderContext = {}
  ) {
    if (!apiKey) throw new ConfigurationError('PEXELS_API_KEY is required for the Pexels provider');
  }

  async search(req: AssetSearchRequest): Promise<AssetCandidate[]> {
    const q = encodeURIComponent(req.query.trim().slice(0, 100));
    if (!q) return [];
    const perPage = Math.min(80, req.perPage ?? 30);
    const url =
      req.mediaType === 'VIDEO'
        ? `https://api.pexels.com/videos/search?query=${q}&orientation=portrait&per_page=${perPage}`
        : `https://api.pexels.com/v1/search?query=${q}&orientation=portrait&per_page=${perPage}`;
    const res = await httpJson<Record<string, unknown>>(url, { headers: { Authorization: this.apiKey } }, {
      provider: this.name,
      operation: `search:${req.mediaType.toLowerCase()}`,
      timeoutMs: this.opts.timeoutMs,
      maxAttempts: this.opts.maxAttempts,
      fetchImpl: this.ctx.fetchImpl,
      sleep: this.ctx.sleep,
    });
    const list = req.mediaType === 'VIDEO' ? res.data.videos : res.data.photos;
    if (!Array.isArray(list)) throw new InvalidResponseError(this.name, 'malformed search response');
    const out: AssetCandidate[] = [];
    for (const item of list) {
      if (req.mediaType === 'VIDEO') {
        const v = VideoSchema.safeParse(item);
        if (!v.success) continue;
        const files = v.data.video_files.filter((f) => f.link && f.width && f.height && (f.file_type ?? 'video/mp4') === 'video/mp4');
        const best = files.filter((f) => Math.min(f.width!, f.height!) >= 1080).sort((a, b) => a.width! * a.height! - b.width! * b.height!)[0]
          ?? files.sort((a, b) => b.width! * b.height! - a.width! * a.height!)[0];
        if (!best) continue;
        out.push({
          provider: this.name, providerMediaId: String(v.data.id), mediaType: 'VIDEO', pageUrl: v.data.url, downloadUrl: best.link,
          width: best.width!, height: best.height!, aspectRatio: best.width! / best.height!, durationSeconds: v.data.duration || undefined,
          tags: v.data.url.split('/').filter(Boolean).pop()?.split('-').slice(0, -1) ?? [], description: '', author: v.data.user?.name,
          license: PEXELS_LICENSE, commercialUseAllowed: true, attributionRequired: false,
        });
      } else {
        const p = PhotoSchema.safeParse(item);
        if (!p.success) continue;
        const src = p.data.src.large2x ?? p.data.src.original;
        out.push({
          provider: this.name, providerMediaId: String(p.data.id), mediaType: 'IMAGE', pageUrl: p.data.url, downloadUrl: src,
          width: p.data.width, height: p.data.height, aspectRatio: p.data.width / p.data.height,
          tags: (p.data.alt ?? '').toLowerCase().split(/\W+/).filter((t) => t.length > 2), description: p.data.alt ?? '', author: p.data.photographer,
          license: PEXELS_LICENSE, commercialUseAllowed: true, attributionRequired: false,
        });
      }
    }
    return out;
  }

  async download(candidate: AssetCandidate, destPath: string): Promise<AssetDownloadResult> {
    const res = await httpDownload(candidate.downloadUrl, destPath, {
      provider: this.name,
      operation: 'download',
      timeoutMs: this.opts.downloadTimeoutMs,
      maxAttempts: this.opts.maxAttempts,
      maxBytes: this.opts.maxDownloadBytes,
      allowedContentTypes: candidate.mediaType === 'VIDEO' ? ['video/', 'application/octet-stream'] : ['image/'],
      fetchImpl: this.ctx.fetchImpl,
      sleep: this.ctx.sleep,
    });
    return res.data;
  }
}
