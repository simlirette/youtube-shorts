import { createHash } from 'node:crypto';
import { TopicCandidate, ContentPillar } from '@shorts/schemas';
import { LLMProvider } from '@shorts/providers';
import { ShortsRepository, logger } from '@shorts/core';

export class DiscoveryAgent {
  constructor(
    private llm: LLMProvider,
    private repo: ShortsRepository
  ) {}

  private generateSimilarityHash(title: string): string {
    // Normalize string: lowercase, remove non-alphanumeric, extract key bigrams/words
    const normalized = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    return createHash('md5').update(normalized).digest('hex');
  }

  async discoverTopics(pillar?: ContentPillar, count = 3): Promise<TopicCandidate[]> {
    logger.info(`Starting topic discovery for pillar: ${pillar || 'ALL'} (count: ${count})`, {
      stage: 'DISCOVERY',
    });

    const candidates = await this.llm.generateTopicCandidates(pillar, count);
    const existingTopics = await this.repo.listTopics();
    const existingHashes = new Set(
      existingTopics.map((t) => t.similarityHash || this.generateSimilarityHash(t.title))
    );

    const novelTopics: TopicCandidate[] = [];

    for (const candidate of candidates) {
      const hash = this.generateSimilarityHash(candidate.title);
      if (existingHashes.has(hash)) {
        logger.warn(`Duplicate/near-duplicate topic rejected: "${candidate.title}"`, {
          stage: 'DISCOVERY',
          hash,
        });
        continue;
      }

      candidate.similarityHash = hash;
      novelTopics.push(candidate);
      await this.repo.saveTopic(candidate);
      existingHashes.add(hash);
    }

    logger.info(`Discovery complete. Stored ${novelTopics.length} novel topic candidate(s).`, {
      stage: 'DISCOVERY',
      novelCount: novelTopics.length,
    });

    return novelTopics;
  }
}
