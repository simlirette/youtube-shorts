import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ResearchAgent, mentionsSubject, researchQuery, subjectTokens, citableSourceUrls, claimSourceStatus, locateQuote, numbersConsistent, ruleAssessment, assessedTier } from '@shorts/agents';
import { MockLLMProvider, MockPageRetriever, type SearchProvider } from '@shorts/providers';
import { ValidationError } from '@shorts/core';
import type { Claim, ResearchPacket, SourceCategory, SourceReference, TopicCandidate } from '@shorts/schemas';

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

/** Category the mock "assessor" returns for each unknown domain (default: specialist_publication → ACCEPTABLE). */
function credibilityRoute(categories: Record<string, SourceCategory> = {}) {
  return (p: string) => ({
    sources: [...p.matchAll(/\[(S\d+)\] (\S+)/g)].map((m) => ({
      ref: m[1],
      category: categories[new URL(m[2]).hostname] ?? 'specialist_publication',
      conflictOfInterest: false,
      reason: 'fixture',
    })),
  });
}

function extractionLLM(claims: unknown[], entailment: 'SUPPORTED' | 'NOT_SUPPORTED' = 'SUPPORTED', categories: Record<string, SourceCategory> = {}) {
  return new MockLLMProvider({}, {
    source_credibility: credibilityRoute(categories),
    research_extraction: () => ({ summary: 'A bridge swayed and was fixed.', keyEntities: [], sourceTiers: {}, claims, uncertaintyNotes: [] }),
    claim_entailment: (p) => ({ results: [...new Set([...p.matchAll(/\[(C\d+)\]/g)].map((m) => m[1]))].map((r) => ({ claimRef: r, verdict: entailment, reason: '' })) }),
  });
}

describe('ResearchAgent verification', () => {
  const opts = { minVerifiedClaims: 2 };

  it('verifies only claims whose quote is located, numbers match, and entailment holds', async () => {
    const llm = extractionLLM([
      { text: 'The bridge opened on 10 June 2000.', entity: 'Bridge', evidence: [{ sourceRef: 'S1', quote: 'The bridge opened to the public on 10 June 2000.' }] },
      // Mis-cited: the quote is in S2, not S1 → must be re-attributed to S2.
      { text: 'Engineers installed 37 viscous dampers.', entity: 'Bridge', evidence: [{ sourceRef: 'S1', quote: 'Engineers installed 37 viscous dampers beneath the deck.' }] },
      // Fabricated quote.
      { text: 'The bridge was designed in 1998.', entity: 'Bridge', evidence: [{ sourceRef: 'S1', quote: 'The bridge was designed by a sculptor in 1998.' }] },
      // Quote real, number changed.
      { text: 'About 120,000 people crossed on day one.', entity: 'Bridge', evidence: [{ sourceRef: 'S1', quote: 'An estimated 90,000 people crossed it on the first day.' }] },
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
        { text: 'The bridge opened on 10 June 2000.', entity: 'B', evidence: [{ sourceRef: 'S1', quote: 'The bridge opened to the public on 10 June 2000.' }] },
        { text: 'Engineers installed 37 viscous dampers.', entity: 'B', evidence: [{ sourceRef: 'S2', quote: 'Engineers installed 37 viscous dampers beneath the deck.' }] },
      ],
      'NOT_SUPPORTED'
    );
    await expect(new ResearchAgent(llm, llm, search, new MockPageRetriever(), opts).conductResearch(topic)).rejects.toBeInstanceOf(ValidationError);
  });

  it('fails closed when too few claims can be verified', async () => {
    const llm = extractionLLM([{ text: 'Invented fact number one.', entity: 'X', evidence: [{ sourceRef: 'S1', quote: 'This sentence does not exist anywhere.' }] }]);
    // Fails closed either at extraction (quotes not found after corrective retries) or at the verified-claim minimum.
    await expect(new ResearchAgent(llm, llm, search, new MockPageRetriever(), { minVerifiedClaims: 1 }).conductResearch(topic)).rejects.toBeInstanceOf(ValidationError);
  });
});

