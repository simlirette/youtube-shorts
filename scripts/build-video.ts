/**
 * Build complete videos from the BASE + a per-video config.
 *
 *   pnpm video videos/dam/video.json                      one video
 *   pnpm video "videos/*\/video.json"                      every video (quote the pattern); same as video:batch
 *   pnpm video videos/dam/video.json --plan-only          validate and print the timeline, no render, no credits
 *   pnpm video videos/dam/video.json --mock-voice         silent placeholder narration (look and timing only)
 *   pnpm video videos/dam/video.json --remux              reuse the last Blender render; redo overlays/audio only
 *   pnpm video videos/dam/video.json --suggest-callouts   list numbers in the script that could get a fact card
 *   pnpm video videos/dam/video.json --text-style=both    the same video in both text styles (<slug>.classic.mp4 and <slug>.premium.mp4), one Blender render
 *
 * Per video: narration (ElevenLabs, the base's fixed voice) -> timeline from the word timestamps -> Blender render
 * of the frozen scene (+ the video's own kit.py if it brings a new subject) -> overlays (progress tracker, hook,
 * fact cards, captions, outro) -> loudness-normalised mux. Output: output/videos/<slug>/.
 * Several videos are built one after another; one failing does not stop the others.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheDir, detectSilence, ensureDir, loadConfig, measureLoudness, repoRoot, runFfmpeg, summarizeMedia, tightenNarrationWav, writeContactSheet } from '@shorts/core';
import {
  MechanismRenderer,
  overlayPointers,
  placePills,
  probeAnchors,
  calloutEvents,
  effectiveConfig,
  findBlender,
  hookTextFor,
  lengthWarnings,
  loadBase,
  loadVideo,
  narrationText,
  planMechanism,
  planOptionsFor,
  progressSegments,
  retimeWords,
  splitPointerLabels,
  toMechanismSpec,
  verifyFrozen,
  wordsFromAlignment,
  type AnchorTracks,
  type PointerLabel,
  overlayLayers,
} from '@shorts/rendering';
import type { TextStyleName } from '@shorts/schemas';
import { ensureNarration } from './lib/narration.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const MOCK = flags.has('--mock-voice');
const PLAN_ONLY = flags.has('--plan-only');
const REMUX = flags.has('--remux');
const SUGGEST = flags.has('--suggest-callouts');
const patterns = args.filter((a) => !a.startsWith('--'));
// --text-style=classic|premium|both: render with that text style (both = one file per style, sharing one Blender render).
const styleFlag = args.find((a) => a.startsWith('--text-style='))?.split('=')[1];
if (styleFlag && !['classic', 'premium', 'both'].includes(styleFlag)) {
  console.error('--text-style must be classic, premium or both');
  process.exit(2);
}
const STYLES: TextStyleName[] | null = styleFlag ? (styleFlag === 'both' ? ['classic', 'premium'] : [styleFlag as TextStyleName]) : null;

function expand(pattern: string): string[] {
  if (!/[*?]/.test(pattern)) return [pattern];
  return fs.globSync(pattern.replace(/\\/g, '/'), { cwd: repoRoot() }).map((f) => path.join(repoRoot(), f)).sort();
}
const files = patterns.flatMap(expand);
if (files.length === 0) {
  console.error('usage: pnpm video <videos/slug/video.json | "videos/*/video.json"> [--plan-only] [--mock-voice] [--remux] [--suggest-callouts] [--text-style=classic|premium|both]');
  process.exit(2);
}

interface Summary {
  slug: string;
  ok: boolean;
  seconds?: number;
  file?: string;
  warnings: string[];
  error?: string;
}

