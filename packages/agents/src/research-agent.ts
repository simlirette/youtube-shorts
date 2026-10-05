import { TopicCandidate, ResearchPacket } from '@shorts/schemas';
import { LLMProvider, SearchProvider } from '@shorts/providers';
import { ShortsRepository, ContentStateMachine, logger } from '@shorts/core';

export class ResearchAgent {
  constructor(
    private llm: LLMProvider,
    private search: SearchProvider,
    private repo: ShortsRepository
  ) {}

  async conductResearch(topic: TopicCandidate): Promise<ResearchPacket> {
    logger.info(`Initiating deep research for topic: "${topic.title}"`, {
      stage: 'RESEARCH',
      topicId: topic.id,
    });

    // Advance state to RESEARCHING
    ContentStateMachine.transition(topic.state, 'RESEARCHING', { topicId: topic.id });
    await this.repo.updateTopicState(topic.id, 'RESEARCHING');

    // Run web search for authoritative sources
    const searchResults = await this.search.search(topic.title, 3);
    logger.debug(`Found ${searchResults.length} search references for topic`, {
      stage: 'RESEARCH',
      sources: searchResults.map((s) => s.url),
    });

    // Extract claims and sources through LLM
    const packet = await this.llm.conductResearch(topic);
    await this.repo.saveResearchPacket(packet);

    // Advance state to RESEARCHED
    ContentStateMachine.transition('RESEARCHING', 'RESEARCHED', { topicId: topic.id });
    topic.state = 'RESEARCHED';
    await this.repo.updateTopicState(topic.id, 'RESEARCHED');

    logger.info(`Research complete: extracted ${packet.claims.length} claims across ${packet.sources.length} sources.`, {
      stage: 'RESEARCH',
      topicId: topic.id,
      claimsCount: packet.claims.length,
    });

    return packet;
  }
}
