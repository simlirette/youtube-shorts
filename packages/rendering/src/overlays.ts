import { InternalError } from '@shorts/core';
import type { CalloutStyle, CaptionCue, CaptionsConfig, HighlightConfig, HookStyle, OutroConfig, PointerConfig, ProgressConfig, TextEffects, VideoHook } from '@shorts/schemas';
import { CAPTION_LAYOUT, emphasisIndex } from './captions.js';
import { ASS_HEADER, assTime, disc, mechanismCaptionCues, type NarrationWord } from './mechanism-video.js';

/**
 * The BASE overlay engine: every size, colour, position and timing comes from base.json (or a video's
 * `overrides`), expressed as a percentage of the frame, so one video can never fork the code.
 * All overlays are ASS subtitle layers burned in by FFmpeg: they never touch the Blender render.
 */

export const FRAME_W = 1080;
export const FRAME_H = 1920;
/** Text at the top and bottom of the frame keeps this far from the left and right edges. */
export const SAFE_MARGIN_PX = 36;

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
function assStyle(name: string, font: Font, stroke: Stroke, primary: string, H = FRAME_H, alignment = 5, spacing = 0, fx: TextFx | null = null): string {
  spacing += fx ? fx.tracking : 0;
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

/** ASS alpha override for an opacity of 0-1 (1 = solid). */
export function alphaTag(opacity: number): string {
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255);
  return `&H${a.toString(16).padStart(2, '0').toUpperCase()}&`;
}

