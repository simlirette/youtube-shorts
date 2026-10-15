/**
 * Growth system: gap discovery, format rotation, footage/credit preflight before paid voice,
 * release scheduling, YouTube connection helpers and performance analytics.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QuotaExceededError, ShortsRepository, createDatabase, upsertEnvVar } from '@shorts/core';
import {
  ElevenLabsTTSProvider,
  MockAssetProvider,
  MockLLMProvider,
  MockSignalsProvider,
  MockTTSProvider,
  YouTubeAnalyticsClient,
  buildConsentUrl,
  createProviders,
  type TTSProvider,
} from '@shorts/providers';
import {
  FORMATS,
  GapDiscoveryAgent,
  ScriptwriterAgent,
  VoiceAgent,
  analyzePerformance,
  broadSubject,
  chooseFormat,
  gapScore,
  measureGap,
  questionHeuristics,
  renderPerformanceReport,
  rulesFor,
  validateScriptDraft,
  visualPreflight,
  type PerformanceRow,
} from '@shorts/agents';
import { PipelineRunner, nextPublishSlot, zonedTimeToUtc } from '@shorts/pipeline';
import { AssetDescriptorSchema, ShortScriptSchema, type ResearchPacket, type ShortScript, type StoryOutline, type TopicCandidate } from '@shorts/schemas';
import { jsonResponse, memoryRepo, testConfig } from './helpers.js';

// -----------------------------------------------------------------------------
describe('gap score (deterministic demand vs supply)', () => {
  it('scores a proven question with no Short highly, and a well-covered one low', () => {
    const open = gapScore({ longformTopViews: 6_800_000, bestShortViews: 0, shortsAbove10k: 0, suggestRank: 3 });
    const covered = gapScore({ longformTopViews: 16_000_000, bestShortViews: 675_000, shortsAbove10k: 2, suggestRank: 2 });
    const noDemand = gapScore({ longformTopViews: 8_000, bestShortViews: 0, shortsAbove10k: 0, suggestRank: 0 });
    expect(open).toBeGreaterThan(90);
    expect(covered).toBeLessThan(45);
    expect(noDemand).toBe(0);
  });
  it('more existing supply never raises the score', () => {
    const base = { longformTopViews: 2_000_000, shortsAbove10k: 0, suggestRank: 5 };
    const scores = [0, 5_000, 50_000, 500_000, 5_000_000].map((b) => gapScore({ ...base, bestShortViews: b }));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
  });
  it('treats only videos of at most 65 s as Shorts', () => {
    const e = measureGap('why do planes turn after takeoff', { cluster: 'aviation', seed: 'why do planes' }, 0, [
      { id: 'a', title: 'Why planes turn right after takeoff', views: 3_000_000, durationSeconds: 600, channel: 'x' },
      { id: 'b', title: 'Why do planes turn after takeoff? #shorts', views: 20_000, durationSeconds: 58, channel: 'y' },
      { id: 'c', title: 'Planes turn after takeoff explained', views: 900_000, durationSeconds: 70, channel: 'z' },
    ]);
    expect(e).toMatchObject({ longformTopViews: 3_000_000, shortsInResults: 1, shortsAbove10k: 1, bestShortViews: 20_000 });
  });
  it('ignores unrelated results (regression: an unrelated 110M-view video inflated a crow question)', () => {
    const e = measureGap('why is it illegal to own a crow', { cluster: 'odd_laws', seed: 'why is it illegal to' }, 0, [
      { id: 'v', title: 'Most viral prank ever', views: 110_000_000, durationSeconds: 300, channel: 'x' },
      { id: 'w', title: 'Why owning a crow is illegal', views: 400_000, durationSeconds: 480, channel: 'y' },
    ]);
    expect(e.longformTopViews).toBe(400_000);
  });
  it('filters non-questions, vague and entertainment queries before any model call', () => {
    expect(questionHeuristics('why do planes turn after takeoff')).toBeNull();
    expect(questionHeuristics('planes turning after takeoff')).toMatch(/not a question/);
    expect(questionHeuristics('why do planes')).toMatch(/too short/);
    expect(questionHeuristics('why do planes song lyrics remix')).toMatch(/off-topic/);
  });
});

describe('GapDiscoveryAgent', () => {
  it('turns autocomplete questions into measured topics, drops covered/off-topic/duplicate ones', async () => {
    const cfg = testConfig();
    const repo = await memoryRepo(cfg);
    const signals = new MockSignalsProvider();
    const llm = new MockLLMProvider();
    const agent = new GapDiscoveryAgent(signals, llm, repo, {
      seeds: [{ cluster: 'aviation', seed: 'why do planes' }, { cluster: 'maritime', seed: 'why do ships' }],
      minScore: 45,
      maxProbes: 10,
    });
    const res = await agent.discover();
    const titles = res.topics.map((t) => t.title);
    expect(titles).toContain('Why do planes turn after takeoff?');
    expect(titles).toContain('Why do ships have bulbous bows?');
    expect(titles.join()).not.toMatch(/round windows/); // well covered by Shorts → below threshold
    expect(res.probes.find((p) => p.question.includes('round windows'))?.outcome).toBe('BELOW_THRESHOLD');
    expect(res.dropped.find((d) => d.question.includes('lyrics'))?.reason).toMatch(/off-topic/);
    for (const t of res.topics) {
      expect(t.gap?.score).toBeGreaterThanOrEqual(45);
      expect(t.status).toBe('SCORED');
      expect((await repo.getLatestTopicScore(t.id))?.passGate).toBe(true);
    }
    // A second run finds nothing new: every question is now a known topic.
    const again = await agent.discover();
    expect(again.topics).toHaveLength(0);
    expect(again.dropped.some((d) => /near-duplicate/.test(d.reason))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
const gapTopic = (question = 'why do planes turn after takeoff'): TopicCandidate => ({
  id: randomUUID(), title: 'Why do planes turn after takeoff?', premise: 'Explains departure turns after takeoff.', pillar: 'ENGINEERING',
  sourceUrls: [], tags: ['cluster:aviation', 'gap'], status: 'IN_PRODUCTION', discoveredAt: new Date().toISOString(),
  gap: { question, seed: 'why do planes', cluster: 'aviation', suggestRank: 0, longformTopViews: 6_800_000, shortsInResults: 0, shortsAbove10k: 0, bestShortViews: 0, score: 98, measuredAt: new Date().toISOString() },
});

describe('format rotation', () => {
  const all = ['QUESTION_ANSWER', 'THREE_REASONS', 'STORY'] as const;
  it('uses question formats for gap topics and STORY for brainstormed topics', () => {
    expect(['QUESTION_ANSWER', 'THREE_REASONS']).toContain(chooseFormat(gapTopic(), [], [...all]));
    expect(chooseFormat({ ...gapTopic(), gap: undefined }, [], [...all])).toBe('STORY');
  });
  it('rotates to the least recently used format and never repeats one three times', () => {
    expect(chooseFormat(gapTopic(), [{ format: 'QUESTION_ANSWER' }], [...all])).toBe('THREE_REASONS');
    expect(chooseFormat(gapTopic(), [{ format: 'THREE_REASONS' }, { format: 'THREE_REASONS' }], [...all], { THREE_REASONS: 3 })).toBe('QUESTION_ANSWER');
  });
  it('measured performance nudges the choice', () => {
    expect(chooseFormat(gapTopic(), [{ format: 'THREE_REASONS' }, { format: 'QUESTION_ANSWER' }], [...all], { THREE_REASONS: 3 })).toBe('THREE_REASONS');
  });
  it('question formats are shorter (fewer voice credits) and require a question hook', () => {
    const r = rulesFor('QUESTION_ANSWER', 118);
    expect(r.maxWords).toBeLessThan(FORMATS.STORY.rules.maxWords);
    const draft = {
      title: 'Why do planes turn after takeoff',
      description: 'Departure turns explained with verified facts from aviation sources.',
      scenes: ['Planes turn after takeoff for a reason.', 'w '.repeat(18), 'w '.repeat(18), 'w '.repeat(18)].map((n) => ({
        narration: n.trim(), visualObjective: 'A plane climbing', visualSubject: 'airliner climbing after takeoff', visualExclusions: [], assetKeywords: ['airplane', 'takeoff'], claimRefs: [] as string[],
      })),
    };
    expect(validateScriptDraft(draft, { rules: r, claims: new Map() }).join()).toMatch(/must be the viewer question/);
  });
});

describe('visual exclusions (regression: "clear sky", "no clouds", "ground view" made every airplane clip fail)', () => {
  it('rejects negations and shot preferences, accepts kinds of misleading imagery', () => {
    const mk = (visualExclusions: string[]) => ({
      title: 'Why do planes look slow in the sky', description: 'Why airliners look slow from the ground, explained with verified facts.',
      scenes: ['Why do planes look slow?', 'w '.repeat(18), 'w '.repeat(18), 'w '.repeat(18)].map((n) => ({ narration: n.trim(), visualObjective: 'x', visualSubject: 'airliner in sky', visualExclusions, assetKeywords: ['airplane', 'sky'], claimRefs: [] as string[] })),
    });
    const r = rulesFor('QUESTION_ANSWER', 118);
    expect(validateScriptDraft(mk(['no clouds']), { rules: r, claims: new Map() }).join()).toMatch(/not a negation or shot preference/);
    expect(validateScriptDraft(mk(['a very long shot preference']), { rules: r, claims: new Map() }).join()).toMatch(/visualExclusion/);
    expect(validateScriptDraft(mk(['cartoon', 'north sea storm']), { rules: r, claims: new Map() }).join()).not.toMatch(/visualExclusion/);
  });
});

describe('ScriptwriterAgent with a question format', () => {
  const research: ResearchPacket = {
    id: randomUUID(), topicId: randomUUID(), title: 'Turns', summary: 'Departure procedures', keyEntities: [], uncertaintyNotes: [], verifiedClaimCount: 3, researchedAt: new Date().toISOString(),
    sources: [{ id: randomUUID(), url: 'https://www.faa.gov/x', title: 'FAA', publisher: 'faa.gov', credibilityTier: 'UNCLASSIFIED', retrievedAt: new Date().toISOString(), retrievalMethod: 'http_fetch', contentChars: 10, contentSha256: 'c'.repeat(64), credibility: { tier: 'HIGH', category: 'government', method: 'rule', conflictOfInterest: false, reason: 'gov' } }],
    claims: [],
  };
  research.claims = ['Departure procedures route aircraft away from noise-sensitive areas.', 'Controllers separate departing aircraft by assigning different headings.', 'Standard instrument departures are published routes.'].map((text) => ({
    id: randomUUID(), text, entity: 'Aviation', sourceIds: [research.sources[0].id], evidence: [{ sourceId: research.sources[0].id, quote: text, quoteFound: true }],
    verificationStatus: 'VERIFIED' as const, verificationReason: 'ok', checks: { quoteFound: true, numbersConsistent: true, entailment: 'SUPPORTED' as const }, confidence: 0.9, isKeyFact: true,
  }));
  const story: StoryOutline = { id: randomUUID(), topicId: research.topicId, logline: 'Why planes turn.', centralConflict: 'c', hookConcept: 'h', narrativeArc: { hook: 'h', context: 'c', development: 'd', twist: 't', payoff: 'p' }, targetDurationSeconds: 32, createdAt: new Date().toISOString() };

  it('opens with the viewer question, stores the format, and re-prompts when footage is missing', async () => {
    let preflightCalls = 0;
    const s = await new ScriptwriterAgent(new MockLLMProvider(), {
      rules: rulesFor('QUESTION_ANSWER', 118), maxAttempts: 3, format: FORMATS.QUESTION_ANSWER, topic: gapTopic(),
      visualPreflight: async () => (preflightCalls++ === 0 ? ['scene 2 visualSubject "x" has only 0 usable stock clip(s)'] : []),
    }).writeScript(story, research, { previousTitles: [], previousHooks: [] });
    expect(s.format).toBe('QUESTION_ANSWER');
    expect(s.hookText).toMatch(/^why do planes turn after takeoff\?$/i);
    expect(s.scenes).toHaveLength(4);
    expect(s.totalWords).toBeGreaterThanOrEqual(55);
    expect(s.totalWords).toBeLessThanOrEqual(85);
    expect(preflightCalls).toBe(2);
    expect(s.generationAttempts).toBe(2);
  });

  it('micro-explainer: a beat stock cannot film goes to human review after one retry; more than two such beats fail closed', async () => {
    const opts = { rules: rulesFor('MICRO_EXPLAINER', 118), maxAttempts: 3, format: FORMATS.MICRO_EXPLAINER, topic: gapTopic() };
    let calls = 0;
    const one = async (items: Array<{ label: string }>) => {
      calls++;
      return [`${items[0].label} visualSubject "derailed train" matches only 0 stock clip(s) (need 2)`];
    };
    const s = await new ScriptwriterAgent(new MockLLMProvider(), { ...opts, visualPreflight: one }).writeScript(story, research, { previousTitles: [], previousHooks: [] });
    expect(calls).toBe(2);
    expect(s.scenes.every((sc) => sc.beats.length > 0)).toBe(true);

    const many = async (items: Array<{ label: string }>) => items.slice(0, 3).map((it) => `${it.label} visualSubject "x" matches only 0 stock clip(s) (need 2)`);
    await expect(new ScriptwriterAgent(new MockLLMProvider(), { ...opts, visualPreflight: many }).writeScript(story, research, { previousTitles: [], previousHooks: [] })).rejects.toThrow(/script_beats: output failed validation after 3 attempt/);
  });
});

// -----------------------------------------------------------------------------
describe('footage preflight (before any voice credits)', () => {
  const scene = { visualSubject: 'airliner climbing after takeoff', assetKeywords: ['airplane takeoff', 'runway'], visualExclusions: [] as string[] };
  const opts = { minRelevance: 0.3, maxDownloadBytes: 1e9, minCandidates: 3 };
  it('passes when every scene has enough ranked stock candidates', async () => {
    expect(await visualPreflight(new MockAssetProvider(), [scene, scene], opts)).toEqual([]);
  });
  it('reports scenes without usable footage', async () => {
    const v = await visualPreflight(new MockAssetProvider({ empty: true }), [scene], opts);
    expect(v.join()).toMatch(/scene 1 visualSubject "airliner climbing after takeoff" matches only 0 stock clip/);
  });
  it('does not count loosely related clips (regression: "injured crow" passed preflight, then every judge rejected tiger clips)', async () => {
    const loose = {
      name: 'loose',
      search: async () =>
        [1, 2, 3, 4, 5].map((i) => ({
          provider: 'loose', providerMediaId: String(i), mediaType: 'VIDEO' as const, pageUrl: `https://x/${i}`, downloadUrl: `https://x/${i}.mp4`, aspectRatio: 0.5625, commercialUseAllowed: true,
          width: 1080, height: 1920, durationSeconds: 10, tags: ['bird', 'crow', 'tiger', 'water'], description: 'wildlife', license: 'pixabay', attributionRequired: false,
        })),
      download: async () => { throw new Error('not used'); },
    };
    const v = await visualPreflight(loose as never, [{ visualSubject: 'injured crow', assetKeywords: ['crow', 'bird'], visualExclusions: [] }], opts);
    expect(v.join()).toMatch(/matches only 0 stock clip/);
    expect(await visualPreflight(loose as never, [{ visualSubject: 'crow', assetKeywords: ['crow', 'bird'], visualExclusions: [] }], { ...opts, minCandidates: 3 })).toEqual([]);
  });
});

describe('broad b-roll fallback subject', () => {
  it('prefers a single-word keyword, else the head noun shared by subject and keywords, else nothing', () => {
    expect(broadSubject(['airplane', 'clouds sky'], 'airplane with clouds')).toBe('airplane');
    expect(broadSubject(['scattered emus', 'running birds'], 'scattered emus')).toMatch(/^emu/);
    expect(broadSubject(['old ledger', 'ink pen'], 'medieval tax record')).toBeNull();
  });
});

describe('voice credit preflight', () => {
  const cfg = testConfig();
  const script = (): ShortScript =>
    ShortScriptSchema.parse({
      id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Why do planes turn after takeoff', description: 'd', hookText: 'Why do planes turn after takeoff?',
      targetDurationSeconds: 32, totalWords: 30, createdAt: new Date().toISOString(),
      scenes: ['Why do planes turn after takeoff?', 'They follow published departure routes.', 'Routes keep traffic apart and away from towns.'].map((n, i) => ({ sceneNumber: i + 1, narration: n, visualObjective: 'x', assetKeywords: ['plane'] })),
    });
  function meteredTts(remaining: number | null): TTSProvider & { calls: number } {
    const inner = new MockTTSProvider();
    const t = {
      name: 'metered', voiceId: 'v', modelId: `m${randomUUID()}`, settingsKey: 's', calls: 0,
      creditsFor: (text: string) => text.length,
      remainingCredits: async () => (remaining === null ? null : { remaining, limit: 10_000 }),
      synthesize: async (req: { text: string }) => {
        t.calls++;
        return inner.synthesize(req);
      },
    };
    return t;
  }
  const agent = (tts: TTSProvider) =>
    new VoiceAgent(tts, { targetLufs: -14, toleranceLu: 2, minSeconds: 1, maxSeconds: 60, tailSeconds: 0.6, ttsCacheDir: path.join(cfg.outputDir, 'tts'), creditPreflight: true });

  it('refuses to synthesize when the account cannot cover the narration (nothing billed)', async () => {
    const tts = meteredTts(10);
    await expect(agent(tts).generateVoiceover(script(), fs.mkdtempSync(path.join(os.tmpdir(), 'v-')))).rejects.toBeInstanceOf(QuotaExceededError);
    expect(tts.calls).toBe(0);
  });
  it('synthesizes when credits suffice, and when the balance is unknown (restricted key)', async () => {
    for (const remaining of [100_000, null]) {
      const tts = meteredTts(remaining);
      const n = await agent(tts).generateVoiceover(script(), fs.mkdtempSync(path.join(os.tmpdir(), 'v-')));
      expect(n.durationSeconds).toBeGreaterThan(1);
      expect(tts.calls).toBe(1);
    }
  }, 120_000);
  it('ElevenLabs Flash/Turbo models cost half a credit per character; the balance comes from the subscription endpoint', async () => {
    const fetchImpl = (async () => jsonResponse({ character_count: 9_000, character_limit: 100_000, next_character_count_reset_unix: 1_800_000_000 })) as typeof fetch;
    const flash = new ElevenLabsTTSProvider('k', 'v', 'eleven_flash_v2_5', { timeoutMs: 5000, maxAttempts: 1, usdPer1kChars: 0.22, speed: 1.1 }, { fetchImpl });
    const v2 = new ElevenLabsTTSProvider('k', 'v', 'eleven_multilingual_v2', { timeoutMs: 5000, maxAttempts: 1, usdPer1kChars: 0.22, speed: 1.1 }, { fetchImpl });
    expect(flash.creditsFor('x'.repeat(600))).toBe(300);
    expect(v2.creditsFor('x'.repeat(600))).toBe(600);
    expect(await flash.remainingCredits()).toMatchObject({ remaining: 91_000, limit: 100_000 });
    const denied = new ElevenLabsTTSProvider('k', 'v', 'm', { timeoutMs: 5000, maxAttempts: 1, usdPer1kChars: 0.22, speed: 1.1 }, { fetchImpl: (async () => jsonResponse({ detail: 'missing_permissions' }, 401)) as typeof fetch });
    expect(await denied.remainingCredits()).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe('release scheduling', () => {
  it('converts local wall-clock slots to UTC across DST', () => {
    expect(zonedTimeToUtc(2026, 1, 15, 17, 0, 'America/New_York').toISOString()).toBe('2026-01-15T22:00:00.000Z'); // EST
    expect(zonedTimeToUtc(2026, 7, 15, 17, 0, 'America/New_York').toISOString()).toBe('2026-07-15T21:00:00.000Z'); // EDT
  });
  it('picks the next free slot after the lead time, skipping taken slots', () => {
    const now = new Date('2026-07-15T20:45:00Z'); // 16:45 New York
    const slots = ['12:00', '17:00'];
    expect(nextPublishSlot(now, slots, 'America/New_York', []).toISOString()).toBe('2026-07-16T16:00:00.000Z'); // 17:00 today is < 30 min away
    const taken = [new Date('2026-07-16T16:00:00Z')];
    expect(nextPublishSlot(now, slots, 'America/New_York', taken).toISOString()).toBe('2026-07-16T21:00:00.000Z');
  });
});

describe('YouTube connection helpers', () => {
  it('builds a PKCE consent URL with upload, readonly and analytics scopes (offline access)', () => {
    const u = new URL(buildConsentUrl({ clientId: 'cid', clientSecret: 's' }, 'http://127.0.0.1:5555/callback', 'st', 'chal'));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('scope')).toMatch(/youtube\.upload.*youtube\.readonly.*yt-analytics\.readonly/);
    expect(u.toString()).not.toMatch(/client_secret|=s&/);
  });
  it('writes the refresh token into .env without disturbing other variables', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env');
    fs.writeFileSync(f, 'A=1\nYOUTUBE_REFRESH_TOKEN=old\nB=2\n');
    upsertEnvVar(f, 'YOUTUBE_REFRESH_TOKEN', 'new$&token');
    expect(fs.readFileSync(f, 'utf-8')).toBe('A=1\nYOUTUBE_REFRESH_TOKEN=new$&token\nB=2\n');
    upsertEnvVar(f, 'C', '3');
    expect(fs.readFileSync(f, 'utf-8').endsWith('C=3\n')).toBe(true);
    expect(() => upsertEnvVar(f, 'C', 'a\nD=1')).toThrow();
  });
});

// -----------------------------------------------------------------------------
describe('YouTube Analytics client', () => {
  const tokenOk = () => jsonResponse({ access_token: 'at' });
  it('maps report columns per video, reports missing videos as zero, and falls back when engagedViews is rejected', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('oauth2')) return tokenOk();
      if (u.includes('engagedViews')) return jsonResponse({ error: { message: 'Unknown identifier (engagedViews)' } }, 400);
      return jsonResponse({
        columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'likes' }, { name: 'averageViewPercentage' }],
        rows: [['vid1', 1200, 40, 71.5]],
      });
    }) as typeof fetch;
    const c = new YouTubeAnalyticsClient({ clientId: 'c', clientSecret: 's' }, 'r', fetchImpl);
    const m = await c.videoMetrics(['vid1', 'vid2'], '2026-10-01', '2026-10-10');
    expect(m.find((x) => x.videoId === 'vid1')).toMatchObject({ views: 1200, likes: 40, averageViewPercentage: 71.5, source: 'analytics_api' });
    expect(m.find((x) => x.videoId === 'vid2')).toMatchObject({ views: 0 });
    expect(calls.filter((u) => u.includes('youtubeanalytics')).length).toBe(2);
  });
});

describe('performance analysis', () => {
  const row = (i: number, format: PerformanceRow['format'], cluster: string, views: number): PerformanceRow => ({
    videoId: `v${i}`, title: `Short ${i}`, format, cluster, pillar: 'ENGINEERING', words: 70, durationSeconds: 32, hookWords: 7, gapScore: 90,
    publishHour: 17, ageHours: 96, views, engagedViews: Math.round(views * 0.6), averageViewPercentage: 55, likes: 10, subscribersGained: 1,
  });
  it('refuses to draw conclusions from too few Shorts', () => {
    const r = analyzePerformance([row(1, 'QUESTION_ANSWER', 'aviation', 1000)]);
    expect(r.recommendations[0]).toMatch(/too few to compare/);
    expect(r.formatWeights).toEqual({});
  });
  it('ignores Shorts younger than the minimum age', () => {
    const young = { ...row(1, 'STORY', 'x', 50), ageHours: 3 };
    expect(analyzePerformance([young]).videos).toBe(0);
  });
  it('ranks formats and clusters and derives bounded format weights', () => {
    const rows = [
      ...[1, 2, 3].map((i) => row(i, 'QUESTION_ANSWER', 'aviation', 40_000)),
      ...[4, 5, 6].map((i) => row(i, 'THREE_REASONS', 'maritime', 2_000)),
    ];
    const r = analyzePerformance(rows);
    expect(r.byFormat[0].key).toBe('QUESTION_ANSWER');
    expect(r.formatWeights.QUESTION_ANSWER!).toBeGreaterThan(0);
    expect(r.formatWeights.THREE_REASONS!).toBeLessThan(0);
    for (const w of Object.values(r.formatWeights)) expect(Math.abs(w!)).toBeLessThanOrEqual(3);
    expect(r.recommendations.join(' ')).toMatch(/aviation/);
    expect(renderPerformanceReport(r)).toMatch(/\| QUESTION_ANSWER \| 3 \|/);
  });
});

// -----------------------------------------------------------------------------
describe('database migration', () => {
  it('upgrades a v2 database in place to v3 (adds video_metrics), keeping data', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'db.sqlite');
    const cfg = testConfig({ SQLITE_DB_PATH: file });
    const repo = new ShortsRepository(createDatabase(cfg));
    await repo.init();
    await repo.db.execute(`UPDATE schema_meta SET value = '2' WHERE key = 'version'`);
    await repo.db.execute(`DROP TABLE video_metrics`);
    await repo.saveTopic({ ...gapTopic(), status: 'SCORED' });
    await repo.db.close();
    const again = new ShortsRepository(createDatabase(cfg));
    await again.init();
    expect(await again.db.query(`SELECT value FROM schema_meta WHERE key = 'version'`)).toEqual([{ value: '3' }]);
    expect(await again.listTopics('SCORED')).toHaveLength(1);
    expect(await again.latestVideoMetrics()).toEqual([]);
    await again.db.close();
  });
});

// -----------------------------------------------------------------------------
describe('end to end (mock providers): gap topic → micro-explainer → publish → analytics', () => {
  it('produces a micro-explainer Short from a measured gap topic and learns from its metrics', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'auto' });
    const repo = await memoryRepo(cfg);
    const bundle = createProviders(cfg, 'mock');
    const runner = new PipelineRunner(cfg, repo, { ...bundle, publisher: { ...bundle.publisher, name: 'fake-youtube', target: 'youtube', publish: async () => ({ externalId: 'yt123', url: 'https://youtube.com/shorts/yt123' }) } });
    const job = await runner.createJob();
    const waiting = await runner.run(job.id);
    expect(waiting.state).toBe('AWAITING_FINAL_APPROVAL');
    const topic = (await repo.getTopic(waiting.artifacts.topicId!))!;
    expect(topic.gap?.score).toBeGreaterThanOrEqual(cfg.GAP_MIN_SCORE);
    const script = await repo.requireArtifact(waiting.artifacts.scriptId, 'script', ShortScriptSchema);
    // Default production format (reference-analysis REPORT §2): micro-explainer with a statement hook.
    expect(script.format).toBe('MICRO_EXPLAINER');
    expect(script.hookType).toBe('statement');
    expect(script.hookText.endsWith('?')).toBe(false);
    expect(script.scenes.every((sc) => sc.beats.length > 0)).toBe(true);

    const digest = await runner.reviewDigest(job.id);
    expect(digest.voiceCredits).toBeGreaterThan(0);
    expect(digest.video).toMatch(/short\.mp4$/);

    await runner.approve(job.id, 'FINAL_VIDEO', 'APPROVED');
    expect((await runner.run(job.id)).state).toBe('PUBLISHED');
    const pub = (await repo.getPublishForJob(job.id))!;
    expect(pub.metadata).toMatchObject({ containsSyntheticMedia: true, categoryId: '27' });

    const sync = await runner.syncAnalytics(); // no OAuth configured → public counters (mock signals)
    expect(sync).toMatchObject({ measured: 1, source: 'public' });
    const rows = await runner.performanceRows();
    expect(rows[0]).toMatchObject({ videoId: 'yt123', format: script.format, cluster: topic.gap!.cluster, views: 1000 });
    const rep = await runner.analyticsReport();
    expect(fs.existsSync(rep.path)).toBe(true);
  }, 600_000);
});

describe('footage rework from final review (no new narration cost)', () => {
  it('re-sources only the listed scenes with different clips and keeps the paid narration', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'auto' });
    const repo = await memoryRepo(cfg);
    const runner = new PipelineRunner(cfg, repo, createProviders(cfg, 'mock'));
    const job = await runner.createJob();
    const first = await runner.run(job.id);
    expect(first.state).toBe('AWAITING_FINAL_APPROVAL');
    const before = await Promise.all(first.artifacts.assetIds!.map((id) => repo.requireArtifact(id, 'asset', AssetDescriptorSchema)));
    const scene1Before = before.filter((a) => a.sceneNumber === 1).map((a) => `${a.provider}:${a.providerAssetId}`);

    const reworking = await runner.approve(job.id, 'FINAL_VIDEO', 'REVISIONS_REQUESTED', 'scenes: 1 — wrong subject');
    expect(reworking.state).toBe('SOURCING_MEDIA');
    expect(reworking.artifacts.excludedMediaKeys).toEqual(scene1Before);
    expect(reworking.artifacts.narrationId).toBe(first.artifacts.narrationId);

    const again = await runner.run(job.id);
    expect(again.state).toBe('AWAITING_FINAL_APPROVAL');
    expect(again.artifacts.narrationId).toBe(first.artifacts.narrationId);
    const after = await Promise.all(again.artifacts.assetIds!.map((id) => repo.requireArtifact(id, 'asset', AssetDescriptorSchema)));
    for (const a of after.filter((x) => x.sceneNumber === 1)) expect(scene1Before).not.toContain(`${a.provider}:${a.providerAssetId}`);
    await expect(runner.approve(job.id, 'IDEA', 'REVISIONS_REQUESTED')).rejects.toThrow();
  }, 600_000);
});
