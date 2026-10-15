import { ConfigurationError, InvalidResponseError, RollingMinuteLimiter, UsageBudget, httpJson, logger } from '@shorts/core';
import type { ProviderContext } from '../interfaces.js';
import { RawCompletion, StructuredLLMBase, requireNonEmpty } from '../llm-base.js';

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export interface GeminiFreeTier {
  /** Requests per minute this process allows itself (waits when reached). */
  rpm: number;
  /** Requests per Pacific-time day allowed on this machine (refuses with QUOTA_EXCEEDED when reached). */
  rpd: number;
  /** Counter file shared by every process on this machine. */
  budgetFile: string;
}

/** Google Gemini via REST. The key travels in a header, never in the URL. */
export class GeminiLLMProvider extends StructuredLLMBase {
  readonly name = 'gemini';
  private readonly limiter?: RollingMinuteLimiter;
  private readonly budget?: UsageBudget;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly opts: { timeoutMs: number; maxAttempts: number; freeTier?: GeminiFreeTier; thinkingBudget?: number },
    ctx: ProviderContext = {}
  ) {
    super(ctx);
    if (!apiKey) throw new ConfigurationError('GEMINI_API_KEY is required for the Gemini provider');
    if (opts.freeTier) {
      this.freeTier = true;
      this.limiter = new RollingMinuteLimiter(opts.freeTier.rpm);
      // Google resets free-tier daily quotas at midnight Pacific time.
      this.budget = new UsageBudget({ file: opts.freeTier.budgetFile, provider: 'gemini', limit: opts.freeTier.rpd, period: 'day', timeZone: 'America/Los_Angeles', unit: 'requests' });
    }
  }

  protected async complete(
    system: string,
    user: string,
    o: { temperature: number; maxTokens: number; model: string; task: string; images?: Array<{ mimeType: string; data: Buffer }> }
  ): Promise<RawCompletion> {
    if (this.budget) {
      this.budget.reserve(1);
      const waited = await this.limiter!.acquire();
      if (waited > 0) logger.info(`gemini: waited ${Math.round(waited / 1000)} s for the free-tier per-minute limit`);
    }
    // Flash models "think" by default and thinking tokens count against maxOutputTokens (truncated JSON);
    // the budget is configurable and 0 turns it off on Flash models.
    const thinking = this.opts.thinkingBudget !== undefined && /flash/.test(o.model) ? { thinkingConfig: { thinkingBudget: this.opts.thinkingBudget } } : {};
    const parts: Array<Record<string, unknown>> = [{ text: user }, ...(o.images ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data.toString('base64') } }))];
    const res = await httpJson<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(o.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: o.temperature, maxOutputTokens: o.maxTokens, responseMimeType: 'application/json', ...thinking },
        }),
      },
      {
        provider: this.name,
        operation: `generateContent:${o.task}`,
        timeoutMs: this.opts.timeoutMs,
        maxAttempts: this.opts.maxAttempts,
        fetchImpl: this.ctx.fetchImpl,
        sleep: this.ctx.sleep,
      }
    );
    if (res.data.promptFeedback?.blockReason) {
      throw new InvalidResponseError(this.name, `prompt blocked: ${res.data.promptFeedback.blockReason}`);
    }
    const cand = res.data.candidates?.[0];
    if (!cand) throw new InvalidResponseError(this.name, 'response contained no candidates');
    const text = (cand.content?.parts ?? []).map((p) => p.text ?? '').join('');
    return {
      text: requireNonEmpty(this.name, text, 'candidate text'),
      inputTokens: res.data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.data.usageMetadata?.candidatesTokenCount ?? 0,
      model: res.data.modelVersion ?? o.model,
      finishReason: cand.finishReason,
      httpAttempts: res.attempts,
    };
  }
}
