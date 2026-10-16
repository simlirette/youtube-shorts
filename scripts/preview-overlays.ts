/**
 * Draws the caption / stepper / title overlays onto frames of an existing silent render, without re-rendering.
 *   pnpm tsx scripts/preview-overlays.ts content/mechanisms/four-stroke-engine.json t1,t2,...
 * Uses the cached narration of that video (output/mechanism/<slug>/narration.json).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, repoRoot, runFfmpeg } from '@shorts/core';
import { buildCaptionAss, buildHudAss, buildStepperAss, mechanismCaptionCues, narrationText, planMechanism, wordsFromAlignment } from '@shorts/rendering';
import { MechanismVideoSpecSchema } from '@shorts/schemas';

const [specPath, timesArg] = process.argv.slice(2);
const spec = MechanismVideoSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf-8')));
const dir = path.join(loadConfig().outputDir, 'mechanism', spec.slug);
const saved = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf-8'));
if (saved.text !== narrationText(spec)) console.warn('note: cached narration text differs from the spec; timing is approximate');
const words = wordsFromAlignment(saved.characters, saved.startTimes, saved.endTimes);
const plan = planMechanism(spec, words, words[words.length - 1].end);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-preview-'));
fs.cpSync(path.join(repoRoot(), 'assets', 'fonts'), path.join(work, 'fonts'), { recursive: true });
fs.writeFileSync(path.join(work, 'captions.ass'), buildCaptionAss(mechanismCaptionCues(words), words));
fs.writeFileSync(path.join(work, 'stepper.ass'), buildStepperAss(plan.stepper));
fs.writeFileSync(path.join(work, 'hud.ass'), buildHudAss(plan.hud));
fs.copyFileSync(path.join(dir, 'video_silent.mp4'), path.join(work, 'video.mp4'));
const times = (timesArg ?? '5,12,22,28,34').split(',').map(Number);
const outs: string[] = [];
for (const [i, t] of times.entries()) {
  const out = `f${i}.png`;
  await runFfmpeg(['-y', '-i', 'video.mp4', '-ss', String(t), '-vf', 'ass=stepper.ass:fontsdir=fonts,ass=hud.ass:fontsdir=fonts,ass=captions.ass:fontsdir=fonts', '-frames:v', '1', out], { cwd: work, description: 'overlay frame' });
  outs.push(out);
}
// -ss is placed after -i (output seeking) so the subtitle timestamps are not shifted.
const sheet = path.join(dir, 'overlay-preview.png');
await runFfmpeg(['-y', ...outs.flatMap((o) => ['-i', o]), '-filter_complex', `${outs.map((_, i) => `[${i}:v]scale=432:-1[s${i}]`).join(';')};${outs.map((_, i) => `[s${i}]`).join('')}hstack=inputs=${outs.length}`, sheet], { cwd: work, description: 'sheet' });
fs.copyFileSync(path.join(work, 'f0.png'), path.join(dir, 'overlay-preview-0.png'));
console.log(sheet);
fs.rmSync(work, { recursive: true, force: true });
