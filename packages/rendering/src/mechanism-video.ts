import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigurationError, InternalError, logger, repoRoot, runFfmpeg, runProcess } from '@shorts/core';
import type { CaptionCue, MechanismVideoSpec } from '@shorts/schemas';
import { CAPTION_LAYOUT, emphasisIndex, layoutLines, type CaptionLayout } from './captions.js';

/** The Blender kit script (packages/rendering/blender/mechanism.py). */
export const MECHANISM_SCRIPT = path.join(repoRoot(), 'packages', 'rendering', 'blender', 'mechanism.py');

export interface NarrationWord {
  word: string;
  start: number;
  end: number;
  /** Index of the word's first character in the narrated text. */
  charStart: number;
}

/**
 * Words with start/end times from ElevenLabs character alignment. `characters` must be the
 * characters of the submitted text, in order (that is what the API returns), so a word's position
 * in the text is its character index.
 */
export function wordsFromAlignment(characters: string[], starts: number[], ends: number[]): NarrationWord[] {
  const words: NarrationWord[] = [];
  let cur: { chars: string; start: number; end: number; charStart: number } | null = null;
  characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push({ word: cur.chars, start: cur.start, end: cur.end, charStart: cur.charStart });
      cur = null;
    } else if (!cur) {
      cur = { chars: ch, start: starts[i], end: ends[i], charStart: i };
    } else {
      cur.chars += ch;
      cur.end = ends[i];
    }
  });
  if (cur) {
    const c: { chars: string; start: number; end: number; charStart: number } = cur;
    words.push({ word: c.chars, start: c.start, end: c.end, charStart: c.charStart });
  }
  return words;
}

/**
 * Carries each word's position in the narrated text over to the realigned (gap-tightened) timestamps.
 * Tightening keeps every word in order, so words are matched by index.
 */
export function retimeWords(original: NarrationWord[], tightened: Array<{ word: string; start: number; end: number }>): NarrationWord[] {
  if (original.length !== tightened.length) throw new InternalError(`retimeWords: ${original.length} words became ${tightened.length}`);
  return tightened.map((t, i) => {
    if (t.word !== original[i].word) throw new InternalError(`retimeWords: word ${i} changed ("${original[i].word}" -> "${t.word}")`);
    return { word: t.word, start: t.start, end: t.end, charStart: original[i].charStart };
  });
}

/** The text sent to the voice: beat texts joined with one space. */
export function narrationText(spec: MechanismVideoSpec): string {
  return spec.beats.map((b) => b.text.trim()).join(' ');
}

export interface PlannedBeat {
  index: number;
  start: number;
  end: number;
  firstWord: number;
  lastWord: number;
}

export interface HudEvent {
  start: number;
  end: number;
  text: string;
}

export interface MechanismPlan {
  seconds: number;
  beats: PlannedBeat[];
  hud: HudEvent[];
  /** Everything mechanism.py needs except paths (font, outDir). */
  blender: {
    kit: string;
    seconds: number;
    fps: number;
    width: number;
    height: number;
    drive: Array<{ t0: number; t1: number; from: number; to: number }>;
    camera_keys: Array<{ t: number; pos: [number, number, number]; look: [number, number, number] }>;
    labels: Array<{ text: string; part: string; t0: number; t1: number }>;
    shift_y: number;
    samples: number;
    style: 'studio' | 'pastel';
  };
}

export interface PlanOptions {
  /** Silence kept after the last word. */
  tailSeconds?: number;
  /** Camera move time at the start of each beat. */
  moveSeconds?: number;
  fps?: number;
  samples?: number;
}

const DEFAULT_DIR: [number, number, number] = [0.3, -1, 0.14];

/** Rotates a direction about the vertical axis (degrees); used for the slow orbit during a beat. */
function rotateZ(v: [number, number, number], deg: number): [number, number, number] {
  const a = (deg * Math.PI) / 180;
  return [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a), v[2]];
}

