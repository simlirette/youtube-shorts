import { ConfigurationError, InvalidResponseError, httpJson } from '@shorts/core';
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
    private readonly opts: { timeoutMs: number; maxAttempts: number; usdPer1kChars: number; speed: number },
    private readonly ctx: ProviderContext = {}
  ) {
    this.settingsKey = `stability=0.5;similarity=0.75;speed=${opts.speed}`;
    if (!apiKey) throw new ConfigurationError('ELEVENLABS_API_KEY is required for the ElevenLabs provider');
    if (!voiceId) throw new ConfigurationError('ELEVENLABS_VOICE_ID is required for the ElevenLabs provider');
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
          body: JSON.stringify({ text, model_id: this.modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: this.opts.speed } }),
        },
        { provider: this.name, operation: 'tts.with-timestamps', timeoutMs: this.opts.timeoutMs, maxAttempts: this.opts.maxAttempts, fetchImpl: this.ctx.fetchImpl, sleep: this.ctx.sleep }
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
        costUsd: (text.length / 1000) * this.opts.usdPer1kChars,
        units: { characters: text.length },
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
