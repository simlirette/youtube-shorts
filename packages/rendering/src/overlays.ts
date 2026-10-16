import { InternalError } from '@shorts/core';
import type { CalloutStyle, CaptionCue, CaptionsConfig, HookStyle, OutroConfig, ProgressConfig, VideoHook } from '@shorts/schemas';
import { CAPTION_LAYOUT, emphasisIndex } from './captions.js';
import { ASS_HEADER, assTime, disc, mechanismCaptionCues, type NarrationWord } from './mechanism-video.js';

/**
 * The BASE overlay engine: every size, colour, position and timing comes from base.json (or a video's
 * `overrides`), expressed as a percentage of the frame, so one video can never fork the code.
 * All overlays are ASS subtitle layers burned in by FFmpeg: they never touch the Blender render.
 */

export const FRAME_W = 1080;
export const FRAME_H = 1920;

interface Font {
  family: string;
  bold: boolean;
  sizePct: number;
}
interface Stroke {
  widthPct: number;
  color: string;
  shadowPct: number;
}

export const px = (pct: number, total: number): number => (pct / 100) * total;
const r = (n: number): number => Math.round(n);

/** "#RRGGBB" as an ASS override colour (&HBBGGRR&). */
export function assColour(hex: string): string {
  const h = hex.replace('#', '');
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
}

