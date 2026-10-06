import fs from 'node:fs';
import path from 'node:path';
import { YouTubeMetadataSchema } from '@shorts/schemas';
import { InternalError, safeJoin, sanitizeSegment, sha256File } from '@shorts/core';
import type { PublishRequest, PublishResult, Publisher } from '../interfaces.js';

/**
 * "Publishes" by exporting the approved MP4 plus its upload metadata to a per-job directory.
 * This is the default target: no external side effects.
 */
export class LocalExportPublisher implements Publisher {
  readonly name: string;

  /** `target` is 'mock' only for mock-mode bundles so mock exports are never confused with real ones. */
  constructor(
    private readonly exportRoot: string,
    readonly target: 'local_export' | 'mock' = 'local_export'
  ) {
    this.name = target === 'mock' ? 'mock_export' : 'local_export';
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const metadata = YouTubeMetadataSchema.parse(req.metadata);
    if (!fs.existsSync(req.videoPath)) throw new InternalError(`Video to export not found: ${req.videoPath}`);
    const dir = safeJoin(this.exportRoot, sanitizeSegment(req.jobId));
    fs.mkdirSync(dir, { recursive: true });
    const videoOut = path.join(dir, 'short.mp4');
    const tmp = `${videoOut}.part`;
    fs.copyFileSync(req.videoPath, tmp);
    fs.renameSync(tmp, videoOut);
    const sha = await sha256File(videoOut);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ ...metadata, sha256: sha, exportedAt: new Date().toISOString() }, null, 2));
    return { externalId: sha, url: `file://${videoOut.replace(/\\/g, '/')}` };
  }
}
