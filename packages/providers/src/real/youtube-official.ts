import fs from 'node:fs';
import { YouTubeMetadataSchema } from '@shorts/schemas';
import { ConfigurationError, PipelineError, PublishError, httpJson } from '@shorts/core';
import type { ProviderContext, PublishRequest, PublishResult, Publisher } from '../interfaces.js';

/**
 * YouTube Data API v3 publisher (resumable upload protocol).
 *
 * Credentials come only from configuration (client id/secret + refresh token); the short-lived access
 * token is kept in memory for one upload and never persisted or logged.
 *
 * Failure semantics (see PublishError):
 * - metadata invalid, token refresh failed, session not created → uploadStarted=false (safe to retry)
 * - anything after the media PUT begins → uploadStarted=true (never retried automatically)
 *
 * NOT VERIFIED against a real channel in this repository (no OAuth credentials were available).
 */
export class YouTubePublisher implements Publisher {
  readonly name = 'youtube';
  readonly target = 'youtube' as const;

  constructor(
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    private readonly opts: { timeoutMs: number; uploadTimeoutMs: number; maxAttempts: number },
    private readonly ctx: ProviderContext = {}
  ) {
    const missing = Object.entries({ YOUTUBE_CLIENT_ID: creds.clientId, YOUTUBE_CLIENT_SECRET: creds.clientSecret, YOUTUBE_REFRESH_TOKEN: creds.refreshToken })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) throw new ConfigurationError(`YouTube publishing requires ${missing.join(', ')}`);
  }

  private async accessToken(): Promise<string> {
    const res = await httpJson<{ access_token?: string }>(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          refresh_token: this.creds.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      },
      { provider: this.name, operation: 'oauth.refresh', timeoutMs: this.opts.timeoutMs, maxAttempts: this.opts.maxAttempts, fetchImpl: this.ctx.fetchImpl, sleep: this.ctx.sleep }
    );
    if (!res.data.access_token) throw new PublishError(this.name, 'token refresh returned no access_token', false);
    return res.data.access_token;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const meta = YouTubeMetadataSchema.safeParse(req.metadata);
    if (!meta.success) throw new PublishError(this.name, `invalid metadata: ${meta.error.issues.map((i) => i.message).join(', ')}`, false);
    if (!fs.existsSync(req.videoPath)) throw new PublishError(this.name, `video not found: ${req.videoPath}`, false);
    const metadata = meta.data;
    const stat = fs.statSync(req.videoPath);
    const fetchImpl = this.ctx.fetchImpl ?? fetch;

    let token: string;
    try {
      token = await this.accessToken();
    } catch (err) {
      throw err instanceof PublishError ? err : new PublishError(this.name, `OAuth token refresh failed: ${(err as Error).message}`, false, err);
    }

    // 1. Start a resumable session (metadata only). No bytes of the video are sent yet.
    let sessionUrl: string;
    try {
      const init = await fetchImpl('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4',
          'X-Upload-Content-Length': String(stat.size),
        },
        body: JSON.stringify({
          snippet: {
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags,
            categoryId: metadata.categoryId,
            defaultLanguage: metadata.defaultLanguage,
            defaultAudioLanguage: metadata.defaultLanguage,
          },
          status: {
            // publishAt requires a private upload; YouTube flips it public at that time (audited projects only).
            privacyStatus: metadata.publishAt ? 'private' : metadata.privacyStatus,
            ...(metadata.publishAt ? { publishAt: metadata.publishAt } : {}),
            selfDeclaredMadeForKids: false,
            containsSyntheticMedia: metadata.containsSyntheticMedia,
          },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!init.ok) throw new PublishError(this.name, `upload session init failed (HTTP ${init.status}): ${(await init.text()).slice(0, 300)}`, false);
      const loc = init.headers.get('location');
      if (!loc) throw new PublishError(this.name, 'upload session returned no Location header', false);
      sessionUrl = loc;
    } catch (err) {
      throw err instanceof PipelineError ? err : new PublishError(this.name, `upload session init failed: ${(err as Error).message}`, false, err);
    }

    // 2. Upload the file. From here on the outcome is uncertain on failure: never retried automatically.
    try {
      const body = fs.createReadStream(req.videoPath) as unknown as BodyInit;
      const up = await fetchImpl(sessionUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size) },
        body,
        // @ts-expect-error Node's fetch requires duplex for streamed bodies
        duplex: 'half',
        signal: AbortSignal.timeout(this.opts.uploadTimeoutMs),
      });
      if (!up.ok) throw new PublishError(this.name, `upload failed (HTTP ${up.status}): ${(await up.text()).slice(0, 300)}`, true);
      const result = (await up.json()) as { id?: string };
      if (!result.id) throw new PublishError(this.name, 'upload response contained no video id', true);
      return { externalId: result.id, url: `https://www.youtube.com/shorts/${result.id}` };
    } catch (err) {
      throw err instanceof PublishError ? err : new PublishError(this.name, `upload interrupted: ${(err as Error).message}`, true, err);
    }
  }
}
