import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShortScript, VoiceNarration, VoiceNarrationSchema, WordTimestamp } from '@shorts/schemas';
import type { CharacterAlignment, TTSProvider } from '@shorts/providers';
import {
  InvalidResponseError,
  ValidationError,
  detectSilence,
  logger,
  loudnormToWav,
  measureLoudness,
  sha256File,
  sha256Text,
  summarizeMedia,
  tokenizeWords,
  volumeStats,
} from '@shorts/core';

/** Group character-level alignment into whitespace-delimited words. */
export function wordsFromAlignment(a: CharacterAlignment): WordTimestamp[] {
  const words: WordTimestamp[] = [];
  let chars: string[] = [];
  let start = 0;
  let end = 0;
  const flush = () => {
    if (chars.length) words.push({ word: chars.join(''), start: Math.max(0, start), end: Math.max(start, end) });
    chars = [];
  };
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (chars.length === 0) start = a.startTimes[i];
    chars.push(ch);
    end = a.endTimes[i];
  }
  flush();
  return words;
}

export interface VoiceOptions {
  targetLufs: number;
  toleranceLu: number;
  minSeconds: number;
  maxSeconds: number;
  /** Seconds reserved after narration in the final video. */
  tailSeconds: number;
  ttsCacheDir: string;
}

export class VoiceAgent {
  constructor(private readonly tts: TTSProvider, private readonly opts: VoiceOptions) {}

  narrationText(script: ShortScript): string {
    return script.scenes.map((s) => s.narration.trim()).join(' ');
  }

