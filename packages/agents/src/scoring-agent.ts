import { TopicCandidate, TopicScore } from '@shorts/schemas';
import { LLMProvider } from '@shorts/providers';
import { ShortsRepository, ContentStateMachine, logger } from '@shorts/core';

export class ScoringAgent {
  constructor(
    private llm: LLMProvider,
    private repo: ShortsRepository
  ) {}

  async scoreTopic(topic: TopicCandidate): Promise<TopicScore> {
    logger.info(`Evaluating topic suitability: "${topic.title}"`, {
      stage: 'SCORING',
      topicId: topic.id,
    });

    const score = await this.llm.scoreTopic(topic);
    await this.repo.saveTopicScore(score);

    // Update state to SCORED
    const transition = ContentStateMachine.transition(topic.state, 'SCORED', { topicId: topic.id });
    if (transition.success) {
      topic.state = 'SCORED';
      await this.repo.updateTopicState(topic.id, 'SCORED');
    }

    logger.info(`Topic scored: ${score.overallScore}/100 (Pass: ${score.passGate ? 'YES' : 'NO'})`, {
      stage: 'SCORING',
      topicId: topic.id,
      overallScore: score.overallScore,
      reasoning: score.reasoning,
    });

    return score;
  }
}
