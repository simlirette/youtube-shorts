import { ConfigurationError, InvalidResponseError, httpJson } from '@shorts/core';
import type { ProviderContext } from '../interfaces.js';
import { RawCompletion, StructuredLLMBase, requireNonEmpty } from '../llm-base.js';

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAILLMProvider extends StructuredLLMBase {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly opts: { timeoutMs: number; maxAttempts: number },
    ctx: ProviderContext = {}
  ) {
    super(ctx);
    if (!apiKey) throw new ConfigurationError('OPENAI_API_KEY is required for the OpenAI provider');
  }

  protected async complete(system: string, user: string, o: { temperature: number; maxTokens: number; model: string; task: string }): Promise<RawCompletion> {
    const res = await httpJson<ChatCompletionResponse>(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: o.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: o.temperature,
          max_tokens: o.maxTokens,
          response_format: { type: 'json_object' },
        }),
      },
      {
        provider: this.name,
        operation: `chat.completions:${o.task}`,
        timeoutMs: this.opts.timeoutMs,
        maxAttempts: this.opts.maxAttempts,
        fetchImpl: this.ctx.fetchImpl,
        sleep: this.ctx.sleep,
      }
    );
    const choice = res.data.choices?.[0];
    if (!choice) throw new InvalidResponseError(this.name, 'response contained no choices');
    if (choice.message?.refusal) throw new InvalidResponseError(this.name, `model refused: ${choice.message.refusal}`);
    return {
      text: requireNonEmpty(this.name, choice.message?.content, 'completion content'),
      inputTokens: res.data.usage?.prompt_tokens ?? 0,
      outputTokens: res.data.usage?.completion_tokens ?? 0,
      model: res.data.model ?? o.model,
      finishReason: choice.finish_reason,
      httpAttempts: res.attempts,
    };
  }
}
