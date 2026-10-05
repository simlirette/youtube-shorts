import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ProvenanceTracker } from '@shorts/core';
import { ShortScript, ResearchPacket, AssetDescriptor } from '@shorts/schemas';

describe('ProvenanceTracker', () => {
  const source1Id = randomUUID();
  const claim1Id = randomUUID();

  const mockResearch: ResearchPacket = {
    id: randomUUID(),
    topicId: randomUUID(),
    title: 'Bridge Wobble',
    summary: 'Investigation summary',
    keyEntities: ['London Bridge'],
    uncertaintyNotes: [],
    researchedAt: new Date().toISOString(),
    sources: [
      {
        id: source1Id,
        url: 'https://nature.com/articles/1234',
        title: 'Nature Paper',
        publisher: 'Nature',
        credibilityTier: 'PEER_REVIEWED',
        retrievedAt: new Date().toISOString(),
      },
    ],
    claims: [
      {
        id: claim1Id,
        text: 'Synchronous lateral excitation caused swaying.',
        entity: 'Physics',
        sourceId: source1Id,
        sourceCitation: 'Nature Paper p. 43',
        confidence: 0.95,
        isKeyFact: true,
        verified: true,
      },
    ],
  };

  it('validates script whose scene claim exists in research', () => {
    const validScript: ShortScript = {
      id: randomUUID(),
      storyId: randomUUID(),
      topicId: mockResearch.topicId,
      title: 'Valid Script',
      hookText: 'In 2000, London opened this bridge.',
      targetDurationSeconds: 45,
      totalWords: 50,
      estimatedDurationSeconds: 40,
      createdAt: new Date().toISOString(),
      scenes: [
        {
          sceneNumber: 1,
          startTime: 0,
          endTime: 10,
          durationSeconds: 10,
          narration: 'The bridge swayed from lateral excitation.',
          visualObjective: 'Diagram',
          mediaFormat: 'CHART_DATA',
          assetKeywords: ['bridge'],
          transitionIntent: 'CUT',
          claimIds: [claim1Id],
        },
      ],
    };

    const res = ProvenanceTracker.verifyScriptClaims(validScript, mockResearch);
    expect(res.valid).toBe(true);
    expect(res.unverifiedClaims.length).toBe(0);
  });

  it('detects unverified claims not found in research packet', () => {
    const fakeClaimId = randomUUID();
    const invalidScript: ShortScript = {
      id: randomUUID(),
      storyId: randomUUID(),
      topicId: mockResearch.topicId,
      title: 'Invalid Script',
      hookText: 'In 2000, London opened this bridge.',
      targetDurationSeconds: 45,
      totalWords: 50,
      estimatedDurationSeconds: 40,
      createdAt: new Date().toISOString(),
      scenes: [
        {
          sceneNumber: 1,
          startTime: 0,
          endTime: 10,
          durationSeconds: 10,
          narration: 'Unverified claim line.',
          visualObjective: 'Diagram',
          mediaFormat: 'CHART_DATA',
          assetKeywords: ['bridge'],
          transitionIntent: 'CUT',
          claimIds: [fakeClaimId],
        },
      ],
    };

    const res = ProvenanceTracker.verifyScriptClaims(invalidScript, mockResearch);
    expect(res.valid).toBe(false);
    expect(res.unverifiedClaims.length).toBe(1);
    expect(res.unverifiedClaims[0]).toContain(fakeClaimId);
  });

  it('validates asset licenses and flags non-commercial assets', () => {
    const safeAsset: AssetDescriptor = {
      id: randomUUID(),
      assetType: 'IMAGE',
      sourceUrl: 'https://pexels.com/1',
      provider: 'pexels',
      license: 'Pexels License',
      commercialUseAllowed: true,
      attributionRequired: false,
      retrievedAt: new Date().toISOString(),
      localPath: '/tmp/test.png',
      metadata: {},
    };

    const unsafeAsset: AssetDescriptor = {
      id: randomUUID(),
      assetType: 'IMAGE',
      sourceUrl: 'https://unknown.com/1',
      provider: 'web_scrape',
      license: 'All Rights Reserved',
      commercialUseAllowed: false,
      attributionRequired: true,
      retrievedAt: new Date().toISOString(),
      localPath: '/tmp/test2.png',
      metadata: {},
    };

    const safeResult = ProvenanceTracker.verifyAssetLicenses([safeAsset]);
    expect(safeResult.valid).toBe(true);

    const unsafeResult = ProvenanceTracker.verifyAssetLicenses([safeAsset, unsafeAsset]);
    expect(unsafeResult.valid).toBe(false);
    expect(unsafeResult.flaggedAssets.length).toBeGreaterThan(0);
  });
});
