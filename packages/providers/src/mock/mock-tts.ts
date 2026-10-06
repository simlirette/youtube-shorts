import type { TTSProvider, TTSRequest, TTSResult } from '../interfaces.js';

const SAMPLE_RATE = 44100;

/** Mono 16-bit PCM WAV encoder. */
function encodeWav(samples: Int16Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Mock TTS for mock mode: synthesizes a WAV whose audible "speech" bursts coincide exactly with the
 * character alignment it reports, so downstream timing/QA logic is exercised against real audio.
 */
export class MockTTSProvider implements TTSProvider {
  readonly name = 'mock-tts';
  readonly voiceId = 'mock-voice';
  readonly modelId = 'mock-tts-1';
  readonly settingsKey = 'mock';

  constructor(private readonly opts: { silent?: boolean; truncateAudioToSeconds?: number; omitAlignment?: boolean } = {}) {}

  async synthesize(req: TTSRequest): Promise<TTSResult> {
    const text = req.text.trim();
    const characters: string[] = [];
    const startTimes: number[] = [];
    const endTimes: number[] = [];
    const spans: Array<[number, number]> = [];
    let t = 0.1;
    let wordStart: number | null = null;
    for (const ch of text) {
      const dur = /\s/.test(ch) ? 0.06 : /[.,!?;:]/.test(ch) ? 0.18 : 0.055;
      characters.push(ch);
      startTimes.push(Number(t.toFixed(3)));
      if (!/\s/.test(ch) && wordStart === null) wordStart = t;
      if (/\s/.test(ch) && wordStart !== null) {
        spans.push([wordStart, t]);
        wordStart = null;
      }
      t += dur;
      endTimes.push(Number(t.toFixed(3)));
    }
    if (wordStart !== null) spans.push([wordStart, t]);
    const total = this.opts.truncateAudioToSeconds ?? t + 0.25;

    const samples = new Int16Array(Math.round(total * SAMPLE_RATE));
    if (!this.opts.silent) {
      for (const [s, e] of spans) {
        const a = Math.round(s * SAMPLE_RATE);
        const b = Math.min(samples.length, Math.round(e * SAMPLE_RATE));
        for (let i = a; i < b; i++) {
          const env = Math.min(1, (i - a) / 400, (b - i) / 400);
          samples[i] = Math.round(12000 * env * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
        }
      }
    }
    return {
      provider: this.name,
      voiceId: this.voiceId,
      modelId: this.modelId,
      audio: encodeWav(samples),
      audioExtension: 'wav',
      alignment: this.opts.omitAlignment ? { characters: [], startTimes: [], endTimes: [] } : { characters, startTimes, endTimes },
    };
  }
}
