import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { AssetCandidate } from '@shorts/schemas';
import { runFfmpeg, sha256File } from '@shorts/core';
import type { AssetDownloadResult, AssetProvider, AssetSearchRequest } from '../interfaces.js';

const SHAPES: Array<{ w: number; h: number; d: number }> = [
  { w: 1080, h: 1920, d: 8 },
  { w: 1920, h: 1080, d: 10 },
  { w: 720, h: 1280, d: 6 },
  { w: 1080, h: 1920, d: 12 },
  { w: 1280, h: 720, d: 5 },
  { w: 1080, h: 1920, d: 9 },
];

/**
 * Mock stock provider. Produces real media files: videos carry a loud stereo audio track on
 * purpose (stock footage often does) so the renderer's narration mapping is exercised.
 */
export class MockAssetProvider implements AssetProvider {
  readonly name = 'mock-stock';

  constructor(private readonly opts: { corruptDownloads?: boolean; empty?: boolean } = {}) {}

  async search(req: AssetSearchRequest): Promise<AssetCandidate[]> {
    if (this.opts.empty || !req.query.trim()) return [];
    const tokens = req.query.toLowerCase().split(/\s+/).filter(Boolean);
    const seed = createHash('md5').update(req.query).digest();
    return SHAPES.map((s, i) => {
      const id = `${seed.readUInt16BE(0)}${i}`;
      const isImage = req.mediaType === 'IMAGE';
      const w = isImage ? 720 : s.w;
      const h = isImage ? 1280 : s.h;
      return {
        provider: this.name,
        providerMediaId: id,
        mediaType: req.mediaType,
        pageUrl: `https://mock.invalid/media/${id}`,
        downloadUrl: `https://mock.invalid/media/${id}.${isImage ? 'png' : 'mp4'}?w=${w}&h=${h}&d=${s.d}`,
        width: w,
        height: h,
        aspectRatio: w / h,
        durationSeconds: isImage ? undefined : s.d,
        tags: i % 3 === 2 ? ['abstract', 'texture'] : [...tokens, 'stock'],
        description: tokens.join(' '),
        license: 'Mock Synthetic License',
        commercialUseAllowed: true,
        attributionRequired: false,
      } satisfies AssetCandidate;
    });
  }

  async download(candidate: AssetCandidate, destPath: string): Promise<AssetDownloadResult> {
    if (this.opts.corruptDownloads) {
      fs.writeFileSync(destPath, Buffer.from('this is not a media file'.repeat(100)));
    } else if (candidate.mediaType === 'VIDEO') {
      const d = candidate.durationSeconds ?? 6;
      await runFfmpeg(
        [
          '-y',
          '-f', 'lavfi', '-i', `testsrc2=size=${candidate.width}x${candidate.height}:rate=30:duration=${d}`,
          '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${d}`,
          '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', destPath,
        ],
        { description: 'mock stock video' }
      );
    } else {
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=size=${candidate.width}x${candidate.height}:rate=1`, '-frames:v', '1', destPath], {
        description: 'mock stock image',
      });
    }
    const bytes = fs.statSync(destPath).size;
    return { path: destPath, bytes, sha256: await sha256File(destPath), contentType: candidate.mediaType === 'VIDEO' ? 'video/mp4' : 'image/png' };
  }
}
