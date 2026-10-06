import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DiscoveryAgent, ScoringAgent, ScriptwriterAgent, computeOverallScore, isNearDuplicate, validateScriptDraft, type ScriptDraft } from '@shorts/agents';
import { MockLLMProvider } from '@shorts/providers';
import { ValidationError } from '@shorts/core';
import type { ResearchPacket, StoryOutline } from '@shorts/schemas';
import { memoryRepo, testConfig } from './helpers.js';

const rules = { minWords: 100, maxWords: 130, hookMaxWords: 7, sceneCount: 5, minClaimRefs: 2 };
const claims = new Map([['C1', 'The bridge opened on 10 June 2000.'], ['C2', 'It closed two days later.']]);
const words = (n: number) => Array.from({ length: n }, (_, i) => ['river', 'bridge', 'people', 'walked', 'across'][i % 5]).join(' ');

function draft(bodyWords: number[], hook = 'Why did it sway?'): ScriptDraft {
  return {
    title: 'The Bridge That Swayed Too Much',
    description: 'How a new footbridge closed within days of opening.',
    scenes: [hook, ...bodyWords.map(words)].map((n, i) => ({ narration: n, visualObjective: 'A bridge', assetKeywords: ['bridge', 'river'], claimRefs: i === 1 ? ['C1'] : i === 2 ? ['C2'] : [] })),
  };
}

describe('script contract (regression 9: word count is enforced, not hoped for)', () => {
  it('accepts exactly the boundaries 100 and 130', () => {
    expect(validateScriptDraft(draft([24, 24, 24, 24]), { rules, claims })).toEqual([]); // 4 + 96 = 100
    expect(validateScriptDraft(draft([31, 31, 32, 32]), { rules, claims })).toEqual([]); // 4 + 126 = 130
  });
  it('rejects 99 and 131 words', () => {
    expect(validateScriptDraft(draft([24, 24, 24, 23]), { rules, claims }).join()).toMatch(/got 99/);
    expect(validateScriptDraft(draft([31, 32, 32, 32]), { rules, claims }).join()).toMatch(/got 131/);
  });
  it('rejects long hooks, unknown claims, and unsupported numbers', () => {
    const d = draft([24, 24, 24, 24], 'This hook is far too long to be a hook');
    d.scenes[3].claimRefs = ['C9'];
    d.scenes[4].narration = `${words(20)} it cost 25 million dollars`;
    const v = validateScriptDraft(d, { rules, claims }).join(' | ');
    expect(v).toMatch(/hook must be at most 7 words/);
    expect(v).toMatch(/unknown claim "C9"/);
    expect(v).toMatch(/number\(s\) 25/);
  });
  it('rejects near-duplicate titles of previous Shorts', () => {
    expect(validateScriptDraft(draft([24, 24, 24, 24]), { rules, claims, previousTitles: ['The Bridge That Swayed Too Much!'] }).join()).toMatch(/near-duplicate/);
  });
});

const research: ResearchPacket = {
  id: randomUUID(), topicId: randomUUID(), title: 'Bridge', summary: 'Summary of research', keyEntities: [], uncertaintyNotes: [], verifiedClaimCount: 2,
  researchedAt: new Date().toISOString(),
  sources: [{ id: randomUUID(), url: 'https://example.org', title: 'S', publisher: 'example.org', credibilityTier: 'UNCLASSIFIED', retrievedAt: new Date().toISOString(), retrievalMethod: 'http_fetch', contentChars: 10, contentSha256: 'b'.repeat(64) }],
  claims: [],
};
research.claims = ['The bridge opened on 10 June 2000.', 'It closed two days later.'].map((text) => ({
  id: randomUUID(), text, entity: 'Bridge', sourceIds: [research.sources[0].id], evidence: [{ sourceId: research.sources[0].id, quote: text, quoteFound: true }],
  verificationStatus: 'VERIFIED' as const, verificationReason: 'ok', checks: { quoteFound: true, numbersConsistent: true, entailment: 'SUPPORTED' as const }, confidence: 0.9, isKeyFact: true,
}));
const story: StoryOutline = {
  id: randomUUID(), topicId: research.topicId, logline: 'A bridge swayed.', centralConflict: 'c', hookConcept: 'h',
  narrativeArc: { hook: 'h', context: 'c', development: 'd', twist: 't', payoff: 'p' }, targetDurationSeconds: 45, createdAt: new Date().toISOString(),
};

