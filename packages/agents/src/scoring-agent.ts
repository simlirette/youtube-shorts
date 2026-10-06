import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ScoreDimensions, ScoreDimensionsSchema, TopicCandidate, TopicScore, TopicScoreSchema } from '@shorts/schemas';
import type { LLMProvider } from '@shorts/providers';

const ScoringOutputSchema = z.object({
  dimensions: ScoreDimensionsSchema,
  reasoning: z.string().min(20),
});

/** Weights of the positive dimensions (sum = 1). Complexity is inverted: lower is better. */
const WEIGHTS: Array<[keyof ScoreDimensions, number, boolean]> = [
  ['curiosity', 0.18, false],
  ['audiencePotential', 0.12, false],
  ['originality', 0.14, false],
  ['storyDepth', 0.14, false],
  ['visualPotential', 0.14, false],
  ['sourceAvailability', 0.18, false],
  ['freshness', 0.04, false],
  ['productionComplexity', 0.06, true],
];

export function computeOverallScore(d: ScoreDimensions): number {
  const raw = WEIGHTS.reduce((sum, [k, w, invert]) => sum + w * (invert ? 10 - d[k] : d[k]), 0);
  return Math.round(raw * 10 * 10) / 10;
}

export function evaluateGate(d: ScoreDimensions, overall: number, minScore: number): string[] {
  const reasons: string[] = [];
  if (overall < minScore) reasons.push(`overall score ${overall} < ${minScore}`);
  if (d.copyrightRisk > 3) reasons.push(`copyright risk ${d.copyrightRisk} > 3`);
  if (d.monetizationRisk > 3) reasons.push(`monetization risk ${d.monetizationRisk} > 3`);
  if (d.repetitionRisk > 5) reasons.push(`repetition risk ${d.repetitionRisk} > 5`);
  if (d.sourceAvailability < 6) reasons.push(`source availability ${d.sourceAvailability} < 6`);
  if (d.visualPotential < 5) reasons.push(`visual potential ${d.visualPotential} < 5`);
  return reasons;
}

export class ScoringAgent {
  constructor(private readonly llm: LLMProvider, private readonly opts: { minScore: number }) {}

  /** The LLM rates dimensions; the overall score and gate are computed deterministically. */
  async scoreTopic(topic: TopicCandidate): Promise<TopicScore> {
    const res = await this.llm.generateStructured({
      task: 'scoring',
      system: 'You are an exacting documentary editorial board. Rate honestly; do not inflate scores.',
      prompt: `Rate this YouTube Short topic on each dimension from 0 to 10.

Title: ${JSON.stringify(topic.title)}
Premise: ${JSON.stringify(topic.premise)}
Pillar: ${topic.pillar}

Dimensions:
- curiosity: does it open a strong curiosity gap?
- audiencePotential: broad appeal in the Shorts feed?
- originality: 10 = rarely covered angle, 0 = heavily overdone
- storyDepth: real conflict, turning point, payoff?
- visualPotential: can GENERIC stock footage (no archival footage of the actual event) illustrate it well?
- sourceAvailability: are reputable, publicly accessible sources likely to document the facts?
- freshness: timely or evergreen interest
- productionComplexity: 0 = easy to tell in 45 seconds, 10 = needs far more time
- copyrightRisk: 0 = safe, 10 = depends on copyrighted material
- repetitionRisk: 0 = distinct, 10 = generic/templated content
- monetizationRisk: 0 = advertiser-friendly, 10 = sensitive subject`,
      schemaHint: '{"dimensions":{"curiosity":0,"audiencePotential":0,"originality":0,"storyDepth":0,"visualPotential":0,"sourceAvailability":0,"freshness":0,"productionComplexity":0,"copyrightRisk":0,"repetitionRisk":0,"monetizationRisk":0},"reasoning":"string"}',
      schema: ScoringOutputSchema,
      temperature: 0.2,
      maxTokens: 600,
    });
    const d = res.content.dimensions;
    const overallScore = computeOverallScore(d);
    const gateReasons = evaluateGate(d, overallScore, this.opts.minScore);
    return TopicScoreSchema.parse({
      id: randomUUID(),
      topicId: topic.id,
      ...d,
      overallScore,
      reasoning: res.content.reasoning,
      passGate: gateReasons.length === 0,
      gateReasons,
      scoredAt: new Date().toISOString(),
    });
  }
}
