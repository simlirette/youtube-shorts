import fs from 'node:fs';
import { InternalError } from './errors.js';

/**
 * Narration continuity: removes excessive silence before the first word and between words, and
 * returns word timestamps realigned to the edited audio. Cuts are placed in the middle of gaps,
 * keeping half the target gap on each side of every word, so speech is never clipped.
 */

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface GapPolicy {
  /** Silence kept before the first word. */
  leadSeconds: number;
  /** Gaps longer than this are shortened to it. */
  gapTargetSeconds: number;
  /** Audio kept after the last word ends. */
  tailSeconds: number;
}

export interface CutPlan {
  /** Intervals (seconds, original timeline) removed from the audio, ascending and disjoint. */
  cuts: Array<{ start: number; end: number }>;
  words: TimedWord[];
  leadingTrimmedSeconds: number;
  gapsTightened: number;
  secondsRemoved: number;
  durationAfter: number;
  maxGapAfterSeconds: number;
}

/** Pure planning step (unit-tested): which intervals to remove and the realigned timestamps. */
export function planGapTightening(words: TimedWord[], durationSeconds: number, policy: GapPolicy): CutPlan {
  if (words.length === 0) throw new InternalError('cannot tighten narration without word timestamps');
  const cuts: Array<{ start: number; end: number }> = [];
  let leading = 0;
  if (words[0].start > policy.leadSeconds) {
    leading = words[0].start - policy.leadSeconds;
    cuts.push({ start: 0, end: leading });
  }
  let tightened = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > policy.gapTargetSeconds + 0.005) {
      const start = words[i - 1].end + policy.gapTargetSeconds / 2;
      cuts.push({ start, end: start + (gap - policy.gapTargetSeconds) });
      tightened++;
    }
  }
  const lastEnd = words[words.length - 1].end;
  if (durationSeconds > lastEnd + policy.tailSeconds) cuts.push({ start: lastEnd + policy.tailSeconds, end: durationSeconds });

  const removedBefore = (t: number) => cuts.reduce((acc, c) => acc + (c.end <= t ? c.end - c.start : c.start < t ? t - c.start : 0), 0);
  const realigned = words.map((w) => ({ word: w.word, start: round(w.start - removedBefore(w.start)), end: round(w.end - removedBefore(w.end)) }));
  const secondsRemoved = cuts.reduce((a, c) => a + (c.end - c.start), 0);
  let maxGap = 0;
  for (let i = 1; i < realigned.length; i++) maxGap = Math.max(maxGap, realigned[i].start - realigned[i - 1].end);
  return {
    cuts,
    words: realigned,
    leadingTrimmedSeconds: round(leading),
    gapsTightened: tightened,
    secondsRemoved: round(secondsRemoved),
    durationAfter: round(durationSeconds - secondsRemoved),
    maxGapAfterSeconds: round(Math.max(0, maxGap)),
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Second, acoustic pass. Provider alignment attributes part of each pause to the neighbouring words
 * (live: 0.33-0.41 s of silence remained after timestamp-based tightening), so silences measured on
 * the audio itself are shortened to `gapTargetSeconds` too: the middle of each interior silence is
 * removed, so the kept audio on both sides is still silence. Timestamps that fall inside a removed
 * interval move to its start.
 */
export function planSilenceCuts(
  silences: Array<{ start: number; end: number }>,
  words: TimedWord[],
  gapTargetSeconds: number
): { cuts: Array<{ start: number; end: number }>; words: TimedWord[]; secondsRemoved: number } {
  if (words.length === 0) return { cuts: [], words, secondsRemoved: 0 };
  const first = words[0].start;
  const last = words[words.length - 1].end;
  const cuts = silences
    .filter((x) => x.start >= first && x.end <= last && x.end - x.start > gapTargetSeconds + 0.01)
    .sort((x, y) => x.start - y.start)
    .map((x) => ({ start: x.start + gapTargetSeconds / 2, end: x.end - gapTargetSeconds / 2 }));
  const removedBefore = (t: number) => cuts.reduce((acc, c) => acc + (c.end <= t ? c.end - c.start : c.start < t ? t - c.start : 0), 0);
  return {
    cuts,
    words: words.map((w) => ({ word: w.word, start: round(w.start - removedBefore(w.start)), end: round(w.end - removedBefore(w.end)) })),
    secondsRemoved: round(cuts.reduce((n, c) => n + (c.end - c.start), 0)),
  };
}

/** Applies `planSilenceCuts` to a PCM16 WAV in place. */
export function cutSilencesWav(wavPath: string, silences: Array<{ start: number; end: number }>, words: TimedWord[], gapTargetSeconds: number) {
  const plan = planSilenceCuts(silences, words, gapTargetSeconds);
  if (plan.cuts.length > 0) writeWavPcm16(wavPath, applyCuts(readWavPcm16(wavPath), plan.cuts));
  return plan;
}

export interface Pcm16 {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

/** Minimal PCM16 WAV reader (the renderer's narration format). */
export function readWavPcm16(file: string): Pcm16 {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new InternalError(`${file} is not a WAV file`);
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new InternalError(`${file}: only PCM 16-bit WAV is supported`);
      const len = Math.min(size, buf.length - body);
      const samples = new Int16Array(len / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(body + i * 2);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
    }
    off = body + size + (size % 2);
  }
  throw new InternalError(`${file}: no data chunk`);
}

export function writeWavPcm16(file: string, pcm: Pcm16): void {
  const dataBytes = pcm.samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(pcm.channels, 22);
  buf.writeUInt32LE(pcm.sampleRate, 24);
  buf.writeUInt32LE(pcm.sampleRate * pcm.channels * 2, 28);
  buf.writeUInt16LE(pcm.channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.samples.length; i++) buf.writeInt16LE(pcm.samples[i], 44 + i * 2);
  fs.writeFileSync(file, buf);
}

/** Removes the planned intervals, with a 5 ms crossfade at every join to avoid clicks. */
export function applyCuts(pcm: Pcm16, cuts: Array<{ start: number; end: number }>): Pcm16 {
  const frames = pcm.samples.length / pcm.channels;
  const keep: Array<[number, number]> = [];
  let cursor = 0;
  for (const c of cuts) {
    const a = Math.max(cursor, Math.round(c.start * pcm.sampleRate));
    const b = Math.min(frames, Math.round(c.end * pcm.sampleRate));
    if (a > cursor) keep.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < frames) keep.push([cursor, frames]);
  const total = keep.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Int16Array(total * pcm.channels);
  const fade = Math.round(0.005 * pcm.sampleRate);
  let w = 0;
  keep.forEach(([a, b], k) => {
    for (let f = a; f < b; f++) {
      const pos = f - a;
      const fromEnd = b - 1 - f;
      let g = 1;
      if (k > 0 && pos < fade) g = Math.min(g, pos / fade);
      if (k < keep.length - 1 && fromEnd < fade) g = Math.min(g, fromEnd / fade);
      for (let ch = 0; ch < pcm.channels; ch++) out[w * pcm.channels + ch] = Math.round(pcm.samples[f * pcm.channels + ch] * g);
      w++;
    }
  });
  return { ...pcm, samples: out };
}

/** Plans and applies gap tightening to a PCM16 WAV in place; returns the plan (with realigned words). */
export function tightenNarrationWav(wavPath: string, words: TimedWord[], policy: GapPolicy): CutPlan {
  const pcm = readWavPcm16(wavPath);
  const duration = pcm.samples.length / pcm.channels / pcm.sampleRate;
  const plan = planGapTightening(words, duration, policy);
  if (plan.cuts.length > 0) writeWavPcm16(wavPath, applyCuts(pcm, plan.cuts));
  return plan;
}
