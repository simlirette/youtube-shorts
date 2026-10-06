import { InvalidResponseError, ValidationError, logger } from '@shorts/core';
import type { LLMProvider, LLMResponse, ProviderContext, StructuredRequest } from './interfaces.js';

export interface RawCompletion {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  finishReason?: string;
  httpAttempts: number;
}

/** USD per 1M tokens (input, output). Estimates from public list prices; unknown models cost 0 and are flagged. */
const PRICING: Array<[RegExp, number, number]> = [
  [/^gpt-4o-mini/, 0.15, 0.6],
  [/^gpt-4o/, 2.5, 10],
  [/^gpt-4\.1-mini/, 0.4, 1.6],
  [/^gpt-4\.1-nano/, 0.1, 0.4],
  [/^gpt-4\.1/, 2, 8],
  [/^gemini-2\.5-flash/, 0.3, 2.5],
  [/^gemini-2\.5-pro/, 1.25, 10],
  [/^mock/, 0, 0],
];

export function estimateLlmCost(model: string, inputTokens: number, outputTokens: number): { usd: number; known: boolean } {
  const p = PRICING.find(([re]) => re.test(model));
  if (!p) return { usd: 0, known: false };
  return { usd: (inputTokens * p[1] + outputTokens * p[2]) / 1_000_000, known: true };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Implements the structured-output contract on top of a raw completion call:
 * JSON parse → Zod schema → semantic validator. Violations are fed back to the model for a bounded
 * number of corrective attempts; after that a ValidationError is thrown. Nothing is defaulted.
 */
export abstract class StructuredLLMBase implements LLMProvider {
  abstract readonly name: string;
  abstract readonly model: string;

  constructor(protected readonly ctx: ProviderContext = {}) {}

  protected abstract complete(system: string, user: string, opts: { temperature: number; maxTokens: number; model: string; task: string }): Promise<RawCompletion>;

  async generateStructured<T>(req: StructuredRequest<T>): Promise<LLMResponse<T>> {
    const maxAttempts = Math.max(1, req.maxValidationAttempts ?? 2);
    const model = req.model ?? this.model;
    const system =
      `${req.system}\n\nRespond with a single JSON object only — no markdown, no commentary. ` +
      `It must match this shape:\n${req.schemaHint}`;
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let httpAttempts = 0;
    let lastViolations: string[] = [];
    let prompt = req.prompt;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let raw: RawCompletion;
      try {
        raw = await this.complete(system, prompt, { temperature: req.temperature ?? 0.4, maxTokens: req.maxTokens ?? 3000, model, task: req.task });
      } catch (err) {
        this.report(req.task, model, 'ERROR', httpAttempts + 1, Date.now() - started, inputTokens, outputTokens, err);
        throw err;
      }
      httpAttempts += raw.httpAttempts;
      inputTokens += raw.inputTokens;
      outputTokens += raw.outputTokens;

      const violations: string[] = [];
      let value: T | undefined;
      if (raw.finishReason && ['length', 'MAX_TOKENS'].includes(raw.finishReason)) {
        violations.push('response was truncated (token limit); produce a shorter, complete JSON object');
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(extractJson(raw.text));
        } catch {
          violations.push('response was not valid JSON');
        }
        if (violations.length === 0) {
          const res = req.schema.safeParse(parsed);
          if (!res.success) {
            for (const issue of res.error.issues.slice(0, 15)) violations.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
          } else {
            value = res.data;
            violations.push(...((await req.validate?.(value)) ?? []));
          }
        }
      }

      if (violations.length === 0 && value !== undefined) {
        const cost = estimateLlmCost(raw.model, inputTokens, outputTokens);
        this.report(req.task, raw.model, 'OK', httpAttempts, Date.now() - started, inputTokens, outputTokens);
        if (!cost.known) logger.warn(`No pricing entry for model ${raw.model}; cost recorded as 0`, { provider: this.name });
        return {
          content: value,
          usage: { inputTokens, outputTokens, estimatedCostUsd: cost.usd },
          model: raw.model,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      }

      lastViolations = violations;
      logger.warn(`${this.name} ${req.task}: output rejected on attempt ${attempt}/${maxAttempts}`, {
        provider: this.name,
        operation: req.task,
        violations: violations.slice(0, 8),
      });
      prompt =
        `${req.prompt}\n\nYOUR PREVIOUS RESPONSE:\n${raw.text.slice(0, 8000)}\n\n` +
        `IT WAS REJECTED by automated validation for these reasons:\n` +
        violations.map((v) => `- ${v}`).join('\n') +
        `\nRevise your previous response to fix every listed problem while keeping everything that was valid. Return the complete corrected JSON object.`;
    }

    this.report(req.task, model, 'ERROR', httpAttempts, Date.now() - started, inputTokens, outputTokens, lastViolations.join('; '));
    throw new ValidationError(`${this.name} ${req.task}: output failed validation after ${maxAttempts} attempt(s)`, lastViolations);
  }

  private report(task: string, model: string, status: 'OK' | 'ERROR', attempts: number, durationMs: number, inTok: number, outTok: number, err?: unknown): void {
    this.ctx.observer?.({
      provider: this.name,
      operation: `llm:${task}`,
      status,
      attempts,
      durationMs,
      costUsd: estimateLlmCost(model, inTok, outTok).usd,
      units: { inputTokens: inTok, outputTokens: outTok },
      error: err === undefined ? undefined : err instanceof Error ? err.message : String(err),
    });
  }
}

export function requireNonEmpty(provider: string, text: string | undefined | null, what: string): string {
  if (!text || !text.trim()) throw new InvalidResponseError(provider, `${what} was empty`);
  return text;
}
