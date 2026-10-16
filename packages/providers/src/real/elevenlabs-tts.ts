import { ConfigurationError, InvalidResponseError, PipelineError, QuotaExceededError, httpJson, logger } from '@shorts/core';
import type { ProviderContext, TTSProvider, TTSRequest, TTSResult } from '../interfaces.js';

interface ElevenLabsTimestampResponse {
  audio_base64?: string;
  alignment?: {
    characters?: string[];
    character_start_times_seconds?: number[];
    character_end_times_seconds?: number[];
  } | null;
}

/**
 * ElevenLabs text-to-speech with character-level timestamps. Fails closed: missing/empty audio or
 * missing/inconsistent alignment is an InvalidResponseError — timing is never estimated.
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = 'elevenlabs';
  readonly settingsKey: string;

  constructor(
    private readonly apiKey: string,
    readonly voiceId: string,
    readonly modelId: string,
    private readonly opts: { timeoutMs: number; maxAttempts: number; usdPer1kChars: number; speed: number; stability?: number; style?: number },
    private readonly ctx: ProviderContext = {}
  ) {
    this.settingsKey = `stability=${opts.stability ?? 0.5};similarity=0.75;style=${opts.style ?? 0};speed=${opts.speed}`;
    if (!apiKey) throw new ConfigurationError('ELEVENLABS_API_KEY is required for the ElevenLabs provider');
    if (!voiceId) throw new ConfigurationError('ELEVENLABS_VOICE_ID is required for the ElevenLabs provider');
  }

  /**
   * Credits per character: Flash/Turbo models are billed at 0.5 credit per character through the
   * API, Multilingual/v3 models at 1 (ElevenLabs pricing, verified 2026-10).
   */
  get creditMultiplier(): number {
    return /flash|turbo/i.test(this.modelId) ? 0.5 : 1;
  }

  creditsFor(text: string): number {
    return Math.ceil(text.trim().length * this.creditMultiplier);
  }

  /** Free account lookup. Restricted keys without `user_read` get null (unknown), never a guess. */
  async remainingCredits(): Promise<{ remaining: number; limit: number; resetsAt?: string } | null> {
    try {
      const res = await httpJson<{ character_count?: number; character_limit?: number; next_character_count_reset_unix?: number }>(
        'https://api.elevenlabs.io/v1/user/subscription',
        { method: 'GET', headers: { 'xi-api-key': this.apiKey } },
        { provider: this.name, operation: 'subscription', timeoutMs: this.opts.timeoutMs, maxAttempts: 2, fetchImpl: this.ctx.fetchImpl, sleep: this.ctx.sleep }
      );
      const { character_count: used, character_limit: limit, next_character_count_reset_unix: reset } = res.data;
      if (typeof used !== 'number' || typeof limit !== 'number') return null;
      return { remaining: Math.max(0, limit - used), limit, resetsAt: reset ? new Date(reset * 1000).toISOString() : undefined };
    } catch (e) {
      if (e instanceof PipelineError && e.kind === 'AUTHENTICATION') {
        logger.warn('ElevenLabs key cannot read subscription (needs user_read permission); credit preflight skipped', { stage: 'VOICE' });
        return null;
      }
      throw e;
    }
  }

  async synthesize(req: TTSRequest): Promise<TTSResult> {
    const text = req.text.trim();
    if (!text) throw new InvalidResponseError(this.name, 'refusing to synthesize empty text');
    const voiceId = req.voiceId ?? this.voiceId;
    const started = Date.now();
    try {
      const res = await httpJson<ElevenLabsTimestampResponse>(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: this.modelId, voice_settings: { stability: this.opts.stability ?? 0.5, similarity_boost: 0.75, style: this.opts.style ?? 0, use_speaker_boost: true, speed: req.speed ?? this.opts.speed } }),
        },
        {
          provider: this.name,
          operation: 'tts.with-timestamps',
          timeoutMs: this.opts.timeoutMs,
          maxAttempts: this.opts.maxAttempts,
          fetchImpl: this.ctx.fetchImpl,
          sleep: this.ctx.sleep,
          // ElevenLabs reports exhausted credits as HTTP 401 — not a credential problem.
          classify: (status, body) => (/quota_exceeded/.test(body) ? new QuotaExceededError(this.name, `account credit quota exceeded (HTTP ${status}): ${body.slice(0, 300)}`) : undefined),
        }
      );
      const data = res.data;
      if (!data.audio_base64) throw new InvalidResponseError(this.name, 'response contained no audio');
      const audio = Buffer.from(data.audio_base64, 'base64');
      if (audio.length < 1024) throw new InvalidResponseError(this.name, `audio payload implausibly small (${audio.length} bytes)`);

      const a = data.alignment;
      const chars = a?.characters;
      const starts = a?.character_start_times_seconds;
      const ends = a?.character_end_times_seconds;
      if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends) || chars.length === 0) {
        throw new InvalidResponseError(this.name, 'response contained no character alignment');
      }
      if (chars.length !== starts.length || chars.length !== ends.length) {
        throw new InvalidResponseError(this.name, `alignment arrays disagree (${chars.length}/${starts.length}/${ends.length})`);
      }
      this.ctx.observer?.({
        provider: this.name,
        operation: 'tts',
        status: 'OK',
        attempts: res.attempts,
        durationMs: Date.now() - started,
        costUsd: (text.length / 1000) * this.opts.usdPer1kChars * this.creditMultiplier,
        units: { characters: text.length, credits: this.creditsFor(text) },
      });
      return {
        provider: this.name,
        voiceId,
        modelId: this.modelId,
        audio,
        audioExtension: 'mp3',
        alignment: { characters: chars, startTimes: starts, endTimes: ends },
      };
    } catch (err) {
      this.ctx.observer?.({ provider: this.name, operation: 'tts', status: 'ERROR', attempts: 1, durationMs: Date.now() - started, costUsd: 0, error: (err as Error).message });
      throw err;
    }
  }
}