function cameraPosition(look: [number, number, number], dir: [number, number, number], distance: number): [number, number, number] {
  const n = Math.hypot(...dir);
  return [look[0] + (dir[0] / n) * distance, look[1] + (dir[1] / n) * distance, look[2] + (dir[2] / n) * distance];
}

/**
 * Turns the authored beats plus the narration's word timestamps into the Blender timeline: crank
 * angle segments, camera keys, label times and heading events. Pure and deterministic, so the
 * animation is locked to the voice and nothing is timed by guesswork.
 */
export function planMechanism(spec: MechanismVideoSpec, words: NarrationWord[], audioSeconds: number, opts: PlanOptions = {}): MechanismPlan {
  const tail = opts.tailSeconds ?? 0.6;
  const move = opts.moveSeconds ?? 0.7;
  const fps = opts.fps ?? 30;
  if (words.length === 0) throw new InternalError('cannot plan a mechanism video without narration words');

  // Where each beat's text begins in the joined narration.
  const charStarts: number[] = [];
  let offset = 0;
  for (const b of spec.beats) {
    charStarts.push(offset);
    offset += b.text.trim().length + 1;
  }
  const firstWord = charStarts.map((cs) => words.findIndex((w) => w.charStart >= cs));
  if (firstWord.some((i) => i < 0)) throw new InternalError('narration alignment does not cover every beat (text mismatch)');
  for (let i = 1; i < firstWord.length; i++) {
    if (firstWord[i] <= firstWord[i - 1]) throw new InternalError(`beat ${i} has no words of its own`);
  }

  const seconds = Math.max(audioSeconds, words[words.length - 1].end) + tail;
  const beats: PlannedBeat[] = spec.beats.map((_, i) => ({
    index: i,
    start: i === 0 ? 0 : words[firstWord[i]].start,
    end: i === spec.beats.length - 1 ? seconds : words[firstWord[i + 1]].start,
    firstWord: firstWord[i],
    lastWord: (i === spec.beats.length - 1 ? words.length : firstWord[i + 1]) - 1,
  }));

  const drive: MechanismPlan['blender']['drive'] = [];
  const camera_keys: MechanismPlan['blender']['camera_keys'] = [];
  const labels: MechanismPlan['blender']['labels'] = [];
  const hud: HudEvent[] = [];
  let lastAngle = spec.beats[0].crank?.[0] ?? 0;
  spec.beats.forEach((b, i) => {
    const pb = beats[i];
    const dur = pb.end - pb.start;
    const path = b.crankPath ?? [{ at: 0, deg: b.crank?.[0] ?? lastAngle }, { at: 1, deg: b.crank?.[1] ?? b.crank?.[0] ?? lastAngle }];
    if (path[0].at !== 0 || path[path.length - 1].at !== 1) throw new InternalError(`beat ${i}: crankPath must start at 0 and end at 1`);
    for (let k = 0; k < path.length - 1; k++) {
      drive.push({ t0: pb.start + path[k].at * dur, t1: pb.start + path[k + 1].at * dur, from: path[k].deg, to: path[k + 1].deg });
    }
    lastAngle = path[path.length - 1].deg;

    const dir = b.camera.dir ?? DEFAULT_DIR;
    const arrive = i === 0 ? 0 : Math.min(pb.start + move, pb.end);
    camera_keys.push({ t: arrive, pos: cameraPosition(b.camera.look, dir, b.camera.distance), look: b.camera.look });
    // A slow push-in with a few degrees of orbit (alternating direction) keeps the shot alive without cutting.
    camera_keys.push({ t: pb.end, pos: cameraPosition(b.camera.look, rotateZ(dir, i % 2 === 0 ? 9 : -9), b.camera.distance * 0.95), look: b.camera.look });

    for (const l of b.labels) {
      labels.push({ text: l.text, part: l.part, t0: pb.start + l.from * dur, t1: pb.start + Math.max(l.to, l.from + 0.1) * dur });
    }
    if (b.hud) hud.push({ start: pb.start, end: pb.end, text: b.hud });
  });

  return {
    seconds,
    beats,
    hud,
    blender: { kit: spec.kit, seconds, fps, width: 1080, height: 1920, drive, camera_keys, labels, shift_y: 0.05, samples: opts.samples ?? 20, style: 'studio' },
  };
}

