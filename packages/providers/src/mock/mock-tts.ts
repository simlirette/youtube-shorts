import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { VoiceNarration, WordTimestamp } from '@shorts/schemas';
import { TTSProvider, TTSOptions } from '../interfaces.js';

export class MockTTSProvider implements TTSProvider {
  name = 'MockTTSProvider';

  async synthesizeSpeech(
    scriptId: string,
    narrationText: string,
    outputFilePath: string,
    options?: TTSOptions
  ): Promise<VoiceNarration> {
    const outDir = path.dirname(path.resolve(outputFilePath));
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const words = narrationText.trim().split(/\s+/).filter(Boolean);
    // Standard documentary pacing is ~2.6 words per second
    const wordsPerSecond = 2.6;
    const estimatedDuration = Math.max(1, Math.round((words.length / wordsPerSecond) * 10) / 10);

    const wordTimestamps: WordTimestamp[] = [];
    const timePerWord = estimatedDuration / Math.max(1, words.length);

    for (let i = 0; i < words.length; i++) {
      const start = Math.round(i * timePerWord * 100) / 100;
      const end = Math.round((i + 1) * timePerWord * 100) / 100;
      wordTimestamps.push({
        word: words[i],
        start,
        end,
      });
    }

    // Synthesize a valid playable audio file using FFmpeg
    // Generate low tone or silent audio stream for the exact duration
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y',
        '-f', 'lavfi',
        '-i', `sine=frequency=220:duration=${estimatedDuration}`,
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        outputFilePath,
      ];

      const child = spawn('ffmpeg', args, { stdio: 'pipe' });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          // If sine fails, fallback to anullsrc
          const fallback = spawn('ffmpeg', [
            '-y',
            '-f', 'lavfi',
            '-i', `anullsrc=r=44100:cl=stereo`,
            '-t', `${estimatedDuration}`,
            '-c:a', 'libmp3lame',
            outputFilePath,
          ]);
          fallback.on('close', (fbCode) => {
            if (fbCode === 0) resolve();
            else reject(new Error(`Failed to synthesize mock audio: code ${fbCode}`));
          });
        }
      });
      child.on('error', reject);
    });

    return {
      id: randomUUID(),
      scriptId,
      provider: 'mock_tts',
      voiceId: options?.voiceId || 'mock-documentary-voice',
      audioPath: outputFilePath,
      durationSeconds: estimatedDuration,
      wordTimestamps,
      synthesizedAt: new Date().toISOString(),
    };
  }
}