describe('ScriptwriterAgent', () => {
  it('retries with feedback and fails closed when the model never satisfies the contract', async () => {
    let calls = 0;
    const llm = new MockLLMProvider({}, { script: () => (calls++, draftToRaw(draft([10, 10, 10, 10]))) });
    await expect(new ScriptwriterAgent(llm, { rules, maxAttempts: 3 }).writeScript(story, research, { previousTitles: [], previousHooks: [] })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toBe(3);
  });

  it('accepts a corrected draft and maps claim refs to verified claim IDs', async () => {
    let calls = 0;
    const prompts: string[] = [];
    const llm = new MockLLMProvider({}, { script: (p) => (prompts.push(p), calls++ === 0 ? draftToRaw(draft([10, 10, 10, 10])) : draftToRaw(draft([25, 25, 25, 25]))) });
    const s = await new ScriptwriterAgent(llm, { rules, maxAttempts: 3 }).writeScript(story, research, { previousTitles: [], previousHooks: [] });
    expect(s.totalWords).toBe(104);
    expect(s.generationAttempts).toBe(2);
    expect(prompts[1]).toMatch(/YOUR PREVIOUS RESPONSE/);
    expect(s.scenes[1].claimIds).toEqual([research.claims[0].id]);
    expect(s.scenes[0].claimIds).toEqual([]); // no claim #0 back-fill
  });

  it('rejects drafts the reviewer finds material unsupported facts in', async () => {
    const llm = new MockLLMProvider({}, { script: () => draftToRaw(draft([25, 25, 25, 25])) });
    const reviewer = new MockLLMProvider({}, { content_review: () => ({ findings: [{ statement: 'It won an award.', severity: 'material', reason: 'not in facts' }] }) });
    await expect(new ScriptwriterAgent(llm, { rules, maxAttempts: 2 }, reviewer).writeScript(story, research, { previousTitles: [], previousHooks: [] })).rejects.toThrow(/unsupported fact/);
  });
});

function draftToRaw(d: ScriptDraft) {
  return { title: d.title, description: d.description, scenes: d.scenes.map((s) => ({ ...s })) };
}

describe('Discovery', () => {
  // Regression 10: requested 3, model returns 1 → corrective retry, then explicit shortfall.
  it('reports an explicit shortfall instead of silently returning fewer topics', async () => {
    const cfg = testConfig();
    const repo = await memoryRepo(cfg);
    let calls = 0;
    const llm = new MockLLMProvider({}, {
      discovery: () => (calls++, { topics: [{ title: 'Why the Citicorp Tower Was Secretly Repaired', premise: 'A structural flaw was found after completion and fixed at night.', pillar: 'ENGINEERING', tags: [] }] }),
    });
    await expect(new DiscoveryAgent(llm, repo, { recentTopicLimit: 50 }).discoverTopics('ENGINEERING', 3)).rejects.toThrow(/exactly 5 are required/);
    expect(calls).toBe(2);

    const ok = new MockLLMProvider({}, {
      discovery: () => ({
        topics: [
          { title: 'Why the Citicorp Tower Was Secretly Repaired', premise: 'A structural flaw was found after completion and fixed at night.', pillar: 'ENGINEERING', tags: [] },
          { title: 'The Secret Repair of the Citicorp Tower', premise: 'The same story told with different words and framing.', pillar: 'ENGINEERING', tags: [] },
          { title: 'You Won’t Believe This Bridge', premise: 'Clickbait premise that should be rejected outright here.', pillar: 'ENGINEERING', tags: [] },
          { title: 'How the Hyatt Regency Walkway Design Change Failed', premise: 'A late change to a hanger rod design doubled the load on a connection.', pillar: 'ENGINEERING', tags: [] },
          { title: 'Why Things Happen Sometimes', premise: 'Far too brief premise here.', pillar: 'ENGINEERING', tags: [] },
        ],
      }),
    });
    const res = await new DiscoveryAgent(ok, repo, { recentTopicLimit: 50 }).discoverTopics('ENGINEERING', 3);
    expect(res.requested).toBe(3);
    expect(res.topics).toHaveLength(2);
    expect(res.shortfall).toBe(1);
    expect(res.rejected.map((r) => r.reason).join()).toMatch(/duplicate/);
    expect(res.rejected.map((r) => r.reason).join()).toMatch(/clickbait/);
  });

  // Regression 11: re-titled duplicates of existing topics are rejected.
  it('detects near-duplicate titles', () => {
    expect(isNearDuplicate('The Bizarre Tale of the Tacoma Narrows Bridge Collapse', 'The Bizarre Failure of Tacoma Narrows Bridge')).toBe(true);
    expect(isNearDuplicate('The Bridge That Sings', 'The Tacoma Narrows Bridge Collapse')).toBe(false);
  });

  it('rejects topics already in the catalog', async () => {
    const cfg = testConfig();
    const repo = await memoryRepo(cfg);
    const llm = new MockLLMProvider();
    const first = await new DiscoveryAgent(llm, repo, { recentTopicLimit: 50 }).discoverTopics(undefined, 1);
    expect(first.topics).toHaveLength(1);
    // The mock reads the ALREADY USED list from the prompt; history is also checked deterministically.
    const second = await new DiscoveryAgent(llm, repo, { recentTopicLimit: 50 }).discoverTopics(undefined, 1);
    expect(second.topics).toHaveLength(1);
    const titles = new Set(first.topics.map((t) => t.title));
    expect(second.topics.every((t) => !titles.has(t.title))).toBe(true);
  });
});

describe('Scoring', () => {
  it('computes the score deterministically and never defaults a missing response into a pass', async () => {
    const d = { curiosity: 8, audiencePotential: 8, originality: 7, storyDepth: 8, visualPotential: 7, sourceAvailability: 9, freshness: 6, productionComplexity: 4, copyrightRisk: 1, repetitionRisk: 2, monetizationRisk: 1 };
    expect(computeOverallScore(d)).toBe(77);
    const garbage = new MockLLMProvider({}, { scoring: () => ({ unrelated: true }) });
    const topic = { id: randomUUID(), title: 'A real topic title', premise: 'A premise long enough.', pillar: 'SCIENCE' as const, sourceUrls: [], tags: [], status: 'DISCOVERED' as const, discoveredAt: new Date().toISOString() };
    await expect(new ScoringAgent(garbage, { minScore: 70 }).scoreTopic(topic)).rejects.toBeInstanceOf(ValidationError);
  });
});
