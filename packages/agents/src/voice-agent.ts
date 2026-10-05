import path from 'node:path';
import { ShortScript, VoiceNarration } from '@shorts/schemas';
import { TTSProvider } from '@shorts/providers';
import { ShortsRepository, logger } from '@shorts/core';

export class VoiceAgent {
  constructor(
    private tts: TTSProvider,
    private repo: ShortsRepository
  ) {}

  async generateVoiceover(script: ShortScript, outputAudioPath?: string): Promise<VoiceNarration> {
    const fullNarration = script.scenes.map((s) => s.narration).join(' ');
    const destination =
      outputAudioPath ||
      path.resolve(process.cwd(), `output/temp/audio/voice_${script.id}.mp3`);

    logger.info(`Synthesizing voice narration for script: "${script.title}" (${script.totalWords} words)`, {
      stage: 'VOICE',
      scriptId: script.id,
      ttsProvider: this.tts.name,
    });

    const narration = await this.tts.synthesizeSpeech(script.id, fullNarration, destination);
    await this.repo.saveVoiceNarration(narration);

    logger.info(`Voiceover synthesized (${narration.durationSeconds}s, ${narration.wordTimestamps.length} words)`, {
      stage: 'VOICE',
      durationSeconds: narration.durationSeconds,
      audioPath: narration.audioPath,
    });

    return narration;
  }
}