async function buildOne(file: string): Promise<Summary> {
  const loaded = loadVideo(file);
  const { video } = loaded;
  const base = loadBase(video.base);
  const frozen = verifyFrozen(base);
  if (frozen.length) throw new Error(`the frozen visual layer was changed: ${frozen.join('; ')}. Revert it, or re-freeze deliberately with "pnpm base:freeze --confirm".`);
  const cfg = effectiveConfig(base, video);
  const spec = toMechanismSpec(video, base);
  const text = narrationText(spec);
  const hook = hookTextFor(cfg, video);
  const warnings: string[] = [];
  if ((video.steps === undefined) !== (video.scenes.every((s) => s.step === undefined))) warnings.push('"steps" and the scenes\' "step" fields should be used together');

  if (SUGGEST) {
    const nums = [...text.matchAll(/\b(\d[\d,.]*%?|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|half|double|twice)\b/gi)].map((m) => m[0]);
    console.log(`${video.slug}: numbers in the script that could get a fact card: ${[...new Set(nums.map((n) => n.toLowerCase()))].join(', ') || '(none)'}`);
  }

  const appCfg = loadConfig();
  const outDir = ensureDir(path.join(appCfg.outputDir, 'videos', video.slug + (MOCK ? '-mock' : '')));
  const { audioPath, saved } = await ensureNarration({ outDir, text, voice: base.voice, mock: MOCK, appCfg });

  let words = wordsFromAlignment(saved.characters, saved.startTimes, saved.endTimes);
  let audioForVideo = audioPath;
  if (!MOCK) {
    // Pauses between sentences are shortened to base.voice.pauseTargetSeconds; word timestamps follow the edited audio.
    const wav = path.join(outDir, 'narration_tight.wav');
    await runFfmpeg(['-y', '-i', audioPath, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', wav], { description: 'decode narration' });
    const cut = tightenNarrationWav(wav, words, { leadSeconds: base.voice.leadSeconds, gapTargetSeconds: base.voice.pauseTargetSeconds, tailSeconds: base.voice.tailSeconds });
    console.log(`narration: tightened ${cut.gapsTightened} pauses, removed ${cut.secondsRemoved.toFixed(1)} s, longest pause now ${cut.maxGapAfterSeconds.toFixed(2)} s`);
    words = retimeWords(words, cut.words);
    audioForVideo = wav;
  }
  const audioSeconds = (await summarizeMedia(audioForVideo)).durationSeconds ?? words[words.length - 1].end;
  let plan = planMechanism(spec, words, audioSeconds, planOptionsFor(video, cfg));
  warnings.push(...lengthWarnings(plan.seconds, cfg));
  // Part labels: with overlay pointers the pills are drawn in the overlay layer (at the frame edge, with a leader line
  // to the part) and Blender is given no labels at all. The frozen script is not edited; its label input is just empty.
  const ptr = overlayPointers(cfg);
  let pointerLabels: PointerLabel[] = [];
  if (ptr) {
    const split = splitPointerLabels(plan, video);
    plan = split.plan;
    pointerLabels = split.labels;
  }
  const callouts = calloutEvents(video, cfg, words, plan, text);
  const segments = progressSegments(plan, video.steps ?? [], cfg.progress);

  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify({ ...plan, pointers: pointerLabels }, null, 2));
  console.log(`${video.slug}: ${words.length} words, ${plan.seconds.toFixed(1)} s, ${(words.length / words[words.length - 1].end).toFixed(2)} words/s; hook: "${hook}"`);
  for (const b of plan.beats) console.log(`  scene ${b.index}: ${b.start.toFixed(2)}-${b.end.toFixed(2)} s`);
  for (const w of warnings) console.log(`  warning: ${w}`);
  if (PLAN_ONLY) return { slug: video.slug, ok: true, seconds: plan.seconds, warnings };

  const blender = findBlender(appCfg.BLENDER_PATH);
  if (!blender) throw new Error('Blender not found (install it or set BLENDER_PATH)');
  const fontsDir = path.join(repoRoot(), base.fonts.dir);
  const renderer = new MechanismRenderer({
    blenderPath: blender,
    fontFile: path.join(fontsDir, base.fonts.caption),
    labelFontFile: path.join(fontsDir, base.fonts.label),
    cacheDir: path.join(cacheDir(appCfg.outputDir, 'media'), '..', 'mechanism'),
    kitFile: loaded.kitFile,
    entryScript: loaded.kitFile ? path.join(repoRoot(), base.frozen.blenderEntry) : undefined,
  });
  const mechanismCache = path.join(cacheDir(appCfg.outputDir, 'media'), '..', 'mechanism');
  let tracks: AnchorTracks = {};
  if (ptr && pointerLabels.length) {
    tracks = await probeAnchors({
      blenderPath: blender,
      plan,
      parts: [...new Set(pointerLabels.map((l) => l.part))],
      kitFile: loaded.kitFile,
      entryScript: path.join(repoRoot(), base.frozen.blenderEntry),
      probeKit: path.join(repoRoot(), 'base', base.version, 'probe_kit.py'),
      cacheDir: mechanismCache,
    });
    const shown = placePills(pointerLabels, tracks, ptr);
    console.log(`pointers: ${shown.length} of ${pointerLabels.length} part labels placed at the frame edge`);
    for (const l of pointerLabels) if (!shown.some((p) => p.label === l)) warnings.push(`label "${l.text}" (${l.part}) is not drawn: its part is off screen or there is no free spot for its pill`);
  }
  const silentVideo = path.join(outDir, 'video_silent.mp4');
  if (REMUX && fs.existsSync(silentVideo)) console.log('render: reusing video_silent.mp4 (--remux)');
  else {
    console.log('rendering with Blender (about 1 s per frame; a cached render is reused)...');
    const r = await renderer.render(plan, silentVideo);
    console.log(r.cached ? 'render: cache hit' : `render: ${(r.renderSeconds / 60).toFixed(1)} min`);
  }

  // Overlays, all from the config. One pass per text style: the Blender render, the narration and every timing are
  // shared, so the styles differ only in the overlay layers.
  const styles: TextStyleName[] = STYLES ?? [cfg.text_style ?? 'classic'];
  const planKey = (c: typeof cfg): string => JSON.stringify(planOptionsFor(video, c));
  const outputs: Array<{ style: TextStyleName; file: string }> = [];
  for (const style of styles) {
    const styled = effectiveConfig(base, video, style);
    if (planKey(styled) !== planKey(cfg)) throw new Error(`text style "${style}" would change the timeline (outro length); styles may only change how text looks`);
    const layers = overlayLayers({ cfg: styled, video, words, plan, hook, callouts, segments, pointerLabels, tracks, fps: base.render.fps });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-video-mux-'));
    try {
      fs.cpSync(fontsDir, path.join(work, 'fonts'), { recursive: true });
      for (const l of layers) fs.writeFileSync(path.join(work, `${l.name}.ass`), l.ass);
      fs.copyFileSync(silentVideo, path.join(work, 'video.mp4'));
      fs.copyFileSync(audioForVideo, path.join(work, 'narration' + path.extname(audioForVideo)));
      const total = plan.seconds.toFixed(3);
      const g = base.render.grade;
      const chain = [`eq=contrast=${g.contrast}:saturation=${g.saturation}`, ...(g.grain > 0 ? [`noise=alls=${g.grain}:allf=t`] : []), ...layers.map((l) => `ass=${l.name}.ass:fontsdir=fonts`), 'scale=out_range=tv:out_color_matrix=bt709', `format=${base.render.video.pixFmt}`].join(',');
      const a = base.render.audio;
      const finalPath = path.join(outDir, STYLES ? `${video.slug}.${style}.mp4` : `${video.slug}.mp4`);
      await runFfmpeg(
        [
          '-y', '-i', 'video.mp4', '-i', 'narration' + path.extname(audioForVideo),
          '-filter_complex', `[0:v]${chain}[v];[1:a]aresample=48000,${MOCK ? '' : `loudnorm=I=${a.loudnessLufs}:TP=${a.truePeakDb}:LRA=11,`}apad,atrim=0:${total},aformat=sample_fmts=fltp:channel_layouts=stereo[a]`,
          '-map', '[v]', '-map', '[a]', '-c:v', base.render.video.codec, '-preset', base.render.video.preset, '-crf', String(base.render.video.crf), '-c:a', a.codec, '-b:a', a.bitrate, '-movflags', '+faststart', '-t', total, 'out.mp4',
        ],
        { cwd: work, description: `mux overlays + narration (${style})` }
      );
      fs.copyFileSync(path.join(work, 'out.mp4'), finalPath);
      if (STYLES) fs.writeFileSync(path.join(outDir, `${video.slug}.${style}.ass.txt`), layers.map((l) => `# ${l.name}\n${l.ass}`).join('\n'));

      const probe = await summarizeMedia(finalPath);
      const w = probe.video?.width;
      const h = probe.video?.height;
      if (w !== base.render.width || h !== base.render.height) throw new Error(`output is ${w}x${h}, expected ${base.render.width}x${base.render.height}`);
      const loud = MOCK ? null : await measureLoudness(finalPath);
      const silences = MOCK ? [] : await detectSilence(finalPath, -45, 0.5);
      const times = Array.from({ length: 7 }, (_, i) => 0.5 + ((plan.seconds - 1.5) * i) / 6);
      await writeContactSheet(finalPath, times, 640, path.join(outDir, STYLES ? `contact-sheet.${style}.jpg` : 'contact-sheet.jpg'));

      if (style === styles[0]) {
        const meta = { slug: video.slug, title: video.title, hook, hashtags: video.hashtags, description: video.description ?? '', seconds: +plan.seconds.toFixed(2), scenes: video.scenes.length, steps: video.steps ?? [], callouts: callouts.map((c) => ({ ...c, start: +c.start.toFixed(2), end: +c.end.toFixed(2) })), base: base.version, textStyles: styles, subject: video.subject, resolution: `${w}x${h}`, loudness: loud, narrationCredits: saved.credits, warnings };
        fs.writeFileSync(path.join(outDir, `${video.slug}.meta.json`), JSON.stringify(meta, null, 2));
        fs.writeFileSync(path.join(outDir, `${video.slug}.post.txt`), `${video.title}\n\n${video.description ?? ''}\n\n${video.hashtags.join(' ')}\n`);
      }
      console.log(`\nDONE (${style}): ${finalPath}`);
      console.log(`  ${w}x${h}, ${plan.seconds.toFixed(1)} s${loud ? `, ${JSON.stringify(loud)}` : ''}, silences >0.5 s: ${silences.length}, narration credits ${saved.credits}${MOCK ? ' (mock)' : ''}`);
      outputs.push({ style, file: finalPath });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  return { slug: video.slug, ok: true, seconds: plan.seconds, file: outputs[0].file, warnings };
}

const results: Summary[] = [];
for (const f of files) {
  try {
    results.push(await buildOne(f));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\nFAILED ${f}: ${msg}`);
    results.push({ slug: path.basename(path.dirname(f)), ok: false, warnings: [], error: msg });
  }
}
if (results.length > 1) {
  console.log('\nsummary');
  for (const r of results) console.log(`  ${r.ok ? 'ok    ' : 'FAILED'} ${r.slug}${r.seconds ? `  ${r.seconds.toFixed(1)} s` : ''}${r.error ? `  ${r.error.slice(0, 120)}` : ''}`);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
