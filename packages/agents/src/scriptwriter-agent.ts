import { StoryOutline, ResearchPacket, ShortScript, ShortScriptSchema } from '@shorts/schemas';
import { LLMProvider } from '@shorts/providers';
import { ShortsRepository, ContentStateMachine, ProvenanceTracker, logger } from '@shorts/core';

export class ScriptwriterAgent {
  constructor(
    private llm: LLMProvider,
    private repo: ShortsRepository
  ) {}

  async writeScript(story: StoryOutline, research: ResearchPacket): Promise<ShortScript> {
    logger.info(`Synthesizing scene script for story: "${story.logline.slice(0, 50)}..."`, {
      stage: 'SCRIPT',
      storyId: story.id,
    });

    // Advance state to SCRIPTING
    ContentStateMachine.transition('STORY_READY', 'SCRIPTING', { scriptId: story.id });
    await this.repo.updateTopicState(story.topicId, 'SCRIPTING');

    const rawScript = await this.llm.writeScript(story, research);

    // Validate runtime schema
    const parseResult = ShortScriptSchema.safeParse(rawScript);
    if (!parseResult.success) {
      logger.error('Scriptwriter output failed schema validation', parseResult.error.format(), {
        stage: 'SCRIPT',
      });
      throw new Error(`Invalid script generated: ${JSON.stringify(parseResult.error.format())}`);
    }

    const script = parseResult.data;

    // Verify claim provenance
    const provenanceResult = ProvenanceTracker.verifyScriptClaims(script, research);
    if (!provenanceResult.valid) {
      logger.warn('Generated script contains claims missing from research provenance', {
        stage: 'SCRIPT',
        unverified: provenanceResult.unverifiedClaims,
      });
    }

    // Persist script and scenes
    await this.repo.saveScript(script);

    // Advance state to SCRIPT_REVIEW
    ContentStateMachine.transition('SCRIPTING', 'SCRIPT_REVIEW', { scriptId: script.id });
    await this.repo.updateTopicState(story.topicId, 'SCRIPT_REVIEW');

    logger.info(`Generated ${script.scenes.length} scenes (${script.totalWords} words, ~${script.estimatedDurationSeconds}s)`, {
      stage: 'SCRIPT',
      scriptId: script.id,
      title: script.title,
    });

    return script;
  }
}
