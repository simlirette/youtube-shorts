import { InvalidResponseError, PipelineError, httpJson, type FetchLike } from '@shorts/core';
import { accessTokenFor, type OAuthClient } from './youtube-auth.js';

export interface OwnerVideoMetrics {
  videoId: string;
  views: number;
  engagedViews?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  subscribersGained?: number;
  averageViewDurationSeconds?: number;
  averageViewPercentage?: number;
  source: 'analytics_api' | 'data_api';
}

const FULL = ['views', 'engagedViews', 'likes', 'comments', 'shares', 'subscribersGained', 'averageViewDuration', 'averageViewPercentage'];
const BASIC = ['views', 'likes', 'comments', 'shares', 'subscribersGained', 'averageViewDuration', 'averageViewPercentage'];

/**
 * Owner metrics for the authorized channel (needs the yt-analytics.readonly and youtube.readonly
 * scopes granted by `shorts youtube auth`). Access tokens live only in memory.
 */
export class YouTubeAnalyticsClient {
  private token: string | null = null;

  constructor(
    private readonly client: OAuthClient,
    private readonly refreshToken: string,
    private readonly fetchImpl?: FetchLike
  ) {}

  private async auth(): Promise<string> {
    this.token ??= await accessTokenFor(this.client, this.refreshToken, this.fetchImpl);
    return this.token;
  }

  /** The authorized channel (1 Data API unit). */
  async channel(): Promise<{ id: string; title: string; subscribers: number | null }> {
    const res = await httpJson<{ items?: Array<{ id: string; snippet?: { title?: string }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }> }>(
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
      { method: 'GET', headers: { Authorization: `Bearer ${await this.auth()}` } },
      { provider: 'youtube-data', operation: 'channels.list', timeoutMs: 30_000, maxAttempts: 2, fetchImpl: this.fetchImpl }
    );
    const c = res.data.items?.[0];
    if (!c) throw new InvalidResponseError('youtube-data', 'the authorized account has no YouTube channel');
    return { id: c.id, title: c.snippet?.title ?? '', subscribers: c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount ?? 0) };
  }

  private async report(ids: string[], startDate: string, endDate: string, metrics: string[]) {
    const p = new URLSearchParams({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: metrics.join(','),
      dimensions: 'video',
      filters: `video==${ids.join(',')}`,
      maxResults: String(Math.min(200, ids.length)),
      sort: '-views',
    });
    return httpJson<{ columnHeaders?: Array<{ name: string }>; rows?: Array<Array<string | number>> }>(
      `https://youtubeanalytics.googleapis.com/v2/reports?${p.toString()}`,
      { method: 'GET', headers: { Authorization: `Bearer ${await this.auth()}` } },
      { provider: 'youtube-analytics', operation: 'reports.query', timeoutMs: 30_000, maxAttempts: 2, fetchImpl: this.fetchImpl }
    );
  }

  /**
   * Per-video owner metrics from the Analytics API. Falls back to the metric set without
   * engagedViews if the API rejects it, and to Data API counters if Analytics is unavailable.
   */
  async videoMetrics(ids: string[], startDate: string, endDate: string): Promise<OwnerVideoMetrics[]> {
    if (ids.length === 0) return [];
    for (const metrics of [FULL, BASIC]) {
      try {
        const res = await this.report(ids, startDate, endDate, metrics);
        const headers = (res.data.columnHeaders ?? []).map((h) => h.name);
        const col = (row: Array<string | number>, name: string) => {
          const i = headers.indexOf(name);
          return i === -1 ? undefined : Number(row[i]);
        };
        const rows = res.data.rows ?? [];
        const found = rows.map((row) => ({
          videoId: String(row[headers.indexOf('video')]),
          views: col(row, 'views') ?? 0,
          engagedViews: col(row, 'engagedViews'),
          likes: col(row, 'likes'),
          comments: col(row, 'comments'),
          shares: col(row, 'shares'),
          subscribersGained: col(row, 'subscribersGained'),
          averageViewDurationSeconds: col(row, 'averageViewDuration'),
          averageViewPercentage: col(row, 'averageViewPercentage'),
          source: 'analytics_api' as const,
        }));
        // Videos with no views in the window have no row; report them as zero, not missing.
        const seen = new Set(found.map((f) => f.videoId));
        return [...found, ...ids.filter((id) => !seen.has(id)).map((id) => ({ videoId: id, views: 0, source: 'analytics_api' as const }))];
      } catch (e) {
        if (!(e instanceof PipelineError) || e.kind !== 'INVALID_RESPONSE') throw e;
        if (metrics === BASIC) return this.dataApiCounters(ids);
      }
    }
    return this.dataApiCounters(ids);
  }

  /** Public counters via the Data API (1 unit per 50 videos). */
  async dataApiCounters(ids: string[]): Promise<OwnerVideoMetrics[]> {
    const out: OwnerVideoMetrics[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const res = await httpJson<{ items?: Array<{ id: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> }>(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${chunk.join(',')}`,
        { method: 'GET', headers: { Authorization: `Bearer ${await this.auth()}` } },
        { provider: 'youtube-data', operation: 'videos.list', timeoutMs: 30_000, maxAttempts: 2, fetchImpl: this.fetchImpl }
      );
      for (const v of res.data.items ?? []) {
        out.push({
          videoId: v.id,
          views: Number(v.statistics?.viewCount ?? 0),
          likes: v.statistics?.likeCount !== undefined ? Number(v.statistics.likeCount) : undefined,
          comments: v.statistics?.commentCount !== undefined ? Number(v.statistics.commentCount) : undefined,
          source: 'data_api',
        });
      }
    }
    return out;
  }
}
