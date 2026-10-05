import { LLMProvider, LLMGenerateOptions } from '../interfaces.js';
import { TopicCandidate, TopicScore, ResearchPacket, StoryOutline, ShortScript, ContentPillar } from '@shorts/schemas';

export class OpenAILLMProvider implements LLMProvider {
  name = 'OpenAILLMProvider';
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string, model: string = 'gpt-4o') {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || '';
    this.model = model;
  }

  private ensureConfigured(): void {
    if (!this.apiKey) {
      throw new Error('OpenAI request failed: missing OPENAI_API_KEY in environment or .env');
    }
  }

  async generateText(prompt: string, options?: LLMGenerateOptions): Promise<string> {
    this.ensureConfigured();
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 1500,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async generateJSON<T>(prompt: string, schemaDescription: string, options?: LLMGenerateOptions): Promise<T> {
    const raw = await this.generateText(
      `${prompt}\n\nRespond ONLY with valid JSON conforming to this schema:\n${schemaDescription}`,
      { ...options, responseFormat: 'json' }
    );
    return JSON.parse(raw) as T;
  }

  async generateTopicCandidates(_pillar?: ContentPillar, _count?: number): Promise<TopicCandidate[]> {
    this.ensureConfigured();
    throw new Error('OpenAILLMProvider.generateTopicCandidates: real provider call not yet invoked');
  }

  async scoreTopic(_topic: TopicCandidate): Promise<TopicScore> {
    this.ensureConfigured();
    throw new Error('OpenAILLMProvider.scoreTopic: real provider call not yet invoked');
  }

  async conductResearch(_topic: TopicCandidate): Promise<ResearchPacket> {
    this.ensureConfigured();
    throw new Error('OpenAILLMProvider.conductResearch: real provider call not yet invoked');
  }

  async developStory(_topic: TopicCandidate, _research: ResearchPacket): Promise<StoryOutline> {
    this.ensureConfigured();
    throw new Error('OpenAILLMProvider.developStory: real provider call not yet invoked');
  }

  async writeScript(_story: StoryOutline, _research: ResearchPacket): Promise<ShortScript> {
    this.ensureConfigured();
    throw new Error('OpenAILLMProvider.writeScript: real provider call not yet invoked');
  }
}
