import fs from 'node:fs';
import { YouTubeMetadataSchema } from '@shorts/schemas';
import { ConfigurationError, InvalidResponseError, httpJson } from '@shorts/core';
import type { ProviderContext, PublishRequest, PublishResult, Publisher } from '../interfaces.js';

/**
 * YouTube Data API v3 publisher (resumable upload protocol).
 * Not exercised against a real channel in this repository's acceptance runs (no OAuth credentials).
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
    if (!res.data.access_token) throw new InvalidResponseError(this.name, 'token refresh returned no access_token');
    return res.data.access_token;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const metadata = YouTubeMetadataSchema.parse(req.metadata);
    const stat = fs.statSync(req.videoPath);
    const token = await this.accessToken();
    const fetchImpl = this.ctx.fetchImpl ?? fetch;

    // 1. Start a resumable session (metadata only).
    const init = await fetchImpl('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(stat.size),
      },
      body: JSON.stringify({
        snippet: { title: metadata.title, description: metadata.description, tags: metadata.tags, categoryId: '27' },
        status: { privacyStatus: metadata.privacyStatus, selfDeclaredMadeForKids: false },
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!init.ok) throw new InvalidResponseError(this.name, `upload session init failed (HTTP ${init.status}): ${(await init.text()).slice(0, 300)}`);
    const sessionUrl = init.headers.get('location');
    if (!sessionUrl) throw new InvalidResponseError(this.name, 'upload session returned no Location header');

    // 2. Upload the file in one streamed request. No automatic retry: a duplicate upload is worse than a failure.
    const body = fs.createReadStream(req.videoPath) as unknown as BodyInit;
    const up = await fetchImpl(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(stat.size) },
      body,
      // @ts-expect-error Node's fetch requires duplex for streamed bodies
      duplex: 'half',
      signal: AbortSignal.timeout(this.opts.uploadTimeoutMs),
    });
    if (!up.ok) throw new InvalidResponseError(this.name, `upload failed (HTTP ${up.status}): ${(await up.text()).slice(0, 300)}`);
    const result = (await up.json()) as { id?: string };
    if (!result.id) throw new InvalidResponseError(this.name, 'upload response contained no video id');
    return { externalId: result.id, url: `https://www.youtube.com/shorts/${result.id}` };
  }
}
