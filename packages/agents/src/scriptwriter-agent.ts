import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ResearchPacket, ShortScript, ShortScriptSchema, StoryOutline } from '@shorts/schemas';
import type { LLMProvider } from '@shorts/providers';
import { ValidationError, countWords, logger } from '@shorts/core';
import { ScriptDraft, ScriptRules, sceneWordBudget, validateScriptDraft } from './script-validation.js';
import { materialFindings, reviewNarration } from './narration-review.js';

const ScriptOutputSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  scenes: z
    .array(
      z.object({
        narration: z.string().min(1),
        visualObjective: z.string().min(1),
        assetKeywords: z.array(z.string().min(1)).default([]),
        textOverlay: z.string().optional(),
        claimRefs: z.array(z.string()).default([]),
      })
    )
    .min(1),
});

export interface ScriptwriterOptions {
  rules: ScriptRules;
  maxAttempts: number;
}

export interface ScriptContext {
  previousTitles: string[];
  previousHooks: string[];
  directorNotes?: string;
}

/** Map of short claim refs (C1..Cn) to verified claim IDs + supporting text, shared with content QA. */
export function verifiedClaimRefs(research: ResearchPacket): { refToId: Map<string, string>; idToRef: Map<string, string>; support: Map<string, string>; lines: string[] } {
  const verified = research.claims.filter((c) => c.verificationStatus === 'VERIFIED');
  const refToId = new Map<string, string>();
  const idToRef = new Map<string, string>();
  const support = new Map<string, string>();
  const lines: string[] = [];
  verified.forEach((c, i) => {
    const ref = `C${i + 1}`;
    refToId.set(ref, c.id);
    idToRef.set(c.id, ref);
    support.set(ref, [c.text, ...c.evidence.map((e) => e.quote)].join(' '));
    lines.push(`[${ref}] ${c.text}`);
  });
  return { refToId, idToRef, support, lines };
}

export class ScriptwriterAgent {
  /** `reviewer` (when given) fact-checks each structurally valid draft before it is accepted. */
  constructor(private readonly llm: LLMProvider, private readonly opts: ScriptwriterOptions, private readonly reviewer?: LLMProvider) {}

  async writeScript(story: StoryOutline, research: ResearchPacket, ctx: ScriptContext): Promise<ShortScript> {
    const { refToId, support, lines } = verifiedClaimRefs(research);
    if (lines.length === 0) throw new ValidationError('Cannot write a script without verified claims');
    const r = this.opts.rules;
    const budget = sceneWordBudget(r);

    const res = await this.llm.generateStructured({
      task: 'script',
      system:
        'You are a YouTube Shorts documentary scriptwriter. You write tight, spoken-word narration and you never state a fact that is not in the verified claim list.',
      prompt: `Write the narration script for a vertical documentary Short.

LOGLINE: ${story.logline}
ARC: hook: ${story.narrativeArc.hook} | context: ${story.narrativeArc.context} | development: ${story.narrativeArc.development} | twist: ${story.narrativeArc.twist} | payoff: ${story.narrativeArc.payoff}

VERIFIED CLAIMS (the only facts you may state; reference them by id):
${lines.join('\n')}
${ctx.directorNotes ? `\nDIRECTOR NOTES (must be addressed): ${ctx.directorNotes}\n` : ''}
HARD RULES (validated automatically; violations are rejected):
1. Exactly ${r.sceneCount} scenes.
2. Length: scene 1 (the hook) is ONE sentence of at most ${r.hookMaxWords} words. Scenes 2-${r.sceneCount} are each THREE complete sentences of 9-11 words (${budget.min}-${budget.max} words per scene). Total narration must be between ${r.minWords} and ${r.maxWords} words — a 40-second voiceover. Scenes shorter than ${budget.min} words are rejected.
3. Scene 1 is the hook: a question or striking statement, at most ${r.hookMaxWords} words.
4. Every factual statement must come from the verified claims; list the ids you rely on in each scene's "claimRefs". Reference at least ${Math.min(r.minClaimRefs, lines.length)} different claims overall.
5. Any number, year or date you say must appear in a claim listed in that same scene's claimRefs. Do not round or convert numbers.
6. "assetKeywords": 2-5 generic, visual stock-footage search terms per scene (e.g. "suspension bridge", "crowd walking", "storm clouds") — no names, dates or numbers, max 3 words each. The FIRST keyword is the main visual subject and must literally describe what should be on screen.
7. "visualObjective": one sentence describing what the viewer sees.
8. "title": 10-90 characters, no hashtags. "description": 1-3 sentences summarizing the story.
9. Plain spoken English. No stage directions, no emojis, no hashtags inside narration.`,
      schemaHint:
        '{"title":"string","description":"string","scenes":[{"narration":"string","visualObjective":"string","assetKeywords":["string"],"textOverlay":"string","claimRefs":["C1"]}]}',
      schema: ScriptOutputSchema,
      validate: async (draft) => {
        const violations = validateScriptDraft(draft as ScriptDraft, {
          rules: r,
          claims: support,
          previousTitles: ctx.previousTitles,
          previousHooks: ctx.previousHooks,
        });
        if (violations.length > 0 || !this.reviewer) return violations;
        const facts = research.claims.filter((c) => c.verificationStatus === 'VERIFIED').map((c) => c.text);
        const material = materialFindings(await reviewNarration(this.reviewer, facts, draft.scenes));
        return material.map((u) => `unsupported fact (not in verified claims): "${u.statement}" — ${u.reason}. Remove that detail or restate a verified claim instead.`);
      },
      maxValidationAttempts: this.opts.maxAttempts,
      temperature: 0.7,
      maxTokens: 2000,
    });

    const draft = res.content;
    const scenes = draft.scenes.map((s, i) => ({
      sceneNumber: i + 1,
      narration: s.narration.trim().replace(/\s+/g, ' '),
      visualObjective: s.visualObjective.trim(),
      mediaFormat: 'LICENSED_STOCK' as const,
      assetKeywords: s.assetKeywords.map((k) => k.trim().toLowerCase()),
      textOverlay: s.textOverlay?.trim() || undefined,
      transitionIntent: 'CUT' as const,
      claimIds: [...new Set(s.claimRefs)].map((ref) => refToId.get(ref)!),
    }));
    const totalWords = scenes.reduce((n, s) => n + countWords(s.narration), 0);
    const sourcesLine = research.sources
      .filter((src) => research.claims.some((c) => c.verificationStatus === 'VERIFIED' && c.sourceIds.includes(src.id)))
      .map((src) => src.url)
      .slice(0, 4)
      .join('\n');
    const script = ShortScriptSchema.parse({
      id: randomUUID(),
      storyId: story.id,
      topicId: story.topicId,
      title: draft.title.trim(),
      description: `${draft.description.trim()}\n\nSources:\n${sourcesLine}\n\n#Shorts`.slice(0, 5000),
      hookText: scenes[0].narration,
      targetDurationSeconds: 45,
      scenes,
      totalWords,
      generationAttempts: res.attempts,
      createdAt: new Date().toISOString(),
    });
    logger.info(`Script accepted: "${script.title}" — ${totalWords} words, ${scenes.length} scenes, attempt ${res.attempts}`, { stage: 'SCRIPT' });
    return script;
  }
}
