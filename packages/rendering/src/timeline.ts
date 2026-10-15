import { CaptionCue, ShortScript, Timeline, TimelineSchema, VoiceNarration } from '@shorts/schemas';
import { InternalError, tokenizeWords } from '@shorts/core';
import { CAPTION_LAYOUT, CaptionLayout, layoutLines } from './captions.js';

export interface TimelineOptions {
  fps: number;
  /** Longest a single visual may stay on screen before the scene is split into another shot. */
  maxShotSeconds?: number;
  /** Beats shorter than this are merged with a neighbour (a cut must have time to register). */
  minShotSeconds?: number;
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

  // Shots. Scenes with clause-level beats cut on beat boundaries (merging beats that are too short
  // to register, splitting ones that hold the screen too long); legacy scenes split into equal parts.
  const maxShot = opts.maxShotSeconds ?? 6;
  const minShot = opts.minShotSeconds ?? 1.5;
  const split = (sceneNumber: number, start: number, end: number, extra: { beatIndex?: number; firstWordIndex?: number; lastWordIndex?: number }) => {
    const startF = Math.round(start * fps);
    const endF = Math.round(end * fps);
    const k = Math.max(1, Math.ceil((endF - startF) / (maxShot * fps)));
    return Array.from({ length: k }, (_, i) => ({
      sceneNumber,
      shotIndex: 0,
      start: (startF + Math.round(((endF - startF) * i) / k)) / fps,
      end: (startF + Math.round(((endF - startF) * (i + 1)) / k)) / fps,
      ...extra,
    }));
  };
  const shots = scenes.flatMap((s, si) => {
    const beats = script.scenes[si].beats ?? [];
    let out: Array<{ sceneNumber: number; shotIndex: number; start: number; end: number; beatIndex?: number; firstWordIndex?: number; lastWordIndex?: number }>;
    if (beats.length === 0) out = split(s.sceneNumber, s.start, s.end, {});
    else {
      // Word range of each beat inside the scene (beats are exact token slices, validated upstream).
      let w = s.firstWordIndex;
      const ranges = beats.map((b, bi) => {
        const n = tokenizeWords(b.text).length;
        const r = { beatIndex: bi, first: w, last: w + n - 1 };
        w += n;
        return r;
      });
      if (w - 1 !== s.lastWordIndex) throw new InternalError(`Scene ${s.sceneNumber} beats cover ${w - s.firstWordIndex} words, narration has ${s.lastWordIndex - s.firstWordIndex + 1}`);
      // Cut between beats midway through the pause, frame-aligned, inside the scene's interval.
      const bounds = ranges.map((r, i) => (i === 0 ? s.start : q((words[ranges[i - 1].last].end + words[r.first].start) / 2)));
      let units = ranges.map((r, i) => ({ ...r, start: bounds[i], end: i + 1 < bounds.length ? bounds[i + 1] : s.end }));
      // Merge beats too short to register into a neighbour (the earlier beat keeps its subject).
      let merged = true;
      while (merged && units.length > 1) {
        merged = false;
        const i = units.findIndex((u) => u.end - u.start < minShot);
        if (i === -1) break;
        const j = i + 1 < units.length ? i + 1 : i - 1;
        const [a, b] = j > i ? [units[i], units[j]] : [units[j], units[i]];
        const joined = { beatIndex: a.beatIndex, first: a.first, last: b.last, start: a.start, end: b.end };
        units = [...units.slice(0, Math.min(i, j)), joined, ...units.slice(Math.max(i, j) + 1)];
        merged = true;
      }
      out = units.flatMap((u) => split(s.sceneNumber, u.start, u.end, { beatIndex: u.beatIndex, firstWordIndex: u.first, lastWordIndex: u.last }));
    }
    return out.map((x, i) => ({ ...x, shotIndex: i }));
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
