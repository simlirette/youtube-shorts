import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VoiceNarration } from '@shorts/schemas';
import { TTSProvider, TTSOptions } from '../interfaces.js';

export class ElevenLabsTTSProvider implements TTSProvider {
  name = 'ElevenLabsTTSProvider';
  private apiKey: string;
  private defaultVoiceId: string;

  constructor(apiKey?: string, defaultVoiceId?: string) {
    this.apiKey = apiKey || process.env.ELEVENLABS_API_KEY || '';
    this.defaultVoiceId = defaultVoiceId || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  }

  private ensureConfigured(): void {
    if (!this.apiKey) {
      throw new Error('ElevenLabs request failed: missing ELEVENLABS_API_KEY in environment or .env');
    }
  }

  async synthesizeSpeech(
    scriptId: string,
    narrationText: string,
    outputFilePath: string,
    options?: TTSOptions
  ): Promise<VoiceNarration> {
    this.ensureConfigured();
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: narrationText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`ElevenLabs API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const audioBuffer = Buffer.from(data.audio_base64, 'base64');
    const outDir = path.dirname(path.resolve(outputFilePath));
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(outputFilePath, audioBuffer);

    // Extract word timestamps from alignment if provided
    const wordTimestamps = (data.alignment?.characters || []).map((char: string, i: number) => ({
      word: char,
      start: (data.alignment?.character_start_times_seconds?.[i] || 0),
      end: (data.alignment?.character_end_times_seconds?.[i] || 0),
    }));

    return {
      id: randomUUID(),
      scriptId,
      provider: 'elevenlabs',
      voiceId,
      audioPath: outputFilePath,
      durationSeconds: data.alignment?.character_end_times_seconds?.slice(-1)[0] || 45,
      wordTimestamps,
      synthesizedAt: new Date().toISOString(),
    };
  }
}
