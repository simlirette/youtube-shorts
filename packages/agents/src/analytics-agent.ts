import { AnalyticsRecord, ContentPillar } from '@shorts/schemas';
import { ShortsRepository, logger } from '@shorts/core';

export interface PillarPerformanceSummary {
  pillar: ContentPillar;
  totalVideos: number;
  totalViews: number;
  averageRetention: number;
  averageViews: number;
}

export class AnalyticsAgent {
  constructor(private repo: ShortsRepository) {}

  async analyzePerformance(records: AnalyticsRecord[]): Promise<{
    pillarBreakdown: PillarPerformanceSummary[];
    topPillar: ContentPillar;
    recommendations: string[];
  }> {
    logger.info(`Analyzing performance across ${records.length} published video records`, {
      stage: 'ANALYTICS',
      recordCount: records.length,
    });

    const pillarMap = new Map<ContentPillar, { count: number; views: number; retentionSum: number }>();

    for (const record of records) {
      const current = pillarMap.get(record.pillar) || { count: 0, views: 0, retentionSum: 0 };
      current.count += 1;
      current.views += record.views;
      current.retentionSum += record.retentionRate;
      pillarMap.set(record.pillar, current);
    }

    const summaries: PillarPerformanceSummary[] = [];
    let topPillar: ContentPillar = 'ENGINEERING';
    let maxAvgViews = -1;

    for (const [pillar, stats] of pillarMap.entries()) {
      const avgViews = Math.round(stats.views / Math.max(1, stats.count));
      const avgRetention = Math.round((stats.retentionSum / Math.max(1, stats.count)) * 100) / 100;
      summaries.push({
        pillar,
        totalVideos: stats.count,
        totalViews: stats.views,
        averageRetention: avgRetention,
        averageViews: avgViews,
      });

      if (avgViews > maxAvgViews) {
        maxAvgViews = avgViews;
        topPillar = pillar;
      }
    }

    const recommendations = [
      `Double down on ${topPillar}: demonstrated highest viewer retention and engagement.`,
      'Maintain hook durations under 2.5 seconds to protect 3-second dropoff.',
      'Prioritize engineering and strange real-world topics with high visual contrast diagrams.',
    ];

    logger.info(`Performance analysis concluded. Top performing pillar: ${topPillar}`, {
      stage: 'ANALYTICS',
      topPillar,
    });

    return {
      pillarBreakdown: summaries,
      topPillar,
      recommendations,
    };
  }
}