/** "#RRGGBB" as an ASS style colour (&HAABBGGRR). */
function styleColour(hex: string, alpha = '00'): string {
  const h = hex.replace('#', '');
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

/** ASS style line. Alignment 5 = centred on \pos. Sizes come in as % of the frame height. */
function assStyle(name: string, font: Font, stroke: Stroke, primary: string, H = FRAME_H, alignment = 5, spacing = 0): string {
  return [
    name, font.family, r(px(font.sizePct, H)), styleColour(primary), '&H000000FF', styleColour(stroke.color), '&HB4000000',
    font.bold ? -1 : 0, 0, 0, 0, 100, 100, spacing, 0, 1, +px(stroke.widthPct, H).toFixed(1), +px(stroke.shadowPct, H).toFixed(1), alignment, 0, 0, 0, 1,
  ].join(',');
}

/** Characters that fit on one line: usable width over the average glyph width (about 0.6 em; ASS font size is the line cell, about 1.22 em). */
export function lineBudget(font: Font, safeWidthPct: number, W = FRAME_W, H = FRAME_H): number {
  const em = px(font.sizePct, H) / 1.22;
  return Math.max(4, Math.floor(px(safeWidthPct, W) / (0.6 * em)));
}

function wrap(text: string, budget: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= budget) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Parts of [start, end] that fall outside every suppressed window. */
function outside(start: number, end: number, windows: Array<[number, number]>): Array<[number, number]> {
  let parts: Array<[number, number]> = [[start, end]];
  for (const [a, b] of windows) {
    parts = parts.flatMap(([s, e]) => {
      if (b <= s || a >= e) return [[s, e] as [number, number]];
      const out: Array<[number, number]> = [];
      if (a > s) out.push([s, a]);
      if (b < e) out.push([b, e]);
      return out;
    });
  }
  // An untouched event is kept however short (a short word still needs its highlight). A sliver left over at the
  // edge of a window would show as a one-frame flash, so clipped fragments under 0.12 s are dropped.
  if (parts.length === 1 && parts[0][0] === start && parts[0][1] === end) return parts;
  return parts.filter(([s, e]) => e - s >= 0.12);
}

// ---------------------------------------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------------------------------------

/** Caption phrases for a captions config (a phrase never needs more lines than `maxLines`). */
export function captionCues(words: NarrationWord[], cfg: CaptionsConfig, W = FRAME_W, H = FRAME_H): CaptionCue[] {
  const maxWords = cfg.layout === 'single' ? 1 : cfg.maxWordsPerCue;
  return mechanismCaptionCues(words, { ...CAPTION_LAYOUT, maxCharsPerLine: lineBudget(cfg.font, cfg.safeWidthPct, W, H) }, maxWords, cfg.maxLines);
}

const wordKey = (w: string): string => w.toLowerCase().replace(/[^a-z0-9']/g, '');

export interface CaptionOptions {
  /** Spoken word (lower case, no punctuation) -> text drawn instead; the timing is unchanged. */
  display?: Record<string, string>;
  /** Time windows in which no caption is drawn (the hook line, the outro). */
  suppress?: Array<[number, number]>;
}

/**
 * Captions, centred at cfg.position. timing "word": one event per word, from the ElevenLabs word timestamps; the
 * word being said is `current`, words already said are `spoken`, words still to come are `upcoming`.
 * timing "phrase": the phrase appears whole, with one keyword in the `current` colour.
 */
export function buildCaptionOverlay(cues: CaptionCue[], words: NarrationWord[], cfg: CaptionsConfig, opts: CaptionOptions = {}, W = FRAME_W, H = FRAME_H): string {
  const style = assStyle('Caption', cfg.font, cfg.stroke, cfg.colors.spoken, H);
  const pos = `\\an5\\pos(${r(px(cfg.position.xPct, W))},${r(px(cfg.position.yPct, H))})`;
  const display = Object.fromEntries(Object.entries(opts.display ?? {}).map(([k, v]) => [wordKey(k), v]));
  const suppress = opts.suppress ?? [];
  const events: string[] = [];
  const shown = (w: string): string => {
    const t = display[wordKey(w)] ?? w;
    return cfg.uppercase ? t.toUpperCase() : t;
  };
  for (const c of cues) {
    const first = c.firstWordIndex;
    const last = c.lastWordIndex;
    const tokens: Array<{ w: string; line: number }> = [];
    c.lines.forEach((l, li) => l.split(' ').forEach((w) => tokens.push({ w, line: li })));
    if (tokens.length !== last - first + 1) throw new InternalError(`caption cue ${c.index}: ${tokens.length} displayed words for ${last - first + 1} spoken words`);
    const render = (stateOf: (j: number) => string): string =>
      c.lines.map((_, li) => tokens.map((t, j) => ({ t, j })).filter((x) => x.t.line === li).map((x) => `{\\c${assColour(stateOf(x.j))}}${shown(x.t.w)}`).join(' ')).join('\\N');
    const push = (start: number, end: number, body: string, fadeIn: boolean, fadeOut: boolean): void => {
      for (const [s, e] of outside(start, end, suppress)) {
        const fade = fadeIn || fadeOut ? `\\fad(${fadeIn ? cfg.fadeMs.in : 0},${fadeOut ? cfg.fadeMs.out : 0})` : '';
        events.push(`Dialogue: 1,${assTime(s)},${assTime(e)},Caption,,0,0,0,,{${pos}${fade}}${body}`);
      }
    };
    if (cfg.timing === 'word') {
      for (let k = 0; k < tokens.length; k++) {
        const start = words[first + k].start;
        const end = k < tokens.length - 1 ? words[first + k + 1].start : c.end;
        if (end <= start) continue;
        push(start, end, render((j) => (j < k ? cfg.colors.spoken : j === k ? cfg.colors.current : cfg.colors.upcoming)), k === 0, k === tokens.length - 1);
      }
    } else {
      const key = emphasisIndex(tokens.map((t) => t.w.toUpperCase()));
      push(c.start, c.end, render((j) => (j === key ? cfg.colors.current : cfg.colors.spoken)), true, true);
    }
  }
  return ASS_HEADER(W, H, [`Style: ${style}`]) + events.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------------------------------------

/** The hook line from a formula and its fields (e.g. "How a {input} Becomes a {output}"). */
export function hookLine(formulas: HookStyle['formulas'], hook: VideoHook): string {
  const template = formulas[hook.formula];
  const fields = hook as unknown as Record<string, string>;
  const text = template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = fields[k];
    if (v === undefined) throw new InternalError(`hook formula "${hook.formula}" needs the field "${k}"`);
    return v;
  });
  return text.trim();
}

/** Large centred hook line, on screen from the first frame. Numbers use the accent colour. */
export function buildHookOverlay(text: string, cfg: HookStyle, W = FRAME_W, H = FRAME_H): string {
  const style = assStyle('Hook', cfg.font, cfg.stroke, cfg.colors.text, H);
  const shown = cfg.uppercase ? text.toUpperCase() : text;
  const lines = wrap(shown, lineBudget(cfg.font, cfg.safeWidthPct, W, H));
  const body = lines
    .map((l) => (cfg.accentNumbers ? l.replace(/(\d[\d,.]*%?)/g, `{\\c${assColour(cfg.colors.accent)}}$1{\\c${assColour(cfg.colors.text)}}`) : l))
    .join('\\N');
  const pos = `\\an5\\pos(${r(px(cfg.position.xPct, W))},${r(px(cfg.position.yPct, H))})`;
  const ev = `Dialogue: 2,${assTime(0)},${assTime(cfg.seconds)},Hook,,0,0,0,,{${pos}\\fad(${cfg.fadeMs.in},${cfg.fadeMs.out})}${body}`;
  return ASS_HEADER(W, H, [`Style: ${style}`]) + ev + '\n';
}

// ---------------------------------------------------------------------------------------------------------
// Progress tracker
// ---------------------------------------------------------------------------------------------------------

export interface ProgressSegment {
  start: number;
  end: number;
  /** Active step; -1 = none yet (all dim); steps.length = all done. */
  index: number;
}

/** The step tracker (INTAKE > COMPRESSION > POWER > EXHAUST style), visible from frame 1 when configured. */
export function buildProgressOverlay(steps: string[], segments: ProgressSegment[], cfg: ProgressConfig, W = FRAME_W, H = FRAME_H): string {
  const label = assStyle('Step', cfg.inactiveFont, cfg.stroke, '#FFFFFF', H, 8, 3);
  const labelOn = assStyle('StepOn', cfg.activeFont, cfg.stroke, '#FFFFFF', H, 8, 3);
  const draw = ['Draw', 'Montserrat', 20, '&H00FFFFFF', '&H000000FF', '&H00000000', '&H00000000', 0, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 7, 0, 0, 0, 1].join(',');
  const n = steps.length;
  const cy = r(px(cfg.yPct, H));
  const spread = px(cfg.spreadPct, W);
  const xs = steps.map((_, i) => r(W / 2 + (i - (n - 1) / 2) * (spread / Math.max(1, n - 1))));
  const out: string[] = [];
  const segs = [...segments].sort((a, b) => a.start - b.start);
  segs.forEach((e, ei) => {
    const t = `${assTime(e.start)},${assTime(e.end)}`;
    const firstOfRun = ei === 0 || segs[ei - 1].end < e.start - 0.01;
    const lastOfRun = ei === segs.length - 1 || segs[ei + 1].start > e.end + 0.01;
    const fadeIn = firstOfRun && !(cfg.visibleFromStart && e.start <= 0.001) ? 250 : 0;
    const fade = `\\fad(${fadeIn},${lastOfRun ? 200 : 0})`;
    const base = `{\\an7\\pos(0,0)\\p1${fade}`;
    const lineH = Math.max(2, r(px(0.2, H)));
    out.push(`Dialogue: 0,${t},Draw,,0,0,0,,${base}\\c${assColour(cfg.colors.line)}\\1a&H50&}m ${xs[0]} ${cy - lineH} l ${xs[n - 1]} ${cy - lineH} l ${xs[n - 1]} ${cy + lineH} l ${xs[0]} ${cy + lineH}{\\p0}`);
    const reach = e.index >= n ? n - 1 : e.index;
    if (reach >= 0) out.push(`Dialogue: 0,${t},Draw,,0,0,0,,${base}\\c${assColour(cfg.colors.done)}}m ${xs[0]} ${cy - lineH} l ${xs[reach]} ${cy - lineH} l ${xs[reach]} ${cy + lineH} l ${xs[0]} ${cy + lineH}{\\p0}`);
    steps.forEach((s, i) => {
      const on = i === e.index;
      const colour = on ? cfg.colors.active : i < e.index ? cfg.colors.done : cfg.colors.upcoming;
      out.push(`Dialogue: 1,${t},Draw,,0,0,0,,${base}\\c${assColour(colour)}}${disc(xs[i], cy, r(px(on ? cfg.dotRadiusPct.active : cfg.dotRadiusPct.inactive, H)))}{\\p0}`);
      const dim = !on && i > e.index ? '\\1a&H40&' : '';
      out.push(`Dialogue: 2,${t},${on ? 'StepOn' : 'Step'},,0,0,0,,{\\an8\\pos(${xs[i]},${cy + r(px(1.9, H))})${fade}${dim}}${s.toUpperCase()}`);
    });
  });
  return ASS_HEADER(W, H, [`Style: ${label}`, `Style: ${labelOn}`, `Style: ${draw}`]) + out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------
// Fact callouts
// ---------------------------------------------------------------------------------------------------------

export interface CalloutEvent {
  start: number;
  end: number;
  value: string;
  label?: string;
}

function roundedRect(x: number, y: number, w: number, h: number, rad: number): string {
  const pts: Array<[number, number]> = [];
  const corners: Array<[number, number, number]> = [
    [x + w - rad, y + rad, -90],
    [x + w - rad, y + h - rad, 0],
    [x + rad, y + h - rad, 90],
    [x + rad, y + rad, 180],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let j = 0; j <= 6; j++) {
      const a = ((a0 + (90 * j) / 6) * Math.PI) / 180;
      pts.push([r(cx + rad * Math.cos(a)), r(cy + rad * Math.sin(a))]);
    }
  }
  return `m ${pts[0][0]} ${pts[0][1]} l ${pts.slice(1).map((p) => `${p[0]} ${p[1]}`).join(' ')}`;
}

/** Yellow stat cards with a black outline, for surprising numbers. */
export function buildCalloutOverlay(items: CalloutEvent[], cfg: CalloutStyle, W = FRAME_W, H = FRAME_H): string {
  const valueStyle = assStyle('CalloutValue', cfg.valueFont, { widthPct: 0, color: '#000000', shadowPct: 0 }, cfg.text, H);
  const labelStyle = assStyle('CalloutLabel', cfg.labelFont, { widthPct: 0, color: '#000000', shadowPct: 0 }, cfg.text, H);
  const draw = ['CalloutDraw', 'Montserrat', 20, '&H00FFFFFF', '&H000000FF', '&H00000000', '&H00000000', 0, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 7, 0, 0, 0, 1].join(',');
  const vH = px(cfg.valueFont.sizePct, H);
  const lH = px(cfg.labelFont.sizePct, H);
  const pad = px(cfg.paddingPct, H);
  const cx = px(cfg.position.xPct, W);
  const cy = px(cfg.position.yPct, H);
  const out: string[] = [];
  for (const it of items) {
    const vW = it.value.length * (vH / 1.22) * 0.68;
    const lW = it.label ? it.label.length * (lH / 1.22) * 0.62 : 0;
    const w = Math.min(W * 0.92, Math.max(vW, lW) + pad * 2);
    const h = vH * 0.95 + (it.label ? lH * 1.35 : 0) + pad * 1.6;
    const x0 = cx - w / 2;
    const y0 = cy - h / 2;
    const t = `${assTime(it.start)},${assTime(it.end)}`;
    const fade = `\\fad(${cfg.fadeMs.in},${cfg.fadeMs.out})`;
    const rad = r(px(cfg.paddingPct * 0.7, H));
    out.push(`Dialogue: 3,${t},CalloutDraw,,0,0,0,,{\\an7\\pos(0,0)\\p1${fade}\\c${assColour(cfg.fill)}\\3c${assColour(cfg.outline)}\\bord${+px(cfg.outlineWidthPct, H).toFixed(1)}\\shad0}${roundedRect(r(x0), r(y0), r(w), r(h), rad)}{\\p0}`);
    const vy = y0 + pad * 0.8 + (vH * 0.95) / 2;
    out.push(`Dialogue: 4,${t},CalloutValue,,0,0,0,,{\\an5\\pos(${r(cx)},${r(vy)})${fade}}${it.value}`);
    if (it.label) out.push(`Dialogue: 4,${t},CalloutLabel,,0,0,0,,{\\an5\\pos(${r(cx)},${r(y0 + h - pad * 0.8 - lH / 2)})${fade}}${it.label}`);
  }
  return ASS_HEADER(W, H, [`Style: ${valueStyle}`, `Style: ${labelStyle}`, `Style: ${draw}`]) + out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------
// Outro
// ---------------------------------------------------------------------------------------------------------

/** End card: a line of text and a tagline with a short accent bar, over the last seconds. */
export function buildOutroOverlay(start: number, end: number, cfg: OutroConfig, W = FRAME_W, H = FRAME_H): string {
  const text = assStyle('OutroText', cfg.textFont, cfg.stroke, cfg.colors.text, H);
  const sub = assStyle('OutroSub', cfg.subtextFont, cfg.stroke, cfg.colors.accent, H, 5, 2);
  const draw = ['OutroDraw', 'Montserrat', 20, '&H00FFFFFF', '&H000000FF', '&H00000000', '&H00000000', 0, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 7, 0, 0, 0, 1].join(',');
  const t = `${assTime(start)},${assTime(end)}`;
  const fade = `\\fad(${cfg.fadeMs.in},${cfg.fadeMs.out})`;
  const cx = r(px(cfg.position.xPct, W));
  const cy = r(px(cfg.position.yPct, H));
  const gap = px(cfg.textFont.sizePct, H) * 0.95;
  const barW = r(px(18, W));
  const out = [
    `Dialogue: 2,${t},OutroText,,0,0,0,,{\\an5\\pos(${cx},${cy})${fade}}${cfg.text}`,
    `Dialogue: 2,${t},OutroDraw,,0,0,0,,{\\an7\\pos(0,0)\\p1${fade}\\c${assColour(cfg.colors.accent)}}m ${cx - barW / 2} ${r(cy + gap * 0.62)} l ${cx + barW / 2} ${r(cy + gap * 0.62)} l ${cx + barW / 2} ${r(cy + gap * 0.62) + 6} l ${cx - barW / 2} ${r(cy + gap * 0.62) + 6}{\\p0}`,
    `Dialogue: 2,${t},OutroSub,,0,0,0,,{\\an5\\pos(${cx},${r(cy + gap * 1.25)})${fade}}${cfg.subtext}`,
  ];
  return ASS_HEADER(W, H, [`Style: ${text}`, `Style: ${sub}`, `Style: ${draw}`]) + out.join('\n') + '\n';
}