// -----------------------------------------------------------------------------
// Source credibility policy: "supported" and "acceptable for publication" are separate questions.
// -----------------------------------------------------------------------------
const cl = (text: string, ref: string, quote: string) => ({ text, entity: 'Bridge', evidence: [{ sourceRef: ref, quote }] });
const searchOf = (rows: Array<[string, string]>): SearchProvider => ({
  name: 'fixture',
  search: async () => rows.map(([url, text]) => ({ title: url, url, snippet: '', sourceDomain: new URL(url).hostname.replace(/^www\./, ''), rawContent: text.repeat(5) })),
});

describe('source credibility rules', () => {
  it('classifies by publisher, deterministically, before any model is asked', () => {
    expect(ruleAssessment('https://www.nasa.gov/x')?.tier).toBe('HIGH');
    expect(ruleAssessment('https://en.wikipedia.org/wiki/X')?.tier).toBe('ACCEPTABLE');
    expect(ruleAssessment('https://someone.medium.com/post')?.tier).toBe('QUESTIONABLE');
    expect(ruleAssessment('https://www.icr.org/article/x')?.tier).toBe('REJECTED');
    expect(ruleAssessment('https://www.reddit.com/r/x')?.tier).toBe('REJECTED');
    expect(ruleAssessment('not a url')?.tier).toBe('REJECTED');
    expect(ruleAssessment('https://unknown-site.example/x')).toBeNull();
  });
  it('never lets a model-assessed domain reach HIGH, and conflicts of interest downgrade it', () => {
    expect(assessedTier('scientific_organization', false)).toBe('ACCEPTABLE');
    expect(assessedTier('scientific_organization', true)).toBe('QUESTIONABLE');
    expect(assessedTier('commercial', false)).toBe('QUESTIONABLE');
    expect(assessedTier('religious_advocacy', false)).toBe('REJECTED');
  });
});