  async generateVoiceover(script: ShortScript, audioDir: string): Promise<VoiceNarration> {
    const text = this.narrationText(script);
    const cacheKey = sha256Text(JSON.stringify({ v: 1, provider: this.tts.name, voice: this.tts.voiceId, model: this.tts.modelId, settings: this.tts.settingsKey, text }));
    const cacheEntry = path.join(this.opts.ttsCacheDir, cacheKey);
    let rawPath: string;
    let alignment: CharacterAlignment;

    // 1. Provider audio (cached by exact text + voice + model, so resumes never re-bill).
    const cachedMeta = path.join(cacheEntry, 'alignment.json');
    if (fs.existsSync(cachedMeta)) {
      const meta = JSON.parse(fs.readFileSync(cachedMeta, 'utf-8')) as { alignment: CharacterAlignment; file: string };
      rawPath = path.join(cacheEntry, meta.file);
      alignment = meta.alignment;
      logger.info('TTS cache hit — reusing previously synthesized narration', { stage: 'VOICE', cacheKey });
    } else {
      const result = await this.tts.synthesize({ text });
      fs.mkdirSync(cacheEntry, { recursive: true });
      const file = `raw.${result.audioExtension}`;
      rawPath = path.join(cacheEntry, file);
      fs.writeFileSync(`${rawPath}.part`, result.audio);
      fs.renameSync(`${rawPath}.part`, rawPath);
      alignment = result.alignment;
      fs.writeFileSync(cachedMeta, JSON.stringify({ alignment, file, provider: result.provider, voiceId: result.voiceId, modelId: result.modelId }));
    }

    // 2. Real word timing from alignment; it must cover exactly the submitted words.
    const words = wordsFromAlignment(alignment);
    const expected = tokenizeWords(text);
    if (words.length !== expected.length || words.some((w, i) => w.word !== expected[i])) {
      const at = words.findIndex((w, i) => w.word !== expected[i]);
      throw new InvalidResponseError(this.tts.name, `alignment words do not match narration (got ${words.length}, expected ${expected.length}; first mismatch at ${at}: "${words[at]?.word}" vs "${expected[at]}")`);
    }
    for (let i = 0; i < words.length; i++) {
      if (words[i].end < words[i].start || (i > 0 && words[i].start + 1e-3 < words[i - 1].start)) {
        throw new InvalidResponseError(this.tts.name, `non-monotonic word timestamps at word ${i} ("${words[i].word}")`);
      }
    }

    // 3. Normalize to the renderer's narration format and validate the actual file.
    fs.mkdirSync(audioDir, { recursive: true });
    const rawCopy = path.join(audioDir, path.basename(rawPath));
    fs.copyFileSync(rawPath, rawCopy);
    const rawVol = await volumeStats(rawCopy);
    if (!Number.isFinite(rawVol.maxDb) || rawVol.maxDb < -40) {
      throw new ValidationError('Narration failed audio validation', [`provider audio is silent or near-silent (max ${rawVol.maxDb} dB)`]);
    }
    const wavPath = path.join(audioDir, 'narration.wav');
    await loudnormToWav(rawCopy, wavPath, { targetLufs: this.opts.targetLufs, sampleRate: 48000, channels: 1 });

    const probe = await summarizeMedia(wavPath);
    const violations: string[] = [];
    if (!probe.audio) violations.push('normalized narration has no audio stream');
    const duration = probe.audio?.durationSeconds ?? 0;
    const lastEnd = words[words.length - 1].end;
    if (probe.audio && probe.audio.codec !== 'pcm_s16le') violations.push(`unexpected codec ${probe.audio.codec}`);
    if (probe.audio && probe.audio.sampleRate !== 48000) violations.push(`unexpected sample rate ${probe.audio.sampleRate}`);
    if (probe.audio && probe.audio.channels !== 1) violations.push(`unexpected channel count ${probe.audio.channels}`);
    if (lastEnd > duration + 0.05) violations.push(`last word ends at ${lastEnd.toFixed(2)}s, after audio end ${duration.toFixed(2)}s (audio truncated)`);
    if (duration - lastEnd > 2.0) violations.push(`audio continues ${(duration - lastEnd).toFixed(2)}s after the last word`);
    if (words[0].start > 1.5) violations.push(`speech starts late (${words[0].start.toFixed(2)}s)`);
    const total = lastEnd + this.opts.tailSeconds;
    if (total < this.opts.minSeconds || total > this.opts.maxSeconds) {
      violations.push(`narration length ${lastEnd.toFixed(2)}s gives a ${total.toFixed(2)}s Short, outside ${this.opts.minSeconds}-${this.opts.maxSeconds}s`);
    }

    const loud = await measureLoudness(wavPath);
    if (!Number.isFinite(loud.integratedLufs) || Math.abs(loud.integratedLufs - this.opts.targetLufs) > this.opts.toleranceLu) {
      violations.push(`integrated loudness ${loud.integratedLufs} LUFS outside ${this.opts.targetLufs}±${this.opts.toleranceLu}`);
    }
    if (loud.truePeakDb > -0.5) violations.push(`true peak ${loud.truePeakDb} dBFS above -0.5`);
    const vol = await volumeStats(wavPath);
    if (vol.meanDb < -45) violations.push(`narration is near-silent (mean ${vol.meanDb} dB)`);
    const silences = (await detectSilence(wavPath, -50, 1.5)).filter((s) => s.start > words[0].start && s.end < lastEnd);
    if (silences.length > 0) violations.push(`narration contains ${silences.length} silent gap(s) > 1.5s inside speech (first at ${silences[0].start.toFixed(2)}s)`);

    if (violations.length > 0) throw new ValidationError('Narration failed audio validation', violations);

    const narration = VoiceNarrationSchema.parse({
      id: randomUUID(),
      scriptId: script.id,
      provider: this.tts.name,
      voiceId: this.tts.voiceId,
      modelId: this.tts.modelId,
      audioPath: wavPath,
      rawAudioPath: rawCopy,
      durationSeconds: duration,
      sampleRate: probe.audio!.sampleRate,
      channels: probe.audio!.channels,
      codec: probe.audio!.codec,
      integratedLufs: loud.integratedLufs,
      truePeakDb: loud.truePeakDb,
      wordTimestamps: words,
      sha256: await sha256File(wavPath),
      cacheKey,
      synthesizedAt: new Date().toISOString(),
    });
    logger.info(`Narration validated: ${duration.toFixed(2)}s, ${words.length} words, ${loud.integratedLufs} LUFS`, { stage: 'VOICE' });
    return narration;
  }
}
