import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CONTENT_PILLARS, ContentPillar, ContentPillarSchema, TopicCandidate, TopicCandidateSchema } from '@shorts/schemas';
import type { LLMProvider } from '@shorts/providers';
import { ShortsRepository, ValidationError, countWords, dedupeKey, logger, overlapCoefficient, significantTokens } from '@shorts/core';

const DiscoveryOutputSchema = z.object({
  topics: z.array(
    z.object({
      title: z.string().min(5).max(100),
      premise: z.string().min(20).max(500),
      pillar: ContentPillarSchema,
      tags: z.array(z.string()).max(8).default([]),
    })
  ),
});

export interface DiscoveryRejection {
  title: string;
  reason: string;
}

export interface DiscoveryResult {
  requested: number;
  topics: TopicCandidate[];
  rejected: DiscoveryRejection[];
  /** requested - topics.length; > 0 means fewer novel topics were available than requested. */
  shortfall: number;
}

const CLICKBAIT = /(you won['’]?t believe|shocking|mind[- ]blowing|insane|top \d+|\d+ (things|facts|reasons))/i;

/** True when two titles describe the same subject (high token overlap with ≥2 shared tokens). */
export function isNearDuplicate(a: string, b: string): boolean {
  const ta = significantTokens(a);
  const tb = significantTokens(b);
  const shared = new Set(ta.filter((t) => tb.includes(t))).size;
  return dedupeKey(a) === dedupeKey(b) || (shared >= 2 && overlapCoefficient(ta, tb) >= 0.6);
}

export class DiscoveryAgent {
  constructor(
    private readonly llm: LLMProvider,
    private readonly repo: ShortsRepository,
    private readonly opts: { recentTopicLimit: number }
  ) {}

  /**
   * Requests `count` topics (plus headroom for dedupe), validates them, and persists only novel,
   * well-formed ones. Never silently returns fewer than requested: `shortfall` is explicit.
   */
  async discoverTopics(pillar: ContentPillar | undefined, count: number): Promise<DiscoveryResult> {
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new ValidationError('discovery count must be an integer from 1 to 10');
    const history = await this.repo.listTopics(undefined, this.opts.recentTopicLimit);
    const ask = count + 2;

    const prompt = [
      `Propose EXACTLY ${ask} original documentary-style YouTube Short topics${pillar ? ` in the content pillar "${pillar}"` : ''}.`,
      'Each topic must be a specific, verifiable real-world event, decision, failure or discovery with a clear conflict and resolution,',
      'well documented by reputable public sources. The story must be CONCLUDED with a known, documented outcome:',
      'no announced, planned, proposed or ongoing projects, no predictions. Avoid listicles, rumors, ongoing legal disputes, tragedies involving recent deaths, and clickbait phrasing.',
      `Allowed pillar values: ${CONTENT_PILLARS.join(', ')}.`,
      history.length
        ? `ALREADY USED OR PROPOSED TOPICS — do not propose these subjects again, even with different wording:\n${history.map((t) => `- ${t.title}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const res = await this.llm.generateStructured({
      task: 'discovery',
      system: 'You are a documentary story scout. You only propose true, well-documented stories.',
      prompt,
      schemaHint: `{"topics":[{"title":"string (5-100 chars)","premise":"2-3 sentence synopsis","pillar":"${CONTENT_PILLARS.join('|')}","tags":["string"]}]}`,
      schema: DiscoveryOutputSchema,
      validate: (v) => (v.topics.length === ask ? [] : [`returned ${v.topics.length} topics; exactly ${ask} are required`]),
      temperature: 0.9,
      maxTokens: 1500,
    });

    const accepted: TopicCandidate[] = [];
    const rejected: DiscoveryRejection[] = [];
    for (const raw of res.content.topics) {
      const title = raw.title.trim();
      let reason: string | null = null;
      if (pillar && raw.pillar !== pillar) reason = `pillar ${raw.pillar} does not match requested ${pillar}`;
      else if (countWords(title) < 3 || countWords(title) > 14) reason = 'title must be 3-14 words';
      else if (countWords(raw.premise) < 8) reason = 'premise too short';
      else if (CLICKBAIT.test(title)) reason = 'clickbait phrasing';
      else if (significantTokens(title).length < 2) reason = 'title has too little specific content';
      else {
        const dupHistory = history.find((h) => isNearDuplicate(h.title, title));
        const dupBatch = accepted.find((a) => isNearDuplicate(a.title, title));
        if (dupHistory) reason = `duplicate of existing topic "${dupHistory.title}"`;
        else if (dupBatch) reason = `duplicate of "${dupBatch.title}" in the same batch`;
      }
      if (reason) {
        rejected.push({ title, reason });
        continue;
      }
      if (accepted.length >= count) continue;
      const topic = TopicCandidateSchema.parse({
        id: randomUUID(),
        title,
        premise: raw.premise.trim(),
        pillar: raw.pillar,
        tags: raw.tags,
        status: 'DISCOVERED',
        dedupeKey: dedupeKey(title),
        discoveredAt: new Date().toISOString(),
      });
      await this.repo.saveTopic(topic);
      accepted.push(topic);
    }

    const result: DiscoveryResult = { requested: count, topics: accepted, rejected, shortfall: count - accepted.length };
    logger.info(`Discovery: ${accepted.length}/${count} novel topic(s) stored, ${rejected.length} rejected`, {
      stage: 'DISCOVERY',
      shortfall: result.shortfall,
      rejected: rejected.slice(0, 10),
    });
    return result;
  }
}
