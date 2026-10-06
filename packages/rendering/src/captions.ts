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

/** Generates the ASS document for the timeline's cues. */
export function buildAss(cues: CaptionCue[], layout: CaptionLayout = CAPTION_LAYOUT): string {
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
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${prefix}${c.lines.join('\\N')}`;
  });
  return header + events.join('\n') + '\n';
}

export function writeAss(cues: CaptionCue[], filePath: string, layout: CaptionLayout = CAPTION_LAYOUT): string {
  fs.writeFileSync(filePath, buildAss(cues, layout), 'utf-8');
  return filePath;
}
