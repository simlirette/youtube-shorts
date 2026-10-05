import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AnalyticsRecord } from '@shorts/schemas';
import { YouTubeProvider, YouTubeUploadParams } from '../interfaces.js';

export class MockYouTubeProvider implements YouTubeProvider {
  name = 'MockYouTubeProvider';

  async verifyAuthentication(): Promise<boolean> {
    return true;
  }

  async uploadVideo(params: YouTubeUploadParams): Promise<{ youtubeVideoId: string; watchUrl: string }> {
    if (!fs.existsSync(params.videoPath)) {
      throw new Error(`Cannot upload video: File does not exist at ${params.videoPath}`);
    }

    const mockId = `yt_mock_${randomUUID().replace(/-/g, '').slice(0, 11)}`;
    return {
      youtubeVideoId: mockId,
      watchUrl: `https://www.youtube.com/shorts/${mockId}`,
    };
  }

  async getVideoAnalytics(youtubeVideoId: string): Promise<Partial<AnalyticsRecord>> {
    return {
      youtubeVideoId,
      views: 14250,
      likes: 1120,
      comments: 84,
      shares: 310,
      subscribersGained: 65,
      retentionRate: 0.78, // 78% average retention
      averageViewDurationSeconds: 35.1,
      recordedAt: new Date().toISOString(),
    };
  }
}
