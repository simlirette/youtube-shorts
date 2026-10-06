import { CaptionCue, ShortScript, Timeline, TimelineSchema, VoiceNarration } from '@shorts/schemas';
import { InternalError, tokenizeWords } from '@shorts/core';
import { CAPTION_LAYOUT, CaptionLayout, layoutLines } from './captions.js';

export interface TimelineOptions {
  fps: number;
  /** Longest a single visual may stay on screen before the scene is split into another shot. */
  maxShotSeconds?: number;
  /** Silence appended after the last spoken word. */
  tailSeconds: number;
  layout?: CaptionLayout;
}

/**
 * Builds the one authoritative timeline from the narration's real word timestamps.
 * Scene boundaries, caption cues and total video length are all derived from it, so they cannot
 * drift from what is actually spoken.
 */
export function buildTimeline(script: ShortScript, narration: VoiceNarration, opts: TimelineOptions): Timeline {
  const layout = opts.layout ?? CAPTION_LAYOUT;
  const words = narration.wordTimestamps;
  const fps = opts.fps;
  const q = (t: number) => Math.round(t * fps) / fps;

  // Map each scene to its contiguous word range; the narration must contain exactly the script words.
  const ranges: Array<{ sceneNumber: number; first: number; last: number }> = [];
  let idx = 0;
  for (const scene of script.scenes) {
    const tokens = tokenizeWords(scene.narration);
    const first = idx;
    for (const tok of tokens) {
      if (words[idx]?.word !== tok) {
        throw new InternalError(`Narration timing does not match scene ${scene.sceneNumber} text at word ${idx} ("${words[idx]?.word}" vs "${tok}")`);
      }
      idx++;
    }
    if (tokens.length === 0) throw new InternalError(`Scene ${scene.sceneNumber} has no words`);
    ranges.push({ sceneNumber: scene.sceneNumber, first, last: idx - 1 });
  }
  if (idx !== words.length) throw new InternalError(`Narration has ${words.length} timed words but the script has ${idx}`);

  const lastWordEnd = words[words.length - 1].end;
  const narrationEnd = Math.max(narration.durationSeconds, lastWordEnd);
  const totalFrames = Math.ceil((narrationEnd + opts.tailSeconds) * fps);
  const total = totalFrames / fps;

  // Scene cuts sit midway between the previous scene's last word and the next scene's first word.
  const starts = ranges.map((r, i) => (i === 0 ? 0 : q((words[ranges[i - 1].last].end + words[r.first].start) / 2)));
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] <= starts[i - 1]) throw new InternalError(`Scene ${ranges[i].sceneNumber} would start before scene ${ranges[i - 1].sceneNumber}`);
  }
  const scenes = ranges.map((r, i) => ({
    sceneNumber: r.sceneNumber,
    start: starts[i],
    end: i + 1 < starts.length ? starts[i + 1] : total,
    firstWordIndex: r.first,
    lastWordIndex: r.last,
  }));

  // Shots: split long scenes into equal, frame-aligned sub-shots.
  const maxShot = opts.maxShotSeconds ?? 6;
  const shots = scenes.flatMap((s) => {
    const startF = Math.round(s.start * fps);
    const endF = Math.round(s.end * fps);
    const k = Math.max(1, Math.ceil((endF - startF) / (maxShot * fps)));
    return Array.from({ length: k }, (_, i) => ({
      sceneNumber: s.sceneNumber,
      shotIndex: i,
      start: (startF + Math.round(((endF - startF) * i) / k)) / fps,
      end: (startF + Math.round(((endF - startF) * (i + 1)) / k)) / fps,
    }));
  });

  // Caption cues: short groups of words, broken at punctuation, timed by real word timestamps.
  const cues: CaptionCue[] = [];
  for (const r of ranges) {
    let group: number[] = [];
    const flush = () => {
      if (group.length === 0) return;
      const text = group.map((w) => displayWord(words[w].word)).filter(Boolean);
      cues.push({
        index: cues.length,
        sceneNumber: r.sceneNumber,
        start: words[group[0]].start,
        end: words[group[group.length - 1]].end,
        lines: layoutLines(text, layout),
        firstWordIndex: group[0],
        lastWordIndex: group[group.length - 1],
      });
      group = [];
    };
    for (let w = r.first; w <= r.last; w++) {
      const candidate = [...group, w];
      const fits = layoutLines(candidate.map((i) => displayWord(words[i].word)).filter(Boolean), layout).length <= layout.maxLines;
      const tooLong = group.length > 0 && words[w].end - words[group[0]].start > layout.maxCueSeconds;
      if (group.length > 0 && (candidate.length > layout.maxWordsPerCue || !fits || tooLong)) flush();
      group.push(w);
      const raw = words[w].word;
      if (/[.!?]["')\]]?$/.test(raw) || (/[,;:]$/.test(raw) && group.length >= 2)) flush();
    }
    flush();
  }
  // Each cue stays on screen until the next one starts (or briefly after its last word).
  for (let i = 0; i < cues.length; i++) {
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : total;
    const end = Math.min(nextStart, cues[i].end + 0.35, total);
    cues[i].end = Math.max(end, Math.min(cues[i].start + 0.25, nextStart));
  }

  return TimelineSchema.parse({ fps, narrationDurationSeconds: narration.durationSeconds, totalDurationSeconds: total, totalFrames, scenes, shots, captions: cues });
}

/** Caption text for a word: uppercase, without characters that have meaning in ASS markup. */
export function displayWord(word: string): string {
  return word.replace(/[{}\\]/g, '').toUpperCase();
}
