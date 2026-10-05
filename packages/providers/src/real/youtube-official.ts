import fs from 'node:fs';
import { AnalyticsRecord } from '@shorts/schemas';
import { YouTubeProvider, YouTubeUploadParams } from '../interfaces.js';

export class YouTubeOfficialProvider implements YouTubeProvider {
  name = 'YouTubeOfficialProvider';
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;

  constructor() {
    this.clientId = process.env.YOUTUBE_CLIENT_ID || '';
    this.clientSecret = process.env.YOUTUBE_CLIENT_SECRET || '';
    this.refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || '';
  }

  private ensureConfigured(): void {
    const missing: string[] = [];
    if (!this.clientId) missing.push('YOUTUBE_CLIENT_ID');
    if (!this.clientSecret) missing.push('YOUTUBE_CLIENT_SECRET');
    if (!this.refreshToken) missing.push('YOUTUBE_REFRESH_TOKEN');

    if (missing.length > 0) {
      throw new Error(`YouTube API request failed: missing [${missing.join(', ')}] in environment or .env`);
    }
  }

  async verifyAuthentication(): Promise<boolean> {
    try {
      this.ensureConfigured();
      return true;
    } catch {
      return false;
    }
  }

  async uploadVideo(params: YouTubeUploadParams): Promise<{ youtubeVideoId: string; watchUrl: string }> {
    this.ensureConfigured();
    if (!fs.existsSync(params.videoPath)) {
      throw new Error(`Video file not found at: ${params.videoPath}`);
    }

    // Refresh access token via Google OAuth2
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`YouTube OAuth token refresh failed (${tokenRes.status}): ${err}`);
    }

    const { access_token } = await tokenRes.json();

    // Multipart upload to YouTube Data API v3
    const metadata = {
      snippet: {
        title: params.title,
        description: params.description,
        tags: params.tags,
        categoryId: '27', // Education
      },
      status: {
        privacyStatus: params.privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    };

    const videoBuffer = fs.readFileSync(params.videoPath);
    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const body = Buffer.concat([
      Buffer.from(
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: video/mp4\r\n\r\n'
      ),
      videoBuffer,
      Buffer.from(closeDelimiter),
    ]);

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`YouTube upload failed (${uploadRes.status}): ${err}`);
    }

    const result = await uploadRes.json();
    return {
      youtubeVideoId: result.id,
      watchUrl: `https://www.youtube.com/shorts/${result.id}`,
    };
  }

  async getVideoAnalytics(youtubeVideoId: string): Promise<Partial<AnalyticsRecord>> {
    this.ensureConfigured();
    // Stub for live YouTube Analytics API
    return {
      youtubeVideoId,
      views: 0,
      likes: 0,
      comments: 0,
    };
  }
}