describe('ResearchAgent source policy', () => {
  const opts = { minVerifiedClaims: 2 };

  it('acceptable sources: claims are verified and citable', async () => {
    const llm = extractionLLM([cl('The bridge opened on 10 June 2000.', 'S1', 'The bridge opened to the public on 10 June 2000.'), cl('Engineers installed 37 viscous dampers.', 'S2', 'Engineers installed 37 viscous dampers beneath the deck.')]);
    const { packet } = await new ResearchAgent(llm, llm, search, new MockPageRetriever(), opts).conductResearch(topic);
    for (const c of packet.claims) expect(claimSourceStatus(c, packet.sources)).toMatchObject({ bestTier: 'ACCEPTABLE', citable: true, rejected: false, reviewRequired: false });
    expect(citableSourceUrls(packet, packet.claims.map((c) => c.id))).toHaveLength(2);
  });

  it('rejected sources are excluded before extraction (deny-listed and model-classified advocacy) and recorded', async () => {
    const s = searchOf([
      ['https://www.icr.org/bridge', A],
      ['https://bridge-truth.example/a', A],
      ['https://example.org/a', A],
      ['https://example.com/b', B],
    ]);
    const llm = extractionLLM([cl('The bridge opened on 10 June 2000.', 'S1', 'The bridge opened to the public on 10 June 2000.'), cl('Engineers installed 37 viscous dampers.', 'S2', 'Engineers installed 37 viscous dampers beneath the deck.')], 'SUPPORTED', { 'bridge-truth.example': 'advocacy' });
    const { packet, rejectedSources } = await new ResearchAgent(llm, llm, s, new MockPageRetriever(), opts).conductResearch(topic);
    expect(rejectedSources.map((r) => r.url).sort()).toEqual(['https://bridge-truth.example/a', 'https://www.icr.org/bridge']);
    expect(packet.sources.map((x) => x.url)).not.toContain('https://www.icr.org/bridge');
    expect(packet.sources.map((x) => x.url)).not.toContain('https://bridge-truth.example/a');
  });

  it('fails closed when every retrievable source is rejected', async () => {
    const llm = extractionLLM([], 'SUPPORTED', { 'bridge-truth.example': 'content_farm' });
    const s = searchOf([['https://www.icr.org/bridge', A], ['https://bridge-truth.example/a', B]]);
    await expect(new ResearchAgent(llm, llm, s, new MockPageRetriever(), opts).conductResearch(topic)).rejects.toThrow(/no retrievable sources acceptable/);
  });

  it('questionable-only support: claim is VERIFIED (supported) but requires human review and is not citable', async () => {
    const llm = extractionLLM([cl('The bridge opened on 10 June 2000.', 'S1', 'The bridge opened to the public on 10 June 2000.'), cl('Engineers installed 37 viscous dampers.', 'S2', 'Engineers installed 37 viscous dampers beneath the deck.')], 'SUPPORTED', { 'example.org': 'commercial', 'example.com': 'commercial' });
    const { packet } = await new ResearchAgent(llm, llm, search, new MockPageRetriever(), opts).conductResearch(topic);
    expect(packet.claims.every((c) => c.verificationStatus === 'VERIFIED')).toBe(true);
    for (const c of packet.claims) expect(claimSourceStatus(c, packet.sources)).toMatchObject({ bestTier: 'QUESTIONABLE', citable: false, reviewRequired: true, rejected: false });
    expect(citableSourceUrls(packet, packet.claims.map((c) => c.id))).toEqual([]);
  });

  it('mixed sources: the most credible supporting source decides, and only citable sources are listed', async () => {
    const s = searchOf([['https://someone.medium.com/bridge', A], ['https://www.nasa.gov/bridge', A], ['https://example.com/b', B]]);
    const llm = extractionLLM([
      { text: 'The bridge opened on 10 June 2000.', entity: 'Bridge', evidence: [{ sourceRef: 'S1', quote: 'The bridge opened to the public on 10 June 2000.' }, { sourceRef: 'S3', quote: 'The bridge opened to the public on 10 June 2000.' }] },
      cl('Engineers installed 37 viscous dampers.', 'S2', 'Engineers installed 37 viscous dampers beneath the deck.'),
    ]);
    const { packet } = await new ResearchAgent(llm, llm, s, new MockPageRetriever(), opts).conductResearch(topic);
    // Sorted by tier: S1 = nasa.gov (HIGH), S2 = example.com (ACCEPTABLE), S3 = medium (QUESTIONABLE).
    expect(packet.sources.map((x) => x.credibility?.tier)).toEqual(['HIGH', 'ACCEPTABLE', 'QUESTIONABLE']);
    const st = claimSourceStatus(packet.claims[0], packet.sources);
    expect(st.bestTier).toBe('HIGH');
    expect(st.citable).toBe(true);
    const urls = citableSourceUrls(packet, packet.claims.map((c) => c.id));
    expect(urls).toContain('https://www.nasa.gov/bridge');
    expect(urls).not.toContain('https://someone.medium.com/bridge');
  });
});

