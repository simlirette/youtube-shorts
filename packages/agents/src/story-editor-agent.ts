import { TopicCandidate, ResearchPacket, StoryOutline } from '@shorts/schemas';
import { LLMProvider } from '@shorts/providers';
import { ShortsRepository, ContentStateMachine, logger } from '@shorts/core';

export class StoryEditorAgent {
  constructor(
    private llm: LLMProvider,
    private repo: ShortsRepository
  ) {}

  async developStory(topic: TopicCandidate, research: ResearchPacket): Promise<StoryOutline> {
    logger.info(`Developing narrative structure for: "${topic.title}"`, {
      stage: 'STORY',
      topicId: topic.id,
    });

    const story = await this.llm.developStory(topic, research);
    await this.repo.saveStory(story);

    ContentStateMachine.transition('RESEARCHED', 'STORY_READY', { topicId: topic.id });
    topic.state = 'STORY_READY';
    await this.repo.updateTopicState(topic.id, 'STORY_READY');

    logger.info(`Story outline constructed: "${story.logline}"`, {
      stage: 'STORY',
      topicId: topic.id,
      storyId: story.id,
    });

    return story;
  }
}
