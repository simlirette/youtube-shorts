import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  TopicCandidateSchema,
  TopicScoreSchema,
  ShortScriptSchema,
  QAResultSchema,
  ClaimSchema,
} from '@shorts/schemas';

describe('Data Contracts & Zod Schemas', () => {
  it('validates a well-formed TopicCandidate', () => {
    const validTopic = {
      id: randomUUID(),
      title: 'The Great Molasses Flood of 1919',
      premise: 'A 50-foot tank burst in Boston, releasing a deadly wave of hot molasses.',
      pillar: 'STRANGE_REAL_WORLD',
      sourceUrls: ['https://www.scientificamerican.com/article/the-science-of-the-great-molasses-flood/'],
      discoveredAt: new Date().toISOString(),
      tags: ['history', 'boston', 'fluid-dynamics'],
      state: 'DISCOVERED',
    };

    const res = TopicCandidateSchema.safeParse(validTopic);
    expect(res.success).toBe(true);
  });

  it('rejects an invalid TopicCandidate missing sources', () => {
    const invalidTopic = {
      id: randomUUID(),
      title: 'No sources topic',
      premise: 'This topic has no source backing.',
      pillar: 'BUSINESS',
      sourceUrls: [], // Must have at least 1 URL
      discoveredAt: new Date().toISOString(),
    };

    const res = TopicCandidateSchema.safeParse(invalidTopic);
    expect(res.success).toBe(false);
  });

  it('validates a TopicScore with multi-dimensional criteria', () => {
    const validScore = {
      id: randomUUID(),
      topicId: randomUUID(),
      overallScore: 92,
      curiosity: 9.5,
      audiencePotential: 9.0,
      originality: 8.8,
      storyDepth: 9.0,
      visualPotential: 9.2,
      sourceAvailability: 9.5,
      freshness: 8.0,
      productionComplexity: 4.0,
      copyrightRisk: 1.0,
      repetitionRisk: 1.5,
      monetizationRisk: 0.5,
      reasoning: 'Compelling historical anomaly with deep primary source evidence.',
      passGate: true,
      scoredAt: new Date().toISOString(),
    };

    const res = TopicScoreSchema.safeParse(validScore);
    expect(res.success).toBe(true);
  });

  it('validates a machine-readable ShortScript with scenes', () => {
    const validScript = {
      id: randomUUID(),
      storyId: randomUUID(),
      topicId: randomUUID(),
      title: 'Why London Bridge Swayed',
      hookText: 'In 2000, London opened a $25M bridge. Two days later, it was shut down.',
      targetDurationSeconds: 45,
      totalWords: 95,
      estimatedDurationSeconds: 42,
      createdAt: new Date().toISOString(),
      scenes: [
        {
          sceneNumber: 1,
          startTime: 0,
          endTime: 8,
          durationSeconds: 8,
          narration: 'Opening narration line.',
          visualObjective: 'Show the bridge opening ceremony.',
          mediaFormat: 'LICENSED_STOCK',
          assetKeywords: ['london bridge', 'opening'],
          transitionIntent: 'CUT',
          claimIds: [],
        },
        {
          sceneNumber: 2,
          startTime: 8,
          endTime: 22,
          durationSeconds: 14,
          narration: 'The bridge began violently swinging.',
          visualObjective: 'Show bridge sway archive footage.',
          mediaFormat: 'HISTORICAL_IMAGE',
          assetKeywords: ['bridge sway'],
          transitionIntent: 'CUT',
          claimIds: [],
        },
        {
          sceneNumber: 3,
          startTime: 22,
          endTime: 42,
          durationSeconds: 20,
          narration: 'It took 91 dampers to fix the sway permanently.',
          visualObjective: 'Show damping mechanism.',
          mediaFormat: 'CHART_DATA',
          assetKeywords: ['damper'],
          transitionIntent: 'FADE',
          claimIds: [],
        },
      ],
    };

    const res = ShortScriptSchema.safeParse(validScript);
    expect(res.success).toBe(true);
  });
});
