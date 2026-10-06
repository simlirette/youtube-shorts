import { z } from 'zod';
import type { LLMProvider } from '@shorts/providers';

const ReviewSchema = z.object({
  findings: z.array(
    z.object({
      statement: z.string(),
      severity: z.enum(['material', 'minor']),
      reason: z.string().default(''),
    })
  ),
});

export interface UnsupportedStatement {
  statement: string;
  severity: 'material' | 'minor';
  reason: string;
}

/**
 * Semantic fact check of narration against verified facts only. Used both inside script generation
 * (so unsupported statements are corrected before any audio is paid for) and again by content QA.
 *
 * "material" = the narration introduces a specific fact the verified facts do not contain (blocking).
 * "minor"    = paraphrase, emphasis or interpretive framing of verified facts (recorded, not blocking).
 */
export async function reviewNarration(
  reviewer: LLMProvider,
  verifiedFacts: string[],
  scenes: Array<{ narration: string }>
): Promise<UnsupportedStatement[]> {
  const res = await reviewer.generateStructured({
    task: 'content_review',
    system: 'You are a strict fact-check editor for short documentaries. You judge only against the facts provided, never your own knowledge.',
    prompt: `Compare the NARRATION with the VERIFIED FACTS and list problems.

severity "material": the narration states a specific fact that the verified facts do not contain or that contradicts them — a number, date, name, place, event, award, cause, record/superlative ("first", "largest"), or presents something as current/ongoing/certain without the facts establishing it. Material findings apply even if you personally believe the statement is true.
severity "minor": rewording, emphasis, rhetorical questions, or interpretive framing that adds no new specific fact.

Do not list sentences that are fully supported. Return an empty list if there are no problems.

VERIFIED FACTS:
${verifiedFacts.map((f) => `- ${f}`).join('\n')}

NARRATION:
${scenes.map((s, i) => `[scene ${i + 1}] ${s.narration}`).join('\n')}`,
    schemaHint: '{"findings":[{"statement":"exact sentence from the narration","severity":"material|minor","reason":"string"}]}',
    schema: ReviewSchema,
    temperature: 0,
    maxTokens: 1200,
  });
  return res.content.findings;
}

export const materialFindings = (f: UnsupportedStatement[]) => f.filter((x) => x.severity === 'material');
