import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ClaimSchema, ShortScriptSchema, TopicCandidateSchema, TopicScoreSchema, YouTubeMetadataSchema } from '@shorts/schemas';

describe('Data contracts', () => {
  it('validates a well-formed TopicCandidate', () => {
    const res = TopicCandidateSchema.safeParse({
      id: randomUUID(),
      title: 'The Great Molasses Flood of 1919',
      premise: 'A 50-foot tank burst in Boston, releasing a deadly wave of hot molasses.',
      pillar: 'STRANGE_REAL_WORLD',
      discoveredAt: new Date().toISOString(),
    });
    expect(res.success).toBe(true);
  });

  // Contract change: discovery no longer fabricates a placeholder source URL. Sources are recorded
  // only once research retrieves them, but anything recorded must be a real URL.
  it('rejects a TopicCandidate with an invalid source URL and an unknown pillar', () => {
    const base = { id: randomUUID(), title: 'Some topic title', premise: 'A premise of sufficient length.', discoveredAt: new Date().toISOString() };
    expect(TopicCandidateSchema.safeParse({ ...base, pillar: 'BUSINESS', sourceUrls: ['not a url'] }).success).toBe(false);
    expect(TopicCandidateSchema.safeParse({ ...base, pillar: 'STRANGE_EVENTS' }).success).toBe(false);
  });

  it('requires a score to carry an explicit gate result', () => {
    const score = {
      id: randomUUID(), topicId: randomUUID(), overallScore: 80, curiosity: 9, audiencePotential: 8, originality: 8, storyDepth: 8,
      visualPotential: 8, sourceAvailability: 9, freshness: 6, productionComplexity: 4, copyrightRisk: 1, repetitionRisk: 1,
      monetizationRisk: 1, reasoning: 'ok', scoredAt: new Date().toISOString(),
    };
    expect(TopicScoreSchema.safeParse(score).success).toBe(false);
    expect(TopicScoreSchema.safeParse({ ...score, passGate: true }).success).toBe(true);
  });

  it('a claim cannot exist without an explicit verification status and reason', () => {
    const claim = { id: randomUUID(), text: 'A factual claim.', entity: 'X', sourceIds: [], evidence: [], checks: { quoteFound: false, numbersConsistent: true, entailment: 'NOT_CHECKED' }, confidence: 0 };
    expect(ClaimSchema.safeParse(claim).success).toBe(false);
    expect(ClaimSchema.safeParse({ ...claim, verificationStatus: 'UNVERIFIED', verificationReason: 'no evidence' }).success).toBe(true);
  });

  it('validates a script and rejects scripts with fewer than 3 scenes', () => {
    const scene = (n: number) => ({ sceneNumber: n, narration: 'Narration line.', visualObjective: 'Show it.', assetKeywords: ['bridge'] });
    const script = {
      id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Why London Bridge Swayed', hookText: 'It swayed.',
      targetDurationSeconds: 45, scenes: [scene(1), scene(2), scene(3)], totalWords: 9, createdAt: new Date().toISOString(),
    };
    expect(ShortScriptSchema.safeParse(script).success).toBe(true);
    expect(ShortScriptSchema.safeParse({ ...script, scenes: [scene(1)] }).success).toBe(false);
  });

  it('enforces YouTube metadata limits', () => {
    expect(YouTubeMetadataSchema.safeParse({ title: 'x'.repeat(101), description: '', tags: [], privacyStatus: 'private' }).success).toBe(false);
    expect(YouTubeMetadataSchema.safeParse({ title: 'Valid title', description: '', tags: ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100), 'd'.repeat(100), 'e'.repeat(100), 'f'], privacyStatus: 'private' }).success).toBe(false);
    expect(YouTubeMetadataSchema.safeParse({ title: 'Valid title', description: 'd', tags: ['a'], privacyStatus: 'private' }).success).toBe(true);
  });
});