describe('research stays on the topic', () => {
  const gapTopic: TopicCandidate = {
    ...topic,
    title: 'Why are bridges important?',
    premise: 'This explains the role of bridges in connecting infrastructure.',
    gap: { question: 'why are bridges important', seed: 'why are bridges', cluster: 'infrastructure', suggestRank: 0, longformTopViews: 1, shortsInResults: 0, shortsAbove10k: 0, bestShortViews: 0, score: 100, measuredAt: new Date().toISOString() },
  };

  it('searches a gap topic with the viewer question and names its subject without generic words', () => {
    expect(researchQuery(gapTopic)).toBe('why are bridges important');
    expect(researchQuery(topic)).toBe('The Wobbly Footbridge new footbridge swayed close within day');
    expect(subjectTokens(gapTopic)).toEqual(['bridg']);
    expect(mentionsSubject(subjectTokens(topic), 'The bridge swayed when people walked across.')).toBe(true);
    expect(mentionsSubject(['bridg'], 'WAI-ARIA landmark roles identify the structure of a web page.')).toBe(false);
  });

  it('drops sources that never mention the subject before any claim is extracted from them', async () => {
    let queried = '';
    const s: SearchProvider = {
      name: 'fixture',
      search: async (q) => {
        queried = q;
        return [
          { title: 'ARIA roles', url: 'https://developer.mozilla.org/aria', snippet: '', sourceDomain: 'developer.mozilla.org', rawContent: 'WAI-ARIA roles provide semantic meaning to web content for assistive technologies. '.repeat(10) },
          { title: 'A', url: 'https://example.org/a', snippet: '', sourceDomain: 'example.org', rawContent: A.repeat(5) },
          { title: 'B', url: 'https://example.com/b', snippet: '', sourceDomain: 'example.com', rawContent: B.repeat(5) },
        ];
      },
    };
    const llm = extractionLLM([cl('The bridge opened on 10 June 2000.', 'S1', 'The bridge opened to the public on 10 June 2000.'), cl('Engineers installed 37 viscous dampers.', 'S2', 'Engineers installed 37 viscous dampers beneath the deck.')]);
    const { packet, rejectedSources } = await new ResearchAgent(llm, llm, s, new MockPageRetriever(), { minVerifiedClaims: 2 }).conductResearch(gapTopic);
    expect(queried).toBe('why are bridges important');
    expect(packet.sources.map((x) => x.publisher)).not.toContain('developer.mozilla.org');
    expect(rejectedSources).toContainEqual({ url: 'https://developer.mozilla.org/aria', reason: 'off-topic: does not mention bridg' });
  });

  it('fails closed when no source is about the topic', async () => {
    const s = searchOf([['https://developer.mozilla.org/aria', 'WAI-ARIA roles provide semantic meaning to web content. ']]);
    const llm = extractionLLM([]);
    await expect(new ResearchAgent(llm, llm, s, new MockPageRetriever(), { minVerifiedClaims: 2 }).conductResearch(gapTopic)).rejects.toThrow(/no retrievable sources acceptable/);
  });
});

describe('supported but failing publication policy', () => {
  const src = (id: string, url: string, tier: 'HIGH' | 'ACCEPTABLE' | 'QUESTIONABLE' | 'REJECTED'): SourceReference => ({
    id, url, title: url, publisher: new URL(url).hostname, credibilityTier: 'UNCLASSIFIED', retrievedAt: new Date().toISOString(),
    retrievalMethod: 'http_fetch', contentChars: 1000, contentSha256: 'a'.repeat(64),
    credibility: { tier, category: tier === 'REJECTED' ? 'advocacy' : 'reference', method: 'rule', conflictOfInterest: false, reason: 'fixture' },
  });
  const claim = (sourceIds: string[]): Claim => ({
    id: randomUUID(), text: 'The bridge opened on 10 June 2000.', entity: 'Bridge', sourceIds, evidence: sourceIds.map((sourceId) => ({ sourceId, quote: 'q', quoteFound: true })),
    verificationStatus: 'VERIFIED', verificationReason: 'ok', checks: { quoteFound: true, numbersConsistent: true, entailment: 'SUPPORTED' }, confidence: 0.9, isKeyFact: true,
  });
  it('a verified claim backed only by a rejected source is not publishable', () => {
    const sources = [src('r', 'https://www.icr.org/a', 'REJECTED')];
    expect(claimSourceStatus(claim(['r']), sources)).toMatchObject({ rejected: true, citable: false });
  });
  it('a verified claim whose sources are missing from the packet is treated as rejected (fail closed)', () => {
    expect(claimSourceStatus(claim(['ghost']), [])).toMatchObject({ rejected: true, citable: false, bestTier: null });
  });
  it('a source without a credibility assessment is treated as QUESTIONABLE, never acceptable', () => {
    const s = { ...src('u', 'https://example.org/a', 'ACCEPTABLE'), credibility: undefined };
    expect(claimSourceStatus(claim(['u']), [s])).toMatchObject({ bestTier: 'QUESTIONABLE', reviewRequired: true, citable: false });
  });
  it('description sources omit rejected and questionable sources', () => {
    const sources = [src('h', 'https://www.nasa.gov/a', 'HIGH'), src('q', 'https://x.medium.com/a', 'QUESTIONABLE'), src('r', 'https://www.icr.org/a', 'REJECTED')];
    const c = claim(['h', 'q', 'r']);
    const packet = { sources, claims: [c] } as unknown as ResearchPacket;
    expect(citableSourceUrls(packet, [c.id])).toEqual(['https://www.nasa.gov/a']);
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
