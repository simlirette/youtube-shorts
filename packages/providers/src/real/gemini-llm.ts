import { ConfigurationError, InvalidResponseError, httpJson } from '@shorts/core';
import type { ProviderContext } from '../interfaces.js';
import { RawCompletion, StructuredLLMBase, requireNonEmpty } from '../llm-base.js';

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Google Gemini via REST. The key travels in a header, never in the URL. */
export class GeminiLLMProvider extends StructuredLLMBase {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly opts: { timeoutMs: number; maxAttempts: number },
    ctx: ProviderContext = {}
  ) {
    super(ctx);
    if (!apiKey) throw new ConfigurationError('GEMINI_API_KEY is required for the Gemini provider');
  }

  protected async complete(system: string, user: string, o: { temperature: number; maxTokens: number; model: string; task: string }): Promise<RawCompletion> {
    const res = await httpJson<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(o.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: o.temperature, maxOutputTokens: o.maxTokens, responseMimeType: 'application/json' },
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
