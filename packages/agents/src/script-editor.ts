import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ScriptReview, ScriptReviewSchema, ShortScript } from '@shorts/schemas';
import type { LLMProvider } from '@shorts/providers';
import { logger } from '@shorts/core';

export interface EditorThresholds {
  minTotal: number;
  minHook: number;
  minPayoff: number;
}

export const DEFAULT_EDITOR_THRESHOLDS: EditorThresholds = { minTotal: 15, minHook: 4, minPayoff: 4 };

const score = z.number().int().min(0).max(5);
const EditorOutputSchema = z.object({
  scores: z.object({ hook: score, specificity: score, causalFlow: score, payoff: score }),
  notes: z.array(z.string().min(8)).max(8),
});

/** Pass/fail is computed here from the scores, never taken from the model. */
export function editorialVerdict(scores: ScriptReview['scores'], t: EditorThresholds): { total: number; passed: boolean } {
  const total = scores.hook + scores.specificity + scores.causalFlow + scores.payoff;
  return { total, passed: total >= t.minTotal && scores.hook >= t.minHook && scores.payoff >= t.minPayoff };
}

/**
 * Script editor: a separate model pass that scores a finished, fact-checked script on hook
 * concreteness, specificity, causal flow and payoff (0-5 each) and returns specific revision notes.
 * It never rewrites the script itself — revisions go back through the writer and its validators.
 */
export class ScriptEditor {
  constructor(
    private readonly llm: LLMProvider,
    private readonly thresholds: EditorThresholds = DEFAULT_EDITOR_THRESHOLDS
  ) {}

  async review(script: ShortScript, facts: string[], revision: number): Promise<ScriptReview> {
    const numbered = script.scenes.map((s) => `[${s.sceneNumber}] ${s.narration}`).join('\n');
    // Notes must respect the job's hook type (live: the editor asked a statement-hook script for a question).
    const hookRule =
      script.hookType === 'question'
        ? 'HOOK TYPE: question (an experiment arm). Keep the hook a question; judge whether it is specific and has a stake.'
        : script.hookType === 'scene'
          ? 'HOOK TYPE: scene. The hook must stay an action already happening — never suggest turning it into a question.'
          : 'HOOK TYPE: statement. The hook must stay one concrete statement — never suggest turning it into a question.';
    const res = await this.llm.generateStructured({
      task: 'script_editor',
      system:
        'You are a demanding Shorts script editor. You score scripts strictly against a rubric and give concrete, line-level notes. You do not rewrite scripts and you do not add facts.',
      prompt: `Score this narration for a 30-45 second faceless explainer Short. Facts it may use are listed; do not judge factual accuracy (that is checked elsewhere) and never suggest adding facts that are not listed.

SCRIPT (scene number, narration):
${numbered}

ALLOWED FACTS:
${facts.map((f) => `- ${f}`).join('\n')}

${hookRule}

RUBRIC (integers 0-5):
- hook: 5 = the first sentence names a concrete subject or action and creates a specific question in the viewer's mind; 3 = clear but generic; 1 = vague, rhetorical ("Have you ever…") or a bare question with no stake.
- specificity: 5 = every sentence carries a concrete noun, number or mechanism; 3 = some vague or summarizing sentences; 1 = mostly generic statements or praise.
- causalFlow: 5 = each fact follows from the previous one (because / so / which means), escalating; 3 = facts are related but listed; 1 = disconnected.
- payoff: 5 = the final sentence is the most surprising concrete fact and resolves the hook; 3 = a weaker fact or partial resolution; 1 = a summary, moral or "next time" line.

NOTES: if any score is below 5, give up to 6 notes, each naming the scene number and saying exactly what to change (e.g. "[1] Replace the question with the concrete claim from fact 2"). No generic advice.`,
      schemaHint: '{"scores":{"hook":4,"specificity":4,"causalFlow":4,"payoff":4},"notes":["[n] specific change"]}',
      schema: EditorOutputSchema,
      validate: (v) => {
        const { passed } = editorialVerdict(v.scores, this.thresholds);
        return !passed && v.notes.length === 0 ? ['a failing score must come with at least one specific note'] : [];
      },
      temperature: 0,
      maxTokens: 700,
      maxValidationAttempts: 2,
    });
    const { total, passed } = editorialVerdict(res.content.scores, this.thresholds);
    const review = ScriptReviewSchema.parse({
      id: randomUUID(),
      scriptId: script.id,
      revision,
      scores: res.content.scores,
      total,
      passed,
      notes: passed ? [] : res.content.notes,
      thresholds: this.thresholds,
      model: res.model,
      reviewedAt: new Date().toISOString(),
    });
    logger.info(
      `Script editor (revision ${revision}): hook ${review.scores.hook}, specificity ${review.scores.specificity}, flow ${review.scores.causalFlow}, payoff ${review.scores.payoff} = ${total}/20 → ${passed ? 'PASS' : 'REVISE'}`,
      { stage: 'SCRIPT' }
    );
    return review;
  }
}

/** Turns an editor review into writer instructions for the next revision. */
export function revisionNotes(script: ShortScript, review: ScriptReview): string {
  return [
    `The script editor scored the previous draft ${review.total}/20 (hook ${review.scores.hook}, specificity ${review.scores.specificity}, causal flow ${review.scores.causalFlow}, payoff ${review.scores.payoff}). Revise it — keep what works, fix exactly these points:`,
    ...review.notes.map((n) => `- ${n}`),
    'Previous draft:',
    ...script.scenes.map((s) => `[${s.sceneNumber}] ${s.narration}`),
  ].join('\n');
}