const wordKey = (w: string): string => w.toLowerCase().replace(/[^a-z0-9']/g, '');

// ---------------------------------------------------------------------------------------------------------
// Text effects (the "premium" look): a soft drop shadow in place of the outline, tighter tracking, an optional scrim.
// With no effects configured every builder returns exactly what it always did ("classic").
// ---------------------------------------------------------------------------------------------------------

export interface TextFx {
  /** Soft shadow: blur radius in px, opacity 0-1, distance below the text in px. */
  shadow: boolean;
  blur: number;
  opacity: number;
  offset: number;
  tracking: number;
  /** Opacity of the dark scrim behind each caption phrase (0 = none). */
  scrim: number;
}

export function textFx(t?: TextEffects): TextFx | null {
  if (!t) return null;
  const blur = t.shadow_blur ?? 0;
  const tracking = t.tracking_px ?? 0;
  const scrim = t.scrim_opacity ?? 0;
  if (blur <= 0 && tracking === 0 && scrim <= 0) return null;
  return { shadow: blur > 0, blur, opacity: t.shadow_opacity ?? 0.55, offset: t.shadow_offset_px ?? 2, tracking, scrim };
}

/** Override tags that turn a copy of a text event into its shadow: dark, blurred, nothing of the original colour. */
function shadowTags(fx: TextFx, mult = 1): string {
  const a = alphaTag(fx.opacity * mult);
  return `\\1c&H000000&\\3c&H000000&\\1a${a}\\3a${a}\\bord${+(fx.blur / 2).toFixed(1)}\\shad0\\blur${fx.blur}`;
}

/** The same style with another name (for the shadow copies). */
const renamed = (style: string, to: string): string => style.replace(/^[^,]+/, to);

export interface CaptionOptions {
  /** Spoken word (lower case, no punctuation) -> text drawn instead; the timing is unchanged. */
  display?: Record<string, string>;
  /** Time windows in which no caption is drawn (the hook line, the outro). */
  suppress?: Array<[number, number]>;
  /** Text effects (soft shadow, tracking, scrim); absent = the classic look. */
  fx?: TextFx | null;
  /** With policy "single" only the words in `keywords` (indices into the narration words) take the highlight colour; the word being spoken is otherwise the `current` colour. */
  highlight?: HighlightConfig;
  keywords?: ReadonlySet<number>;
}

/**
 * Captions, centred at cfg.position. timing "word": one event per word, from the ElevenLabs word timestamps; the
 * word being said is `current`, words already said are `spoken`, words still to come are `upcoming`.
 * timing "phrase": the phrase appears whole, with one keyword in the `current` colour.
 */
export function buildCaptionOverlay(cues: CaptionCue[], words: NarrationWord[], cfg: CaptionsConfig, opts: CaptionOptions = {}, W = FRAME_W, H = FRAME_H): string {
  const fx = opts.fx ?? null;
  const style = assStyle('Caption', cfg.font, cfg.stroke, cfg.colors.spoken, H, 5, 0, fx);
  const posX = r(px(cfg.position.xPct, W));
  const posY = r(px(cfg.position.yPct, H));
  const pos = `\\an5\\pos(${posX},${posY})`;
  const single = opts.highlight?.policy === 'single';
  const keywords = opts.keywords ?? new Set<number>();
  const hl = opts.highlight?.color ?? cfg.colors.current;
  const tone = (idx: number, state: 'spoken' | 'current' | 'upcoming'): string => (single && keywords.has(idx) && state !== 'upcoming' ? hl : cfg.colors[state]);
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
    const plain = c.lines.map((_, li) => tokens.filter((t) => t.line === li).map((t) => shown(t.w)).join(' ')).join('\\N');
    if (fx && fx.scrim > 0) {
      // A soft dark patch behind the phrase, sized from its longest line.
      const size = px(cfg.font.sizePct, H);
      const pad = size * 0.55;
      const sw = Math.max(...c.lines.map((l) => l.length)) * (size / 1.22) * 0.58 + pad * 2;
      const sh = c.lines.length * size * 1.15 + pad;
      for (const [s, e] of outside(c.start, c.end, suppress)) {
        events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},CaptionShadow,,0,0,0,,{\\an7\\pos(0,0)\\p1\\fad(${cfg.fadeMs.in},${cfg.fadeMs.out})\\1c&H000000&\\1a${alphaTag(fx.scrim)}\\bord0\\shad0\\blur${r(H * 0.012)}}${roundedRect(r(posX - sw / 2), r(posY - sh / 2), r(sw), r(sh), r(sh / 2.5))}{\\p0}`);
      }
    }
    const push = (start: number, end: number, body: string, fadeIn: boolean, fadeOut: boolean): void => {
      for (const [s, e] of outside(start, end, suppress)) {
        const fade = fadeIn || fadeOut ? `\\fad(${fadeIn ? cfg.fadeMs.in : 0},${fadeOut ? cfg.fadeMs.out : 0})` : '';
        if (fx?.shadow) events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},CaptionShadow,,0,0,0,,{\\an5\\pos(${posX},${posY + fx.offset})${fade}${shadowTags(fx)}}${plain}`);
        events.push(`Dialogue: 1,${assTime(s)},${assTime(e)},Caption,,0,0,0,,{${pos}${fade}}${body}`);
      }
    };
    if (cfg.timing === 'word') {
      for (let k = 0; k < tokens.length; k++) {
        const start = words[first + k].start;
        const end = k < tokens.length - 1 ? words[first + k + 1].start : c.end;
        if (end <= start) continue;
        push(start, end, render((j) => tone(first + j, j < k ? 'spoken' : j === k ? 'current' : 'upcoming')), k === 0, k === tokens.length - 1);
      }
    } else {
      const key = emphasisIndex(tokens.map((t) => t.w.toUpperCase()));
      push(c.start, c.end, render((j) => (single ? (keywords.has(first + j) ? hl : cfg.colors.spoken) : j === key ? cfg.colors.current : cfg.colors.spoken)), true, true);
    }
  }
  return ASS_HEADER(W, H, [`Style: ${style}`, ...(fx ? [`Style: ${renamed(style, 'CaptionShadow')}`] : [])]) + events.join('\n') + '\n';
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
export function buildHookOverlay(text: string, cfg: HookStyle, W = FRAME_W, H = FRAME_H, fx: TextFx | null = null): string {
  const style = assStyle('Hook', cfg.font, cfg.stroke, cfg.colors.text, H, 5, 0, fx);
  const shown = cfg.uppercase ? text.toUpperCase() : text;
  const lines = wrap(shown, lineBudget(cfg.font, cfg.safeWidthPct, W, H));
  const body = lines
    .map((l) => (cfg.accentNumbers ? l.replace(/(\d[\d,.]*%?)/g, `{\\c${assColour(cfg.colors.accent)}}$1{\\c${assColour(cfg.colors.text)}}`) : l))
    .join('\\N');
  const pos = `\\an5\\pos(${r(px(cfg.position.xPct, W))},${r(px(cfg.position.yPct, H))})`;
  const fade = `\\fad(${cfg.fadeMs.in},${cfg.fadeMs.out})`;
  const shadow = fx?.shadow ? `Dialogue: 1,${assTime(0)},${assTime(cfg.seconds)},HookShadow,,0,0,0,,{\\an5\\pos(${r(px(cfg.position.xPct, W))},${r(px(cfg.position.yPct, H)) + fx.offset})${fade}${shadowTags(fx)}}${lines.join('\\N')}\n` : '';
  const ev = `Dialogue: 2,${assTime(0)},${assTime(cfg.seconds)},Hook,,0,0,0,,{${pos}${fade}}${body}`;
  return ASS_HEADER(W, H, [`Style: ${style}`, ...(fx ? [`Style: ${renamed(style, 'HookShadow')}`] : [])]) + shadow + ev + '\n';
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

/** Width of a tracker label of `chars` characters: glyphs (about 0.78 em) plus the 3 px letter spacing. */
function labelWidth(chars: number, sizePct: number, fit: number, H: number): number {
  return chars * (0.78 * (px(sizePct * fit, H) / 1.22) + 3);
}

/** Centre of a label: its dot's x, slid inward when the label would cross the safe margin. */
function labelCentre(x: number, width: number, W: number): number {
  return Math.min(W - SAFE_MARGIN_PX - width / 2, Math.max(SAFE_MARGIN_PX + width / 2, x));
}

/**
 * Scale (at most 1) for the tracker labels: the largest size at which, whichever step is active, no two labels come
 * within 8 px of each other and every label stays inside the safe margin. The four strokes fit at 1 (they look as
 * they always did); five longer steps shrink to fit.
 */
export function progressFit(steps: string[], cfg: ProgressConfig, W = FRAME_W, H = FRAME_H): number {
  const n = steps.length;
  if (n < 2) return 1;
  const spread = px(cfg.spreadPct, W);
  const xs = steps.map((_, i) => W / 2 + (i - (n - 1) / 2) * (spread / (n - 1)));
  const fits = (f: number): boolean =>
    steps.every((_, active) => {
      const rects = steps.map((s, i) => {
        const w = labelWidth(s.length, i === active ? cfg.activeFont.sizePct : cfg.inactiveFont.sizePct, f, H);
        const c = labelCentre(xs[i], w, W);
        return [c - w / 2, c + w / 2];
      });
      return rects.every((rc, i) => (i === 0 || rc[0] - rects[i - 1][1] >= 8) && rc[0] >= SAFE_MARGIN_PX - 0.5 && rc[1] <= W - SAFE_MARGIN_PX + 0.5);
    });
  for (let f = 1; f >= 0.4; f -= 0.01) if (fits(f)) return Math.round(f * 100) / 100;
  return 0.4;
}

/** The step tracker (INTAKE > COMPRESSION > POWER > EXHAUST style), visible from frame 1 when configured. */
export function buildProgressOverlay(steps: string[], segments: ProgressSegment[], cfg: ProgressConfig, W = FRAME_W, H = FRAME_H, fx: TextFx | null = null): string {
  const n = steps.length;
  const fit = progressFit(steps, cfg, W, H);
  const label = assStyle('Step', { ...cfg.inactiveFont, sizePct: cfg.inactiveFont.sizePct * fit }, cfg.stroke, '#FFFFFF', H, 8, 3, fx);
  const labelOn = assStyle('StepOn', { ...cfg.activeFont, sizePct: cfg.activeFont.sizePct * fit }, cfg.stroke, '#FFFFFF', H, 8, 3, fx);
  const draw = ['Draw', 'Montserrat', 20, '&H00FFFFFF', '&H000000FF', '&H00000000', '&H00000000', 0, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 7, 0, 0, 0, 1].join(',');
  const cy = r(px(cfg.yPct, H));
  const spread = px(cfg.spreadPct, W);
  const xs = steps.map((_, i) => r(W / 2 + (i - (n - 1) / 2) * (spread / Math.max(1, n - 1))));
  const slim = cfg.lineHeightPx !== undefined;
  const lineH = slim ? +(cfg.lineHeightPx! / 2).toFixed(2) : Math.max(2, r(px(0.2, H)));
  const dimA = cfg.dimOpacity !== undefined ? alphaTag(cfg.dimOpacity) : null; // alpha of steps not reached yet
  const lineAlpha = dimA ?? '&H50&';
  const rActive = slim ? Math.max(6, r(4.2 * cfg.lineHeightPx!)) : r(px(cfg.dotRadiusPct.active, H));
  const rInactive = slim ? Math.max(3, r(2.4 * cfg.lineHeightPx!)) : r(px(cfg.dotRadiusPct.inactive, H));
  const labelDy = slim ? rActive + r(px(0.7, H)) : r(px(1.9, H));
  const out: string[] = [];
  const segs = [...segments].sort((a, b) => a.start - b.start);
  segs.forEach((e, ei) => {
    const t = `${assTime(e.start)},${assTime(e.end)}`;
    const firstOfRun = ei === 0 || segs[ei - 1].end < e.start - 0.01;
    const lastOfRun = ei === segs.length - 1 || segs[ei + 1].start > e.end + 0.01;
    const fadeIn = firstOfRun && !(cfg.visibleFromStart && e.start <= 0.001) ? 250 : 0;
    const fade = `\\fad(${fadeIn},${lastOfRun ? 200 : 0})`;
    const base = `{\\an7\\pos(0,0)\\p1${fade}`;
    out.push(`Dialogue: 0,${t},Draw,,0,0,0,,${base}\\c${assColour(cfg.colors.line)}\\1a${lineAlpha}}m ${xs[0]} ${cy - lineH} l ${xs[n - 1]} ${cy - lineH} l ${xs[n - 1]} ${cy + lineH} l ${xs[0]} ${cy + lineH}{\\p0}`);
    const reach = e.index >= n ? n - 1 : e.index;
    if (reach >= 0) out.push(`Dialogue: 0,${t},Draw,,0,0,0,,${base}\\c${assColour(cfg.colors.done)}}m ${xs[0]} ${cy - lineH} l ${xs[reach]} ${cy - lineH} l ${xs[reach]} ${cy + lineH} l ${xs[0]} ${cy + lineH}{\\p0}`);
    steps.forEach((s, i) => {
      const on = i === e.index;
      const colour = on ? cfg.colors.active : i < e.index ? cfg.colors.done : cfg.colors.upcoming;
      const upcoming = !on && i > e.index;
      out.push(`Dialogue: 1,${t},Draw,,0,0,0,,${base}\\c${assColour(colour)}${upcoming && dimA ? `\\1a${dimA}` : ''}}${disc(xs[i], cy, on ? rActive : rInactive)}{\\p0}`);
      const dim = upcoming ? `\\1a${dimA ?? '&H40&'}` : '';
      // An edge label slides inward so it stays inside the safe margin; its dot stays where it is.
      const lx = r(labelCentre(xs[i], labelWidth(s.length, on ? cfg.activeFont.sizePct : cfg.inactiveFont.sizePct, fit, H), W));
      if (fx?.shadow) out.push(`Dialogue: 1,${t},${on ? 'StepOn' : 'Step'}Shadow,,0,0,0,,{\\an8\\pos(${lx},${cy + labelDy + fx.offset})${fade}${shadowTags(fx, upcoming ? cfg.dimOpacity ?? 0.75 : 1)}}${s.toUpperCase()}`);
      out.push(`Dialogue: 2,${t},${on ? 'StepOn' : 'Step'},,0,0,0,,{\\an8\\pos(${lx},${cy + labelDy})${fade}${dim}}${s.toUpperCase()}`);
    });
  });
  const shadowStyles = fx ? [`Style: ${renamed(label, 'StepShadow')}`, `Style: ${renamed(labelOn, 'StepOnShadow')}`] : [];
  return ASS_HEADER(W, H, [`Style: ${label}`, `Style: ${labelOn}`, `Style: ${draw}`, ...shadowStyles]) + out.join('\n') + '\n';
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

export interface CalloutOptions {
  /** badge: big figure, small label, dark translucent backdrop with a thin border; legacy/absent: the filled highlighter card. */
  style?: 'badge' | 'legacy';
  fx?: TextFx | null;
  highlight?: HighlightConfig;
}

/** Default look of the badge when base.json gives none. */
const BADGE_DEFAULT = { fill: '#0B0D11', opacity: 0.58, borderPx: 1.5, borderColor: '#FFFFFF', borderOpacity: 0.32, radiusPx: 22, paddingPx: 26, valueColor: '#FFFFFF', labelColor: '#E4E4E4' };

/**
 * The minimal stat badge: the figure big, a small label beneath it, on a dark translucent rounded backdrop with a
 * thin border. No filled yellow box; the figure is the one yellow item of its scene when the highlight policy is "single".
 */
function buildBadgeOverlay(items: CalloutEvent[], cfg: CalloutStyle, W: number, H: number, opts: CalloutOptions): string {
  const fx = opts.fx ?? null;
  const b = { ...BADGE_DEFAULT, ...(cfg.badge ?? {}) };
  const valueColour = opts.highlight?.policy === 'single' ? opts.highlight.color ?? '#FFD200' : b.valueColor;
  const valueStyle = assStyle('CalloutValue', cfg.valueFont, { widthPct: 0, color: '#000000', shadowPct: 0 }, valueColour, H, 5, 0, fx);
  const labelStyle = assStyle('CalloutLabel', cfg.labelFont, { widthPct: 0, color: '#000000', shadowPct: 0 }, b.labelColor, H, 5, 0, fx);
  const draw = ['CalloutDraw', 'Montserrat', 20, '&H00FFFFFF', '&H000000FF', '&H00000000', '&H00000000', 0, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 7, 0, 0, 0, 1].join(',');
  const vH = px(cfg.valueFont.sizePct, H);
  const lH = px(cfg.labelFont.sizePct, H);
  const cx = px(cfg.position.xPct, W);
  const cy = px(cfg.position.yPct, H);
  const out: string[] = [];
  for (const it of items) {
    const vW = it.value.length * (vH / 1.22) * 0.64;
    const lW = it.label ? it.label.length * (lH / 1.22) * 0.6 : 0;
    const w = Math.min(W * 0.92, Math.max(vW, lW) + b.paddingPx * 2.4);
    const h = vH * 0.92 + (it.label ? lH * 1.45 : 0) + b.paddingPx * 1.5;
    const x0 = cx - w / 2;
    const y0 = cy - h / 2;
    const t = `${assTime(it.start)},${assTime(it.end)}`;
    const fade = `\\fad(${cfg.fadeMs.in},${cfg.fadeMs.out})`;
    const rect = roundedRect(r(x0), r(y0), r(w), r(h), r(b.radiusPx));
    if (fx?.shadow) out.push(`Dialogue: 2,${t},CalloutDraw,,0,0,0,,{\\an7\\pos(0,${fx.offset * 2})\\p1${fade}\\1c&H000000&\\1a${alphaTag(fx.opacity * 0.8)}\\bord0\\shad0\\blur${r(fx.blur * 1.4)}}${rect}{\\p0}`);
    out.push(`Dialogue: 3,${t},CalloutDraw,,0,0,0,,{\\an7\\pos(0,0)\\p1${fade}\\c${assColour(b.fill)}\\1a${alphaTag(b.opacity)}\\3c${assColour(b.borderColor)}\\3a${alphaTag(b.borderOpacity)}\\bord${b.borderPx}\\shad0}${rect}{\\p0}`);
    const vy = y0 + b.paddingPx * 0.75 + (vH * 0.92) / 2;
    const ly = y0 + h - b.paddingPx * 0.75 - lH * 0.7;
    const sh = (kind: 'Value' | 'Label', y: number, text: string): void => {
      if (fx?.shadow) out.push(`Dialogue: 3,${t},Callout${kind}Shadow,,0,0,0,,{\\an5\\pos(${r(cx)},${r(y + fx.offset)})${fade}${shadowTags(fx)}}${text}`);
    };
    sh('Value', vy, it.value);
    out.push(`Dialogue: 4,${t},CalloutValue,,0,0,0,,{\\an5\\pos(${r(cx)},${r(vy)})${fade}}${it.value}`);
    if (it.label) {
      sh('Label', ly, it.label);
      out.push(`Dialogue: 4,${t},CalloutLabel,,0,0,0,,{\\an5\\pos(${r(cx)},${r(ly)})${fade}}${it.label}`);
    }
  }
  const shadowStyles = fx ? [`Style: ${renamed(valueStyle, 'CalloutValueShadow')}`, `Style: ${renamed(labelStyle, 'CalloutLabelShadow')}`] : [];
  return ASS_HEADER(W, H, [`Style: ${valueStyle}`, `Style: ${labelStyle}`, `Style: ${draw}`, ...shadowStyles]) + out.join('\n') + '\n';
}

/** Yellow stat cards with a black outline, for surprising numbers. */
export function buildCalloutOverlay(items: CalloutEvent[], cfg: CalloutStyle, W = FRAME_W, H = FRAME_H, opts: CalloutOptions = {}): string {
  if (opts.style === 'badge') return buildBadgeOverlay(items, cfg, W, H, opts);
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
export function buildOutroOverlay(start: number, end: number, cfg: OutroConfig, W = FRAME_W, H = FRAME_H, fx: TextFx | null = null): string {
  const text = assStyle('OutroText', cfg.textFont, cfg.stroke, cfg.colors.text, H, 5, 0, fx);
  const sub = assStyle('OutroSub', cfg.subtextFont, cfg.stroke, cfg.colors.accent, H, 5, 2, fx);
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
  if (fx?.shadow) {
    out.unshift(
      `Dialogue: 1,${t},OutroTextShadow,,0,0,0,,{\\an5\\pos(${cx},${cy + fx.offset})${fade}${shadowTags(fx)}}${cfg.text}`,
      `Dialogue: 1,${t},OutroSubShadow,,0,0,0,,{\\an5\\pos(${cx},${r(cy + gap * 1.25) + fx.offset})${fade}${shadowTags(fx)}}${cfg.subtext}`
    );
  }
  const shadowStyles = fx ? [`Style: ${renamed(text, 'OutroTextShadow')}`, `Style: ${renamed(sub, 'OutroSubShadow')}`] : [];
  return ASS_HEADER(W, H, [`Style: ${text}`, `Style: ${sub}`, `Style: ${draw}`, ...shadowStyles]) + out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------
// Part pointers (pills at the frame edge, a leader line or a pulse ring to the part)
// ---------------------------------------------------------------------------------------------------------

/** Where a part appears on screen over time: [seconds, x, y, depth] with x and y as fractions of the frame (y downwards). */
export type AnchorTrack = Array<[number, number, number, number]>;
export type AnchorTracks = Record<string, AnchorTrack>;

export interface PointerLabel {
  text: string;
  part: string;
  t0: number;
  t1: number;
  /** leader (thin line and a dot) or pulse (a ring on the part). Default: the config's style. */
  style?: 'leader' | 'pulse';
}

/** Anchor of a part at time t, interpolated between samples; null when it is behind the camera or outside the frame. */
export function anchorAt(track: AnchorTrack | undefined, t: number): { x: number; y: number } | null {
  if (!track || track.length === 0) return null;
  if (t < track[0][0] - 1e-6 || t > track[track.length - 1][0] + 1e-6) return null;
  let i = 0;
  while (i < track.length - 2 && track[i + 1][0] < t) i++;
  const a = track[i];
  const b = track[Math.min(i + 1, track.length - 1)];
  const u = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
  const z = Math.min(a[3], b[3]);
  const x = a[1] + (b[1] - a[1]) * u;
  const y = a[2] + (b[2] - a[2]) * u;
  if (z <= 0 || x < 0.01 || x > 0.99 || y < 0.01 || y > 0.99) return null;
  return { x, y };
}

export interface PlacedPill {
  label: PointerLabel;
  side: 'left' | 'right';
  /** Pill rectangle in pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pills go to the left or right edge of the frame (the side nearer the part), at the part's height but inside the
 * allowed band (below the tracker, above the captions), with pills that are on screen together kept apart.
 */
export function placePills(labels: PointerLabel[], tracks: AnchorTracks, cfg: PointerConfig, W = FRAME_W, H = FRAME_H): PlacedPill[] {
  const sizePx = px(cfg.label_size_pct, H);
  const em = sizePx / 1.22;
  const h = r(sizePx * 1.25 + cfg.pill.paddingPx * 0.7);
  const top = px(cfg.zone.topPct, H) + h / 2;
  const bottom = px(cfg.zone.bottomPct, H) - h / 2;
  const placed: PlacedPill[] = [];
  for (const label of [...labels].sort((a, b) => a.t0 - b.t0)) {
    const mid = (label.t0 + label.t1) / 2;
    const a = anchorAt(tracks[label.part], mid) ?? anchorAt(tracks[label.part], label.t0);
    if (!a) continue;
    const w = r(label.text.length * (0.66 * em + 2) + cfg.pill.paddingPx * 2);
    const wanted = Math.min(bottom, Math.max(top, a.y * H));
    const sides: Array<'left' | 'right'> = a.x < 0.5 ? ['left', 'right'] : ['right', 'left'];
    for (const side of sides) {
      const busy = placed.filter((p) => p.side === side && p.label.t0 < label.t1 && p.label.t1 > label.t0).map((p) => [p.y - p.h / 2 - cfg.minGapPx, p.y + p.h / 2 + cfg.minGapPx]);
      // The free spot nearest to where the part is.
      const candidates = [wanted, ...busy.flatMap(([lo, hi]) => [lo - h / 2, hi + h / 2])].filter((y) => y >= top - 0.5 && y <= bottom + 0.5);
      const free = candidates.filter((y) => busy.every(([lo, hi]) => y + h / 2 <= lo + 0.5 || y - h / 2 >= hi - 0.5)).sort((p, q) => Math.abs(p - wanted) - Math.abs(q - wanted));
      if (free.length) {
        const x = side === 'left' ? cfg.edge_margin_px : W - cfg.edge_margin_px - w;
        placed.push({ label, side, x, y: r(free[0]), w, h });
        break;
      }
    }
  }
  return placed;
}

function polygon(pts: Array<[number, number]>): string {
  return `m ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)} l ${pts.slice(1).map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}`;
}

/** A thin line from a to b, as a polygon (ASS has no stroked lines). */
function lineShape(a: [number, number], b: [number, number], thickness: number): string {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (thickness / 2);
  const ny = (dx / len) * (thickness / 2);
  return polygon([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]);
}

function circle(cx: number, cy: number, rad: number, n = 20): string {
  return polygon(Array.from({ length: n }, (_, i): [number, number] => [cx + rad * Math.cos((2 * Math.PI * i) / n), cy + rad * Math.sin((2 * Math.PI * i) / n)]));
}

/**
 * The part pointers: for each label a dark pill at the frame edge with its text, and a thin leader line to a dot on
 * the part (or a pulse ring on the part). Line, dot and ring follow the part frame by frame from the anchor tracks.
 */
export function buildPointerOverlay(labels: PointerLabel[], tracks: AnchorTracks, cfg: PointerConfig, fps = 30, W = FRAME_W, H = FRAME_H): string {
  const pills = placePills(labels, tracks, cfg, W, H);
  const fontPx = r(px(cfg.label_size_pct, H));
  const text = ['PtrText', cfg.font ?? 'Montserrat SemiBold', fontPx, styleColour(cfg.pill.text), '&H000000FF', '&H00000000', '&H00000000', 0, 0, 0, 0, 100, 100, 1, 0, 1, 0, 0, 5, 0, 0, 0, 1].join(',');
  const draw = ['PtrDraw', 'Montserrat', 20, '&H00FFFFFF', '&H000000FF', '&H00000000', '&H00000000', 0, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 7, 0, 0, 0, 1].join(',');
  const out: string[] = [];
  const col = assColour(cfg.color);
  const fadeIn = cfg.fadeMs.in / 1000;
  const fadeOut = cfg.fadeMs.out / 1000;
  for (const p of pills) {
    const { label } = p;
    const t = `${assTime(label.t0)},${assTime(label.t1)}`;
    const fade = `\\fad(${cfg.fadeMs.in},${cfg.fadeMs.out})`;
    out.push(`Dialogue: 1,${t},PtrDraw,,0,0,0,,{\\an7\\pos(0,0)\\p1${fade}\\c${assColour(cfg.pill.fill)}\\1a${alphaTag(cfg.pill.opacity)}\\bord0\\shad0}${roundedRect(r(p.x), r(p.y - p.h / 2), p.w, p.h, r(p.h / 2.6))}{\\p0}`);
    out.push(`Dialogue: 2,${t},PtrText,,0,0,0,,{\\an5\\pos(${r(p.x + p.w / 2)},${r(p.y)})${fade}}${label.text.toUpperCase()}`);
    const style = label.style ?? cfg.style;
    const edge: [number, number] = [p.side === 'left' ? p.x + p.w : p.x, p.y];
    const step = 1 / fps;
    for (let f = 0; label.t0 + f * step < label.t1 - 1e-6; f++) {
      const t0 = label.t0 + f * step;
      const t1 = Math.min(label.t1, t0 + step);
      const a = anchorAt(tracks[label.part], t0 + step / 2);
      if (!a) continue;
      // Fade the pointer with the pill.
      const k = Math.min(1, (t0 - label.t0) / fadeIn, (label.t1 - t0) / fadeOut);
      if (k <= 0.02) continue;
      const at: [number, number] = [a.x * W, a.y * H];
      const tt = `${assTime(t0)},${assTime(t1)}`;
      const alpha = `\\alpha${alphaTag(k)}`;
      out.push(`Dialogue: 0,${tt},PtrDraw,,0,0,0,,{\\an7\\pos(0,0)\\p1${alpha}\\c${col}\\bord0\\shad0}${lineShape(edge, at, cfg.thickness_px)}{\\p0}`);
      out.push(`Dialogue: 0,${tt},PtrDraw,,0,0,0,,{\\an7\\pos(0,0)\\p1${alpha}\\c${col}\\bord0\\shad0}${circle(at[0], at[1], cfg.dot_px)}{\\p0}`);
      if (style === 'pulse') {
        const phase = (((t0 - label.t0) / cfg.pulse.periodS) % 1 + 1) % 1;
        const rad = px(cfg.pulse.radiusPct.min + (cfg.pulse.radiusPct.max - cfg.pulse.radiusPct.min) * phase, H);
        const ringA = alphaTag(k * (1 - phase) * 0.95);
        out.push(`Dialogue: 0,${tt},PtrDraw,,0,0,0,,{\\an7\\pos(0,0)\\p1\\1a&HFF&\\3c${col}\\3a${ringA}\\bord${cfg.thickness_px}\\shad0}${circle(at[0], at[1], rad, 28)}{\\p0}`);
      }
    }
  }
  return ASS_HEADER(W, H, [`Style: ${text}`, `Style: ${draw}`]) + out.join('\n') + '\n';
}