/** Short word-synced caption cues (up to `maxWords` words, split at sentence ends and pauses). */
export function mechanismCaptionCues(words: NarrationWord[], layout: CaptionLayout = CAPTION_LAYOUT, maxWords = 3): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let group: number[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const first = words[group[0]];
    const last = words[group[group.length - 1]];
    const lines = layoutLines(group.map((i) => words[i].word.replace(/[“”"]/g, '')), layout);
    cues.push({
      index: cues.length,
      sceneNumber: 1,
      start: first.start,
      end: Math.max(last.end, first.start + 0.2),
      lines: lines.slice(0, 2),
      firstWordIndex: group[0],
      lastWordIndex: group[group.length - 1],
    });
    group = [];
  };
  words.forEach((w, i) => {
    group.push(i);
    const next = words[i + 1];
    const endsSentence = /[.!?:]$/.test(w.word);
    const pause = next ? next.start - w.end > 0.35 : true;
    if (group.length >= maxWords || endsSentence || pause) flush();
  });
  flush();
  // A cue stays up until the next one starts (no flicker in the gaps), capped at 0.5 s.
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = Math.min(cues[i + 1].start, cues[i].end + 0.5);
  return cues;
}

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const ASS_HEADER = (width: number, height: number, styles: string[]) => `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

/** Gold highlight (ASS colours are &HBBGGRR&). */
const HIGHLIGHT = '&H0000C8FF&';

/**
 * Word-synced captions in a clean bold sans (Montserrat Bold): white, soft outline and shadow, one
 * keyword per cue in gold, centred in the lower third.
 */
export function buildCaptionAss(cues: CaptionCue[], layout: CaptionLayout = CAPTION_LAYOUT): string {
  const style = ['Caption', 'Montserrat', 66, '&H00FFFFFF', '&H000000FF', '&H00101010', '&H78000000', -1, 0, 0, 0, 100, 100, 0.5, 0, 1, 3.4, 2.2, 2, 90, 90, 520, 1].join(',');
  const events = cues.map((c) => {
    const flat = c.lines.flatMap((l, li) => l.split(' ').map((w) => ({ w, li })));
    const k = emphasisIndex(flat.map((x) => x.w.toUpperCase())); // emphasisIndex expects capitals
    if (k >= 0) flat[k] = { ...flat[k], w: `{\\c${HIGHLIGHT}}${flat[k].w}{\\c&HFFFFFF&}` };
    const text = c.lines.map((_, li) => flat.filter((x) => x.li === li).map((x) => x.w).join(' ')).join('\\N');
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,{\\fad(60,40)}${text}`;
  });
  return ASS_HEADER(layout.width, layout.height, [`Style: ${style}`]) + events.join('\n') + '\n';
}

/**
 * Heading in the top-left safe area: small, letter-spaced capitals with no box, so it labels the
 * stroke without competing with the subject.
 */
