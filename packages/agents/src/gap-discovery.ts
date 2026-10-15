import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ContentPillarSchema, GapEvidence, TopicCandidate, TopicScore } from '@shorts/schemas';
import type { LLMProvider, SignalsProvider, VideoSignal } from '@shorts/providers';
import { ShortsRepository, dedupeKey, logger, significantTokens } from '@shorts/core';
import { isNearDuplicate } from './discovery-agent.js';

export interface GapSeed {
  cluster: string;
  seed: string;
}

export interface GapDiscoveryOptions {
  seeds: GapSeed[];
  minScore: number;
  /** Questions probed against YouTube search per run (each probe is one free search). */
  maxProbes: number;
  /** Autocomplete expansions per seed: seed alone plus seed + each letter. */
  letters?: string;
  /** Polite delay between autocomplete requests. */
  delayMs?: number;
}

export interface GapProbe {
  question: string;
  cluster: string;
  evidence: GapEvidence | null;
  outcome: 'TOPIC' | 'BELOW_THRESHOLD' | 'DUPLICATE' | 'PROBE_FAILED';
  note?: string;
}

export interface GapDiscoveryResult {
  topics: TopicCandidate[];
  probes: GapProbe[];
  /** Questions dropped before probing, with the reason (heuristics or triage). */
  dropped: Array<{ question: string; reason: string }>;
  suggestionsSeen: number;
}

export function parseGapSeeds(spec: string): GapSeed[] {
  return spec
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(':');
      return { cluster: p.slice(0, i).trim(), seed: p.slice(i + 1).trim().toLowerCase() };
    });
}

const QUESTION_START = /^(why|how|what|who|when|where|is|are|do|does|can|could|would)\b/;
/** Entertainment, games, music and meme queries are not documentary questions. */
const OFF_TOPIC = /\b(lyrics|song|songs|meme|memes|minecraft|roblox|fortnite|gta|pokemon|anime|cg5|tiktok|prank|asmr|cartoon|movie|episode|season|game|games|gameplay|fnaf|skibidi|reaction|funny|vs|edit)\b/;

