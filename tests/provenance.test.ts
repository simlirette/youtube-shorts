import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ProvenanceTracker } from '@shorts/core';
import type { Claim, ResearchPacket, ShortScript } from '@shorts/schemas';

const sourceId = randomUUID();
const verifiedId = randomUUID();
const unverifiedId = randomUUID();

const claim = (id: string, status: Claim['verificationStatus']): Claim => ({
  id,
  text: 'The bridge closed on 12 June 2000.',
  entity: 'Bridge',
  sourceIds: status === 'VERIFIED' ? [sourceId] : [],
  evidence: [{ sourceId, quote: 'The bridge was closed on 12 June 2000.', quoteFound: status === 'VERIFIED' }],
  verificationStatus: status,
  verificationReason: status === 'VERIFIED' ? 'quote located' : 'evidence quote not found in any retrieved source text',
  checks: { quoteFound: status === 'VERIFIED', numbersConsistent: true, entailment: status === 'VERIFIED' ? 'SUPPORTED' : 'NOT_CHECKED' },
  confidence: status === 'VERIFIED' ? 0.9 : 0,
  isKeyFact: true,
});

const research: ResearchPacket = {
  id: randomUUID(),
  topicId: randomUUID(),
  title: 'Bridge',
  summary: 'Summary',
  keyEntities: [],
  uncertaintyNotes: [],
  verifiedClaimCount: 1,
  researchedAt: new Date().toISOString(),
  sources: [
    {
      id: sourceId, url: 'https://example.org/a', title: 'A', publisher: 'example.org', credibilityTier: 'REPUTABLE_JOURNALISM',
      retrievedAt: new Date().toISOString(), retrievalMethod: 'http_fetch', contentChars: 100, contentSha256: 'a'.repeat(64),
    },
  ],
  claims: [claim(verifiedId, 'VERIFIED'), claim(unverifiedId, 'UNVERIFIED')],
};

const script = (claimIds: string[]): ShortScript => ({
  id: randomUUID(), storyId: randomUUID(), topicId: research.topicId, title: 'Bridge story', description: '', hookText: 'It swayed.',
  targetDurationSeconds: 45, totalWords: 10, generationAttempts: 1, format: 'STORY', createdAt: new Date().toISOString(),
  scenes: [1, 2, 3].map((n) => ({ sceneNumber: n, narration: 'Line.', visualObjective: 'x', visualSubject: 'steel footbridge', visualExclusions: [], mediaFormat: 'LICENSED_STOCK', assetKeywords: ['bridge'], transitionIntent: 'CUT', claimIds: n === 2 ? claimIds : [], beats: [] })),
});

describe('ProvenanceTracker', () => {
  it('accepts scenes referencing VERIFIED claims with present sources', () => {
    const r = ProvenanceTracker.verifyScriptClaims(script([verifiedId]), research);
    expect(r.valid).toBe(true);
    expect(r.referencedVerifiedClaims).toEqual([verifiedId]);
  });

  // Regression 7: a claim that exists but is not verified must not pass as verified.
  it('rejects scenes that reference UNVERIFIED claims', () => {
    const r = ProvenanceTracker.verifyScriptClaims(script([unverifiedId]), research);
    expect(r.valid).toBe(false);
    expect(r.unverifiedClaims[0]).toContain(unverifiedId);
  });

  it('rejects unknown claim ids', () => {
    const r = ProvenanceTracker.verifyScriptClaims(script([randomUUID()]), research);
    expect(r.valid).toBe(false);
    expect(r.unknownClaims).toHaveLength(1);
  });

  it('rejects verified claims whose source is missing from the packet', () => {
    const broken = { ...research, sources: [] as ResearchPacket['sources'] } as unknown as ResearchPacket;
    expect(ProvenanceTracker.verifyScriptClaims(script([verifiedId]), broken).valid).toBe(false);
  });
});
