import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ResearchAgent, locateQuote, numbersConsistent } from '@shorts/agents';
import { MockLLMProvider, MockPageRetriever, type SearchProvider } from '@shorts/providers';
import { ValidationError } from '@shorts/core';
import type { TopicCandidate } from '@shorts/schemas';

const A = 'The bridge opened to the public on 10 June 2000. An estimated 90,000 people crossed it on the first day.';
const B = 'Engineers installed 37 viscous dampers beneath the deck. The bridge reopened on 22 February 2002 after the retrofit.';

describe('locateQuote', () => {
  const texts = new Map([['a', A], ['b', B]]);
  it('finds a verbatim quote in the cited source (case/punctuation-insensitive)', () => {
    expect(locateQuote('the bridge opened to the public on 10 June 2000', 'a', texts)).toMatchObject({ found: true, sourceId: 'a', reattributed: false });
  });
  // Regression 8: attribution is derived from where the evidence actually is, not array position.
  it('re-attributes a quote that only exists in a different source', () => {
    expect(locateQuote('Engineers installed 37 viscous dampers beneath the deck.', 'a', texts)).toMatchObject({ found: true, sourceId: 'b', reattributed: true });
  });
  it('matches elided quotes only when segments appear in order', () => {
    expect(locateQuote('The bridge opened to the public ... 90,000 people crossed it', 'a', texts).found).toBe(true);
    expect(locateQuote('90,000 people crossed it ... The bridge opened to the public', 'a', texts).found).toBe(false);
  });
  it('does not find fabricated quotes', () => {
    expect(locateQuote('The bridge was designed by a famous sculptor in 1998.', 'a', texts).found).toBe(false);
  });
});

describe('numbersConsistent', () => {
  it('requires every number in the claim to appear in the evidence', () => {
    expect(numbersConsistent('About 90,000 people crossed in 2000', A).ok).toBe(true);
    expect(numbersConsistent('About 100,000 people crossed', A)).toMatchObject({ ok: false, missing: ['100000'] });
    expect(numbersConsistent('Engineers fitted thirty-seven dampers', '37 dampers').ok).toBe(true);
  });
});

const topic: TopicCandidate = {
  id: randomUUID(), title: 'The Wobbly Footbridge', premise: 'A new footbridge swayed and had to close within days.', pillar: 'ENGINEERING',
  sourceUrls: [], tags: [], status: 'IN_PRODUCTION', discoveredAt: new Date().toISOString(),
};
const search: SearchProvider = {
  name: 'fixture',
  search: async () => [
    { title: 'A', url: 'https://example.org/a', snippet: '', sourceDomain: 'example.org', rawContent: A.repeat(5) },
    { title: 'B', url: 'https://example.com/b', snippet: '', sourceDomain: 'example.com', rawContent: B.repeat(5) },
    { title: 'Social', url: 'https://www.facebook.com/x', snippet: '', sourceDomain: 'facebook.com', rawContent: 'Fake claim: the bridge cost 1 dollar. '.repeat(30) },
  ],
};

function extractionLLM(claims: unknown[], entailment: 'SUPPORTED' | 'NOT_SUPPORTED' = 'SUPPORTED') {
  return new MockLLMProvider({}, {
    research_extraction: () => ({ summary: 'A bridge swayed and was fixed.', keyEntities: [], sourceTiers: {}, claims, uncertaintyNotes: [] }),
    claim_entailment: (p) => ({ results: [...new Set([...p.matchAll(/\[(C\d+)\]/g)].map((m) => m[1]))].map((r) => ({ claimRef: r, verdict: entailment, reason: '' })) }),
  });
}

describe('ResearchAgent verification', () => {
  const opts = { minVerifiedClaims: 2 };

  it('verifies only claims whose quote is located, numbers match, and entailment holds', async () => {
    const llm = extractionLLM([
      { text: 'The bridge opened on 10 June 2000.', entity: 'Bridge', sourceRef: 'S1', evidenceQuote: 'The bridge opened to the public on 10 June 2000.' },
      // Mis-cited: the quote is in S2, not S1 → must be re-attributed to S2.
      { text: 'Engineers installed 37 viscous dampers.', entity: 'Bridge', sourceRef: 'S1', evidenceQuote: 'Engineers installed 37 viscous dampers beneath the deck.' },
      // Fabricated quote.
      { text: 'The bridge was designed in 1998.', entity: 'Bridge', sourceRef: 'S1', evidenceQuote: 'The bridge was designed by a sculptor in 1998.' },
      // Quote real, number changed.
      { text: 'About 120,000 people crossed on day one.', entity: 'Bridge', sourceRef: 'S1', evidenceQuote: 'An estimated 90,000 people crossed it on the first day.' },
    ]);
    const { packet } = await new ResearchAgent(llm, llm, search, new MockPageRetriever(), opts).conductResearch(topic);
    const [c1, c2, c3, c4] = packet.claims;
    expect(packet.sources.map((s) => s.publisher)).not.toContain('facebook.com');
    const s2 = packet.sources.find((s) => s.url.endsWith('/b'))!;
    expect(c1.verificationStatus).toBe('VERIFIED');
    expect(c2.verificationStatus).toBe('VERIFIED');
    expect(c2.sourceIds).toEqual([s2.id]);
    expect(c2.verificationReason).toMatch(/re-attributed/);
    expect(c3).toMatchObject({ verificationStatus: 'UNVERIFIED', sourceIds: [] });
    expect(c3.checks.quoteFound).toBe(false);
    expect(c4.verificationStatus).toBe('UNVERIFIED');
    expect(c4.checks.numbersConsistent).toBe(false);
    expect(packet.verifiedClaimCount).toBe(2);
  });

  it('never marks a claim verified when the entailment check rejects it', async () => {
    const llm = extractionLLM(
      [
        { text: 'The bridge opened on 10 June 2000.', entity: 'B', sourceRef: 'S1', evidenceQuote: 'The bridge opened to the public on 10 June 2000.' },
        { text: 'Engineers installed 37 viscous dampers.', entity: 'B', sourceRef: 'S2', evidenceQuote: 'Engineers installed 37 viscous dampers beneath the deck.' },
      ],
      'NOT_SUPPORTED'
    );
    await expect(new ResearchAgent(llm, llm, search, new MockPageRetriever(), opts).conductResearch(topic)).rejects.toBeInstanceOf(ValidationError);
  });

  it('fails closed when too few claims can be verified', async () => {
    const llm = extractionLLM([{ text: 'Invented fact number one.', entity: 'X', sourceRef: 'S1', evidenceQuote: 'This sentence does not exist anywhere.' }]);
    // Fails closed either at extraction (quotes not found after corrective retries) or at the verified-claim minimum.
    await expect(new ResearchAgent(llm, llm, search, new MockPageRetriever(), { minVerifiedClaims: 1 }).conductResearch(topic)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('number extraction', () => {
  it('treats digits glued to letters as identifiers, not quantities', async () => {
    const { extractNumbers } = await import('@shorts/core');
    expect(extractNumbers('Rosetta reached Comet 67P in 2014 after 10.5 years')).toEqual(['2014', '10.5']);
    expect(extractNumbers('The B-52 flew 1,200 miles')).toEqual(['1200']);
    expect(extractNumbers('closed from 2000-2002')).toEqual(['2000', '2002']);
  });
});