/** Cheap deterministic filter applied before any model call. */
export function questionHeuristics(q: string): string | null {
  const words = q.trim().split(/\s+/);
  if (!QUESTION_START.test(q)) return 'not a question';
  if (words.length < 4) return 'too short to be specific';
  if (words.length > 14) return 'too long';
  const off = q.match(OFF_TOPIC);
  if (off) return `entertainment/off-topic term "${off[0]}"`;
  return null;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Deterministic gap score (0-100). Demand = the most-viewed long-form answer (10k views → 0,
 * 10M → 1). Supply = the most-viewed existing Short (1k → 0, 1M → 1) and how many Shorts already
 * have ≥10k views. A question with big long-form demand and no successful Short scores high.
 */
export function gapScore(e: Pick<GapEvidence, 'longformTopViews' | 'bestShortViews' | 'shortsAbove10k' | 'suggestRank'>): number {
  const demand = clamp01((Math.log10(e.longformTopViews + 1) - 4) / 3);
  const supply = clamp01((Math.log10(e.bestShortViews + 1) - 3) / 3);
  const competition = Math.min(1, e.shortsAbove10k / 3);
  const rankBonus = 0.1 * (1 - Math.min(e.suggestRank, 9) / 9);
  const raw = demand * (1 - 0.6 * supply) * (1 - 0.3 * competition) + rankBonus * demand;
  return Math.round(clamp01(raw) * 1000) / 10;
}

/** Turns search results into demand/supply evidence. Shorts = videos of at most 65 seconds. */
/**
 * A result answers the question only if its title covers at least half of the question's
 * significant words (live: an unrelated 110M-view video inflated "why is it illegal to own a crow").
 */
export function answersQuestion(question: string, title: string): boolean {
  const q = significantTokens(question);
  if (q.length === 0) return false;
  const t = new Set(significantTokens(title));
  return q.filter((w) => t.has(w)).length / q.length >= 0.5;
}

export function measureGap(question: string, seed: GapSeed, suggestRank: number, all: VideoSignal[]): GapEvidence {
  const results = all.filter((r) => answersQuestion(question, r.title));
  const shorts = results.filter((r) => r.durationSeconds !== null && r.durationSeconds <= 65);
  const longform = results.filter((r) => r.durationSeconds === null || r.durationSeconds > 65);
  const views = (r: VideoSignal) => r.views ?? 0;
  const base = {
    question,
    seed: seed.seed,
    cluster: seed.cluster,
    suggestRank,
    longformTopViews: Math.max(0, ...longform.map(views)),
    shortsInResults: shorts.length,
    shortsAbove10k: shorts.filter((s) => views(s) >= 10_000).length,
    bestShortViews: Math.max(0, ...shorts.map(views)),
    measuredAt: new Date().toISOString(),
  };
  return { ...base, score: gapScore(base) };
}

/** Topic score derived from measured gap evidence (no model judgment involved). */
export function gapTopicScore(topic: TopicCandidate, minScore: number): TopicScore {
  const g = topic.gap!;
  const demand = clamp01((Math.log10(g.longformTopViews + 1) - 4) / 3);
  const supply = clamp01((Math.log10(g.bestShortViews + 1) - 3) / 3);
  const d10 = (x: number) => Math.round(x * 100) / 10;
  const passGate = g.score >= minScore;
  return {
    id: randomUUID(),
    topicId: topic.id,
    curiosity: d10(demand),
    audiencePotential: d10(demand),
    originality: d10(1 - supply),
    storyDepth: 5,
    visualPotential: 7,
    sourceAvailability: 7,
    freshness: 5,
    productionComplexity: 3,
    copyrightRisk: 1,
    repetitionRisk: d10(Math.min(1, g.shortsAbove10k / 3)),
    monetizationRisk: 2,
    overallScore: g.score,
    reasoning: `gap score ${g.score}: long-form demand ${g.longformTopViews.toLocaleString('en-US')} views; best existing Short ${g.bestShortViews.toLocaleString('en-US')} views; ${g.shortsAbove10k} Short(s) ≥10k in top results`,
    passGate,
    gateReasons: passGate ? [] : [`gap score ${g.score} < ${minScore}`],
    scoredAt: new Date().toISOString(),
  };
}

const TriageSchema = z.object({
  items: z.array(
    z.object({
      ref: z.string(),
      keep: z.boolean(),
      reason: z.string().default(''),
      // Rejected items often come back with an empty pillar; it is irrelevant for them.
      pillar: ContentPillarSchema.catch('ENGINEERING'),
      angle: z.string().default(''),
    })
  ),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const titleCase = (q: string) => {
  const s = q.trim().replace(/\s+/g, ' ').replace(/[?.!]+$/, '');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}?`;
};

/**
 * Finds real viewer questions that are in demand but not yet answered well as Shorts:
 * 1. YouTube autocomplete expansions of question seeds (what people actually type)
 * 2. deterministic filters + one batched model triage (evergreen, factual, filmable, not sensitive)
 * 3. YouTube search per question: long-form demand vs existing Shorts supply → gap score
 */
export class GapDiscoveryAgent {
  constructor(
    private readonly signals: SignalsProvider,
    private readonly llm: LLMProvider,
    private readonly repo: ShortsRepository,
    private readonly opts: GapDiscoveryOptions
  ) {}

  async discover(): Promise<GapDiscoveryResult> {
    const letters = this.opts.letters ?? ' abcdefghijklmnopqrstuvwxyz';
    const dropped: GapDiscoveryResult['dropped'] = [];
    const found = new Map<string, { q: string; seed: GapSeed; rank: number }>();
    let seen = 0;
    for (const seed of this.opts.seeds) {
      for (const l of letters) {
        const prefix = l === ' ' ? seed.seed : `${seed.seed} ${l}`;
        let list: string[] = [];
        try {
          list = await this.signals.suggest(prefix);
        } catch (e) {
          logger.warn(`autocomplete failed for "${prefix}": ${(e as Error).message}`, { stage: 'DISCOVERY' });
        }
        seen += list.length;
        list.forEach((raw, rank) => {
          const q = raw.trim().toLowerCase();
          if (!q.startsWith(seed.seed.split(' ')[0])) return;
          const prev = found.get(q);
          if (!prev || prev.rank > rank) found.set(q, { q, seed, rank });
        });
        if (this.opts.delayMs) await sleep(this.opts.delayMs);
      }
    }

    // Deterministic filters and de-duplication (against each other and every known topic).
    const known = (await this.repo.listTopics(undefined, 2000)).map((t) => t.gap?.question ?? t.title);
    const kept: Array<{ q: string; seed: GapSeed; rank: number }> = [];
    for (const c of [...found.values()].sort((a, b) => a.rank - b.rank)) {
      const why = questionHeuristics(c.q);
      if (why) {
        dropped.push({ question: c.q, reason: why });
        continue;
      }
      const dup = [...known, ...kept.map((k) => k.q)].find((k) => isNearDuplicate(k, c.q));
      if (dup) {
        dropped.push({ question: c.q, reason: `near-duplicate of "${dup}"` });
        continue;
      }
      kept.push(c);
    }
    if (kept.length === 0) return { topics: [], probes: [], dropped, suggestionsSeen: seen };

    // Batched triage (20 per call keeps the model from skipping items): evergreen, factual, filmable, not sensitive.
    const accepted: Array<{ q: string; seed: GapSeed; rank: number; pillar: TopicCandidate['pillar']; angle: string }> = [];
    const pool = kept.slice(0, 80);
    for (let off = 0; off < pool.length; off += 20) {
      const batch = pool.slice(off, off + 20);
      const triage = await this.llm.generateStructured({
      task: 'gap_triage',
      system: 'You select questions for a fact-checked documentary Shorts channel that uses generic stock footage and a narrator.',
      prompt: `For each viewer question decide keep=true only if ALL hold:
- evergreen and factual: it has one well-established answer in reliable public sources (engineering, physics, aviation, maritime, geography, law, nature, history of technology);
- illustratable with generic stock footage (planes, ships, bridges, cities, nature) — no specific people, brands' ads, maps or diagrams needed;
- not about a specific living person, celebrity, influencer, game, film, fiction or franchise;
- not current news, politics, war, religion, health/medical or financial advice, or a tragedy from the last 10 years.
Also give: pillar (one of ${ContentPillarSchema.options.join(', ')}), and "angle": one sentence stating what the answer explains (no facts you are unsure of).

${batch.map((c, i) => `[Q${i + 1}] ${c.q}`).join('\n')}

Return exactly ${batch.length} items — one for EVERY question Q1..Q${batch.length}, in order, including the ones you reject (keep=false).`,
      schemaHint: '{"items":[{"ref":"Q1","keep":true,"reason":"string","pillar":"ENGINEERING","angle":"string"}]}',
      schema: TriageSchema,
      validate: (v) => {
        const refs = new Set(v.items.map((x) => x.ref));
        const missing = batch.map((_, i) => `Q${i + 1}`).filter((r) => !refs.has(r));
        return missing.length ? [`missing decisions for ${missing.slice(0, 10).join(', ')}`] : [];
      },
      temperature: 0,
      maxTokens: 3000,
      maxValidationAttempts: 3,
      });
      const decision = new Map(triage.content.items.map((x) => [x.ref, x]));
      batch.forEach((c, i) => {
        const d = decision.get(`Q${i + 1}`);
        if (!d?.keep) dropped.push({ question: c.q, reason: `triage: ${d?.reason || 'not kept'}` });
        else accepted.push({ ...c, pillar: d.pillar, angle: d.angle });
      });
    }

    // Probe the most-searched questions first, round-robin across clusters for variety.
    const byCluster = new Map<string, typeof accepted>();
    for (const a of accepted) byCluster.set(a.seed.cluster, [...(byCluster.get(a.seed.cluster) ?? []), a]);
    const order: typeof accepted = [];
    while (order.length < accepted.length) for (const list of byCluster.values()) if (list.length) order.push(list.shift()!);

    const probes: GapProbe[] = [];
    const topics: TopicCandidate[] = [];
    for (const a of order.slice(0, this.opts.maxProbes)) {
      let evidence: GapEvidence;
      try {
        evidence = measureGap(a.q, a.seed, a.rank, await this.signals.searchVideos(a.q, 20));
      } catch (e) {
        probes.push({ question: a.q, cluster: a.seed.cluster, evidence: null, outcome: 'PROBE_FAILED', note: (e as Error).message.slice(0, 200) });
        continue;
      }
      if (evidence.score < this.opts.minScore) {
        probes.push({ question: a.q, cluster: a.seed.cluster, evidence, outcome: 'BELOW_THRESHOLD' });
        continue;
      }
      const title = titleCase(a.q).slice(0, 140);
      const topic: TopicCandidate = {
        id: randomUUID(),
        title,
        premise: a.angle.length >= 10 ? a.angle : `Answers the viewer question: ${title}`,
        pillar: a.pillar,
        sourceUrls: [],
        tags: [`cluster:${a.seed.cluster}`, 'gap'],
        status: 'SCORED',
        discoveredAt: new Date().toISOString(),
        dedupeKey: dedupeKey(title),
        gap: evidence,
      };
      await this.repo.saveTopic(topic);
      await this.repo.saveTopicScore(gapTopicScore(topic, this.opts.minScore));
      topics.push(topic);
      probes.push({ question: a.q, cluster: a.seed.cluster, evidence, outcome: 'TOPIC' });
    }
    logger.info(`Gap discovery: ${seen} suggestions → ${kept.length} after filters → ${accepted.length} after triage → ${probes.length} probed → ${topics.length} topic(s)`, { stage: 'DISCOVERY' });
    return { topics, probes, dropped, suggestionsSeen: seen };
  }
}
