import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, type AppConfig } from '@shorts/core';
import { ElevenLabsTTSProvider } from '@shorts/providers';
import type { BaseConfig } from '@shorts/schemas';

/** Narration as saved next to a video (the format the older `pnpm mechanism` command also writes, so caches are interchangeable). */
export interface SavedNarration {
  text: string;
  voiceId: string;
  modelId: string;
  speed: number;
  characters: string[];
  startTimes: number[];
  endTimes: number[];
  credits: number;
  mock?: boolean;
}

/**
 * The one fixed voice, from base.json. The audio is generated once per (text, voice, speed): an unchanged script
 * reuses the saved audio and spends no credits. `mock` writes silence with synthetic timing for look-only runs.
 */
export async function ensureNarration(o: {
  outDir: string;
  text: string;
  voice: BaseConfig['voice'];
  mock: boolean;
  appCfg: AppConfig;
  log?: (line: string) => void;
}): Promise<{ audioPath: string; saved: SavedNarration }> {
  const log = o.log ?? console.log;
  const audioPath = path.join(o.outDir, o.mock ? 'narration.wav' : 'narration.mp3');
  const jsonPath = path.join(o.outDir, 'narration.json');
  if (fs.existsSync(jsonPath) && fs.existsSync(audioPath)) {
    const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as SavedNarration;
    if (saved.text === o.text && saved.speed === o.voice.speed && Boolean(saved.mock) === o.mock && (o.mock || saved.voiceId === o.voice.id)) {
      log(`narration: reusing saved audio (${o.mock ? 'mock' : 'ElevenLabs'}), 0 credits spent`);
      return { audioPath, saved };
    }
    log('narration: text, voice or speed changed; regenerating');
  }
  if (o.mock) {
    const per = 0.056; // about 2.7 words per second, silent
    const chars = [...o.text];
    const saved: SavedNarration = { text: o.text, voiceId: 'mock', modelId: 'mock', speed: o.voice.speed, characters: chars, startTimes: chars.map((_, i) => i * per), endTimes: chars.map((_, i) => (i + 1) * per), credits: 0, mock: true };
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', (chars.length * per).toFixed(2), audioPath], { description: 'mock narration' });
    fs.writeFileSync(jsonPath, JSON.stringify(saved));
    return { audioPath, saved };
  }
  const cfg = o.appCfg;
  const tts = new ElevenLabsTTSProvider(cfg.ELEVENLABS_API_KEY ?? '', o.voice.id, o.voice.model, {
    timeoutMs: cfg.TTS_TIMEOUT_MS,
    maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS,
    usdPer1kChars: cfg.ELEVENLABS_USD_PER_1K_CHARS,
    speed: o.voice.speed,
    stability: o.voice.stability,
    style: o.voice.style,
  });
  const credits = tts.creditsFor(o.text);
  const account = await tts.remainingCredits();
  log(`narration: ${o.text.length} characters = ${credits} ElevenLabs credits` + (account ? `; ${account.remaining} of ${account.limit} remaining` : '; remaining credits unknown for this key'));
  if (account && account.remaining < credits) throw new Error(`not enough ElevenLabs credits (${account.remaining} < ${credits}); aborting before any request`);
  const res = await tts.synthesize({ text: o.text, speed: o.voice.speed });
  fs.writeFileSync(audioPath, res.audio);
  const saved: SavedNarration = { text: o.text, voiceId: res.voiceId, modelId: res.modelId, speed: o.voice.speed, characters: res.alignment.characters, startTimes: res.alignment.startTimes, endTimes: res.alignment.endTimes, credits };
  fs.writeFileSync(jsonPath, JSON.stringify(saved));
  return { audioPath, saved };
}
