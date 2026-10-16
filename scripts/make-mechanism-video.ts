/**
 * Narrated 3D mechanism video from a spec file.
 *
 *   pnpm mechanism content/mechanisms/four-stroke-engine.json            real ElevenLabs narration (spends credits once, then reuses the cached audio)
 *   pnpm mechanism content/mechanisms/four-stroke-engine.json --mock-voice   silent placeholder narration with synthetic timing (no credits; for iterating on the look)
 *   pnpm mechanism <spec> --plan-only                                    print the timeline and stop
 *   pnpm mechanism <spec> --remux                                        reuse the last Blender render; redo only captions, headings and audio
 *
 * Pipeline: narration (ElevenLabs, word timestamps) -> timeline (planMechanism) -> Blender kit render
 * -> captions + stroke headings (libass) -> loudness-normalised mux. Output: output/mechanism/<slug>/<slug>.mp4
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ElevenLabsTTSProvider } from '@shorts/providers';
import { cacheDir, detectSilence, ensureDir, loadConfig, measureLoudness, repoRoot, runFfmpeg, summarizeMedia, writeContactSheet } from '@shorts/core';
import {
  MechanismRenderer,
  buildCaptionAss,
  buildHudAss,
  findBlender,
  mechanismCaptionCues,
  narrationText,
  planMechanism,
  wordsFromAlignment,
} from '@shorts/rendering';
import { MechanismVideoSpecSchema } from '@shorts/schemas';

const args = process.argv.slice(2);
const specPath = args.find((a) => !a.startsWith('--'));
if (!specPath) {
  console.error('usage: pnpm mechanism <spec.json> [--mock-voice] [--plan-only]');
  process.exit(2);
}
const MOCK = args.includes('--mock-voice');
const PLAN_ONLY = args.includes('--plan-only');
const REMUX = args.includes('--remux'); // reuse the last silent render (captions/audio changes only)

const spec = MechanismVideoSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf-8')));
const cfg = loadConfig();
const outDir = ensureDir(path.join(cfg.outputDir, 'mechanism', spec.slug + (MOCK ? '-mock' : '')));
const text = narrationText(spec);

interface SavedNarration {
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

async function getNarration(): Promise<{ audioPath: string; saved: SavedNarration }> {
  const audioPath = path.join(outDir, MOCK ? 'narration.wav' : 'narration.mp3');
  const jsonPath = path.join(outDir, 'narration.json');
  const speed = spec.speed ?? cfg.ELEVENLABS_SPEED;
  if (fs.existsSync(jsonPath) && fs.existsSync(audioPath)) {
    const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as SavedNarration;
    if (saved.text === text && saved.speed === speed && Boolean(saved.mock) === MOCK && (MOCK || saved.voiceId === cfg.ELEVENLABS_VOICE_ID)) {
      console.log(`narration: reusing cached audio (${MOCK ? 'mock' : 'ElevenLabs'}), 0 credits spent`);
      return { audioPath, saved };
    }
    console.log('narration: text, voice or speed changed; regenerating');
  }
  if (MOCK) {
    // ~2.7 words per second, silent: lets the look and timing be reviewed without spending credits.
    const per = 0.056;
    const chars = [...text];
    const saved: SavedNarration = { text, voiceId: 'mock', modelId: 'mock', speed, characters: chars, startTimes: chars.map((_, i) => i * per), endTimes: chars.map((_, i) => (i + 1) * per), credits: 0, mock: true };
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', (chars.length * per).toFixed(2), audioPath], { description: 'mock narration' });
    fs.writeFileSync(jsonPath, JSON.stringify(saved));
    return { audioPath, saved };
  }

  const tts = new ElevenLabsTTSProvider(cfg.ELEVENLABS_API_KEY ?? '', cfg.ELEVENLABS_VOICE_ID, cfg.ELEVENLABS_MODEL_ID, {
    timeoutMs: cfg.TTS_TIMEOUT_MS,
    maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS,
    usdPer1kChars: cfg.ELEVENLABS_USD_PER_1K_CHARS,
    speed,
  });
  const credits = tts.creditsFor(text);
  const account = await tts.remainingCredits();
  console.log(`narration: ${text.length} characters = ${credits} ElevenLabs credits` + (account ? `; ${account.remaining} of ${account.limit} remaining` : '; remaining credits unknown for this key'));
  if (account && account.remaining < credits) throw new Error(`not enough ElevenLabs credits (${account.remaining} < ${credits}); aborting before any request`);
  const res = await tts.synthesize({ text, speed });
  fs.writeFileSync(audioPath, res.audio);
  const saved: SavedNarration = {
    text,
    voiceId: res.voiceId,
    modelId: res.modelId,
    speed,
    characters: res.alignment.characters,
    startTimes: res.alignment.startTimes,
    endTimes: res.alignment.endTimes,
    credits,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(saved));
  return { audioPath, saved };
}

async function main(): Promise<void> {
  const { audioPath, saved } = await getNarration();
  const words = wordsFromAlignment(saved.characters, saved.startTimes, saved.endTimes);
  const audioSeconds = (await summarizeMedia(audioPath)).durationSeconds ?? words[words.length - 1].end;
  const plan = planMechanism(spec, words, audioSeconds);
  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
  console.log(`plan: ${words.length} words, ${plan.seconds.toFixed(1)} s, ${(words.length / words[words.length - 1].end).toFixed(2)} words/s`);
  for (const b of plan.beats) console.log(`  beat ${b.index}: ${b.start.toFixed(2)}-${b.end.toFixed(2)} s  ${spec.beats[b.index].hud ?? ''}`);
  if (PLAN_ONLY) return;

  const blender = findBlender(cfg.BLENDER_PATH);
  if (!blender) throw new Error('Blender not found (install it or set BLENDER_PATH)');
  const fontFile = path.join(repoRoot(), 'assets', 'fonts', 'Montserrat-Bold.ttf');
  const labelFontFile = path.join(repoRoot(), 'assets', 'fonts', 'Montserrat-SemiBold.ttf');
  const renderer = new MechanismRenderer({ blenderPath: blender, fontFile, labelFontFile, cacheDir: path.join(cacheDir(cfg.outputDir, 'media'), '..', 'mechanism') });
  const silentVideo = path.join(outDir, 'video_silent.mp4');
  console.log('rendering with Blender (about 1 s per frame; a cached render is reused)...');
  if (REMUX && fs.existsSync(silentVideo)) console.log('render: reusing video_silent.mp4 (--remux)');
  else {
    const r = await renderer.render(plan, silentVideo);
    console.log(r.cached ? 'render: cache hit' : `render: ${(r.renderSeconds / 60).toFixed(1)} min`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-mech-mux-'));
  try {
    fs.cpSync(path.join(repoRoot(), 'assets', 'fonts'), path.join(work, 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(work, 'captions.ass'), buildCaptionAss(mechanismCaptionCues(words)));
    fs.writeFileSync(path.join(work, 'hud.ass'), buildHudAss(plan.hud));
    fs.copyFileSync(silentVideo, path.join(work, 'video.mp4'));
    fs.copyFileSync(audioPath, path.join(work, 'narration' + path.extname(audioPath)));
    const total = plan.seconds.toFixed(3);
    const finalPath = path.join(outDir, `${spec.slug}.mp4`);
    await runFfmpeg(
      [
        '-y', '-i', 'video.mp4', '-i', 'narration' + path.extname(audioPath),
        '-filter_complex',
        `[0:v]vignette=PI/3,eq=contrast=1.04:saturation=1.05:brightness=0.035:gamma=1.08,noise=alls=3:allf=t,ass=hud.ass:fontsdir=fonts,ass=captions.ass:fontsdir=fonts,scale=out_range=tv:out_color_matrix=bt709,format=yuv420p[v];` +
          `[1:a]aresample=48000,${MOCK ? '' : 'loudnorm=I=-14:TP=-1.5:LRA=11,'}apad,atrim=0:${total},aformat=sample_fmts=fltp:channel_layouts=stereo[a]`,
        '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', total, 'out.mp4',
      ],
      { cwd: work, description: 'mux captions + narration' }
    );
    fs.copyFileSync(path.join(work, 'out.mp4'), finalPath);

    const probe = await summarizeMedia(finalPath);
    const loud = MOCK ? null : await measureLoudness(finalPath);
    const silences = MOCK ? [] : await detectSilence(finalPath, -45, 0.5);
    const times = Array.from({ length: 7 }, (_, i) => 0.5 + ((plan.seconds - 2) * i) / 6);
    const sheet = path.join(outDir, 'contact-sheet.jpg');
    await writeContactSheet(finalPath, times, 640, sheet);
    console.log(`\nDONE: ${finalPath}`);
    console.log(`  duration ${probe.durationSeconds?.toFixed(1)} s${loud ? `, ${JSON.stringify(loud)}` : ''}, silences >0.5 s: ${silences.length}`);
    console.log(`  contact sheet: ${sheet}`);
    console.log(`  narration credits: ${saved.credits}${MOCK ? ' (mock)' : ''}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
