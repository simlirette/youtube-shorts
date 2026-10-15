import fs from 'node:fs';
import type { CaptionCue } from '@shorts/schemas';

/**
 * Caption layout in the real 1080×1920 coordinate system (ASS PlayRes = video size, so margins are
 * pixels). The block is bottom-anchored above the Shorts title/description area and kept clear of
 * the right-hand action buttons. Line breaks are explicit (WrapStyle 2) so layout is deterministic.
 */
export interface CaptionLayout {
  width: number;
  height: number;
  fontName: string;
  fontSize: number;
  outline: number;
  marginL: number;
  marginR: number;
  /** Distance from the bottom edge to the bottom of the caption block. */
  marginV: number;
  maxLines: number;
  maxCharsPerLine: number;
  maxWordsPerCue: number;
  maxCueSeconds: number;
  /** Region captions must stay inside (verified on rendered frames by media QA). */
  safeZone: { left: number; right: number; top: number; bottom: number };
}

export const CAPTION_LAYOUT: CaptionLayout = {
  width: 1080,
  height: 1920,
  fontName: 'Anton',
  fontSize: 92,
  outline: 6,
  marginL: 120,
  marginR: 120,
  marginV: 560,
  maxLines: 2,
  maxCharsPerLine: 16,
  maxWordsPerCue: 5,
  maxCueSeconds: 2.4,
  safeZone: { left: 80, right: 1000, top: 960, bottom: 1440 },
};

/** Greedy line breaking by character budget. A single over-long word occupies its own line. */
export function layoutLines(words: string[], layout: CaptionLayout = CAPTION_LAYOUT): string[] {
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current) current = w;
    else if (current.length + 1 + w.length <= layout.maxCharsPerLine) current += ` ${w}`;
    else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export type CaptionStyleName = 'plain' | 'highlight';

/** The word of a cue that carries the most meaning (longest non-trivial word; first on ties). */
export function emphasisIndex(words: string[]): number {
  const stop = /^(THE|AND|BUT|FOR|WITH|THAT|THIS|FROM|INTO|ONTO|WERE|WAS|ARE|HAS|HAVE|ITS|IT'S|THEY|THEIR|THERE|THEN|WHEN|WHICH|WHAT|ABOUT)$/;
  let best = -1;
  let bestLen = 0;
  words.forEach((w, i) => {
    const core = w.replace(/[^A-Z0-9']/g, '');
    if (core.length >= 4 && !stop.test(core) && core.length > bestLen) {
      best = i;
      bestLen = core.length;
    }
  });
  return best;
}

/** Generates the ASS document for the timeline's cues. */
export function buildAss(cues: CaptionCue[], layout: CaptionLayout = CAPTION_LAYOUT, captionStyle: CaptionStyleName = 'plain'): string {
  const style = [
    'Caption', layout.fontName, layout.fontSize,
    '&H00FFFFFF', '&H000000FF', '&H00000000', '&H96000000',
    0, 0, 0, 0, 100, 100, 1, 0,
    1, layout.outline, 2, 2,
    layout.marginL, layout.marginR, layout.marginV, 1,
  ].join(',');
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${layout.width}
PlayResY: ${layout.height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = cues.map((c) => {
    const longest = Math.max(...c.lines.map((l) => l.length));
    // Over-long single words are horizontally compressed to the line budget instead of overflowing.
    const scale = longest > layout.maxCharsPerLine ? Math.floor((100 * layout.maxCharsPerLine) / longest) : 100;
    const prefix = scale < 100 ? `{\\fscx${scale}}` : '';
    let lines = c.lines;
    if (captionStyle === 'highlight') {
      // Keyword highlight: one word per cue in warm yellow (ASS colours are &HBBGGRR).
      const flat = c.lines.flatMap((l, li) => l.split(' ').map((w) => ({ w, li })));
      const k = emphasisIndex(flat.map((x) => x.w));
      if (k >= 0) flat[k] = { ...flat[k], w: `{\\c&H00D7FF&}${flat[k].w}{\\c&HFFFFFF&}` };
      lines = c.lines.map((_, li) => flat.filter((x) => x.li === li).map((x) => x.w).join(' '));
    }
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${prefix}${lines.join('\\N')}`;
  });
  return header + events.join('\n') + '\n';
}

export function writeAss(cues: CaptionCue[], filePath: string, layout: CaptionLayout = CAPTION_LAYOUT, captionStyle: CaptionStyleName = 'plain'): string {
  fs.writeFileSync(filePath, buildAss(cues, layout, captionStyle), 'utf-8');
  return filePath;
}

/**
 * Opening title card: the topic, at the top of the frame inside the safe area, on a translucent box
 * so it stays readable over moving footage, faded out before the subject needs the full frame.
 */
export interface TitleCardLayout {
  fontSize: number;
  marginV: number;
  maxCharsPerLine: number;
  start: number;
  end: number;
  safeZone: { left: number; right: number; top: number; bottom: number };
}

export const TITLE_CARD_LAYOUT: TitleCardLayout = {
  fontSize: 76,
  marginV: 300,
  maxCharsPerLine: 18,
  start: 0,
  end: 2.5,
  safeZone: { left: 80, right: 1000, top: 250, bottom: 760 },
};

export function titleCardLines(text: string, title: TitleCardLayout = TITLE_CARD_LAYOUT): string[] {
  const words = text.replace(/[{}\\]/g, '').toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= title.maxCharsPerLine) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 2);
}

export function buildTitleAss(text: string, layout: CaptionLayout = CAPTION_LAYOUT, title: TitleCardLayout = TITLE_CARD_LAYOUT): string {
  const style = [
    'Title', layout.fontName, title.fontSize,
    '&H00FFFFFF', '&H000000FF', '&H00000000', '&H64000000',
    0, 0, 0, 0, 100, 100, 1, 0,
    3, 18, 0, 8,
    layout.marginL, layout.marginR, title.marginV, 1,
  ].join(',');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${layout.width}
PlayResY: ${layout.height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 1,${assTime(title.start)},${assTime(title.end)},Title,,0,0,0,,{\\fad(120,300)}${titleCardLines(text, title).join('\\N')}
`;
}

export function writeTitleAss(text: string, filePath: string, layout: CaptionLayout = CAPTION_LAYOUT): string {
  fs.writeFileSync(filePath, buildTitleAss(text, layout), 'utf-8');
  return filePath;
}