export function buildHudAss(events: HudEvent[], layout: CaptionLayout = CAPTION_LAYOUT): string {
  const style = ['Hud', 'Montserrat SemiBold', 38, '&H00FFFFFF', '&H000000FF', '&H00101010', '&H64000000', 0, 0, 0, 0, 100, 100, 5, 0, 1, 2, 1.5, 7, 96, 96, 150, 1].join(',');
  return (
    ASS_HEADER(layout.width, layout.height, [`Style: ${style}`]) +
    events.map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Hud,,0,0,0,,{\\fad(250,200)}${e.text.toUpperCase().replace(/[{}]/g, '')}`).join('\n') +
    '\n'
  );
}

export interface MechanismRendererOptions {
  blenderPath: string;
  fontFile: string;
  /** Font for the part labels (default: fontFile). */
  labelFontFile?: string;
  cacheDir: string;
  timeoutMs?: number;
}

/**
 * Renders a planned timeline with headless Blender (Eevee) and encodes it to H.264 1080x1920 30 fps
 * (no audio). Results are cached by content hash: the same plan and kit script is never rendered twice.
 */
export class MechanismRenderer {
  readonly version: string;

  constructor(private readonly o: MechanismRendererOptions) {
    if (!fs.existsSync(o.blenderPath)) throw new ConfigurationError(`Blender not found at ${o.blenderPath} (set BLENDER_PATH or install Blender)`);
    if (!fs.existsSync(MECHANISM_SCRIPT)) throw new ConfigurationError(`mechanism kit script missing: ${MECHANISM_SCRIPT}`);
    this.version = `blender-mechanism:${createHash('sha256').update(fs.readFileSync(MECHANISM_SCRIPT)).digest('hex').slice(0, 10)}`;
  }

  cacheKey(plan: MechanismPlan): string {
    return createHash('sha256').update(JSON.stringify({ b: plan.blender, h: plan.hud.length, v: this.version })).digest('hex').slice(0, 24);
  }

  async render(plan: MechanismPlan, outPath: string): Promise<{ cached: boolean; renderSeconds: number }> {
    fs.mkdirSync(this.o.cacheDir, { recursive: true });
    const cached = path.join(this.o.cacheDir, `${this.cacheKey(plan)}.mp4`);
    let renderSeconds = 0;
    if (!fs.existsSync(cached)) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-mechanism-'));
      try {
        const frames = path.join(work, 'frames');
        const specFile = path.join(work, 'spec.json');
        fs.writeFileSync(specFile, JSON.stringify({ ...plan.blender, font: this.o.fontFile, label_font: this.o.labelFontFile ?? this.o.fontFile, outDir: frames }));
        const started = Date.now();
        const res = await runProcess(this.o.blenderPath, ['-b', '--factory-startup', '-P', MECHANISM_SCRIPT, '--', specFile], {
          timeoutMs: this.o.timeoutMs ?? 4 * 60 * 60_000,
          description: `blender ${plan.blender.kit} mechanism`,
        });
        if (res.code !== 0 || !/MECHANISM_OK/.test(res.stdout)) {
          throw new InternalError(`Blender failed to render the ${plan.blender.kit} mechanism (exit ${res.code}): ${(res.stderr || res.stdout).split(/\r?\n/).filter(Boolean).slice(-6).join(' | ')}`);
        }
        const tmpMp4 = path.join(work, 'out.mp4');
        await runFfmpeg(['-y', '-framerate', String(plan.blender.fps), '-i', path.join(frames, '%04d.png'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmpMp4], {
          description: 'encode mechanism frames',
        });
        fs.renameSync(tmpMp4, cached);
        renderSeconds = (Date.now() - started) / 1000;
        logger.info(`Rendered ${plan.blender.kit} mechanism (${plan.seconds.toFixed(1)} s of video) in ${renderSeconds.toFixed(0)} s`, { stage: 'MEDIA' });
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(cached, outPath);
    return { cached: renderSeconds === 0, renderSeconds };
  }
}

/** Runs the kit's collision sweep (mechanism.py "check" mode). Returns the interpenetrating part pairs. */
export async function checkMechanismKit(blenderPath: string, kit: string): Promise<string[]> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-mechanism-check-'));
  try {
    const specFile = path.join(work, 'spec.json');
    fs.writeFileSync(specFile, JSON.stringify({ kit, style: 'studio', seconds: 1, fps: 30, width: 270, height: 480, outDir: path.join(work, 'frames'), check: true }));
    const res = await runProcess(blenderPath, ['-b', '--factory-startup', '-P', MECHANISM_SCRIPT, '--', specFile], { timeoutMs: 10 * 60_000, description: `collision check ${kit}` });
    if (!/COLLISIONS_(NONE|FOUND)/.test(res.stdout)) {
      throw new InternalError(`collision check for ${kit} did not complete (exit ${res.code}): ${(res.stderr || res.stdout).split(/\r?\n/).filter(Boolean).slice(-4).join(' | ')}`);
    }
    return res.stdout.split(/\r?\n/).filter((l) => l.startsWith('COLLISION '));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
