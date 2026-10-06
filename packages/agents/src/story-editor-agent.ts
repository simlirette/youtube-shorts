import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ResearchPacket, StoryOutline, StoryOutlineSchema, TopicCandidate } from '@shorts/schemas';
import type { LLMProvider } from '@shorts/providers';
import { ValidationError } from '@shorts/core';

const StoryOutputSchema = z.object({
  logline: z.string().min(10),
  centralConflict: z.string().min(5),
  hookConcept: z.string().min(5),
  narrativeArc: z.object({
    hook: z.string().min(5),
    context: z.string().min(5),
    development: z.string().min(5),
    twist: z.string().min(5),
    payoff: z.string().min(5),
  }),
});

export class StoryEditorAgent {
  constructor(private readonly llm: LLMProvider) {}

  /** Outlines the narrative using verified claims only. No placeholder beats are ever substituted. */
  async developStory(topic: TopicCandidate, research: ResearchPacket, directorNotes?: string): Promise<StoryOutline> {
    const verified = research.claims.filter((c) => c.verificationStatus === 'VERIFIED');
    if (verified.length === 0) throw new ValidationError('Cannot develop a story without verified claims');
    const res = await this.llm.generateStructured({
      task: 'story',
      system: 'You are a short-form documentary story editor. You build tension without exaggeration and never add facts.',
      prompt: `Outline a ~45-second documentary YouTube Short.

Topic: ${JSON.stringify(topic.title)}
Summary: ${JSON.stringify(research.summary)}

VERIFIED FACTS (the only facts you may use):
${verified.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}
${directorNotes ? `\nDIRECTOR NOTES: ${directorNotes}\n` : ''}
Structure: hook (first 2 seconds, a question or striking statement), context, development, twist, payoff.`,
      schemaHint: '{"logline":"string","centralConflict":"string","hookConcept":"string","narrativeArc":{"hook":"string","context":"string","development":"string","twist":"string","payoff":"string"}}',
      schema: StoryOutputSchema,
      temperature: 0.6,
      maxTokens: 900,
    });
    return StoryOutlineSchema.parse({
      id: randomUUID(),
      topicId: topic.id,
      ...res.content,
      targetDurationSeconds: 45,
      createdAt: new Date().toISOString(),
    });
  }
}
