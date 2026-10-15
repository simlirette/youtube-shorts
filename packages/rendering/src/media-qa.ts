import fs from 'node:fs';
import path from 'node:path';
import type { QACheck, QAReport, Timeline, VoiceNarration } from '@shorts/schemas';
import {
  audioEnvelope,
  correlation,
  decodeErrors,
  detectBlack,
  detectSilence,
  analysisBox,
  analyzeFrame,
  extractRgbFrames,
  frameDefects,
  getConfig,
  measureLoudness,
  runFfmpeg,
  runProcessBuffer,
  summarizeMedia,
  volumeStats,
} from '@shorts/core';
import { CAPTION_LAYOUT, CaptionLayout, TITLE_CARD_LAYOUT } from './captions.js';
import { OUTPUT } from './renderer.js';

export interface MediaQALimits {
  minSeconds: number;
  maxSeconds: number;
  targetLufs: number;
  toleranceLu: number;
  /** Narration must start by this time (s). */
  speechStartMax?: number;
  /** Longest silence allowed inside the narration stem (s). */
  maxSpeechGap?: number;
  /** Target speaking pace (words per second, measured from word timestamps). */
  paceMin?: number;
  paceMax?: number;
  /** Share of shots that must fill the frame (others need human review). */
  fullBleedMinRatio?: number;
  /** Largest source-to-output upscale allowed for a crop. */
  maxUpscale?: number;
  /** True-peak ceiling of the final mix (dBTP). */
  truePeakMax?: number;
}

export interface MediaQAInput {
  videoPath: string;
  /** Same render without captions; required to prove captions were burned in. */
  uncaptionedPath?: string;
  narration: VoiceNarration;
  timeline: Timeline;
  /** Directory containing captions.ass and fonts/ used for the render. */
  renderDir: string;
  limits: MediaQALimits;
  layout?: CaptionLayout;
  /** Framing actually used per shot (from the assets), for the full-bleed and upscale checks. */
  framing?: Array<{
    label: string;
    mode: 'cover' | 'crop_pan' | 'letterbox';
    upscale: number;
    reason: string;
  }>;
  /** Music bed: what the variant asked for and what was mixed. */
  music?: {
    requested: boolean;
    trackId: string | null;
    disabledReason?: string;
    gainDb?: number;
    trackLufs?: number;
  };
}

export interface CaptionBox {
  cueIndex: number;
  t: number;
  box: { x1: number; x2: number; y1: number; y2: number } | null;
}

function summarizeChecks(checks: QACheck[]): QAReport {
  const fails = checks.filter((c) => c.status === 'FAIL');
  const blockingWarns = checks.filter((c) => c.status === 'WARN' && c.blocking);
  return {
    kind: 'MEDIA',
    checks,
    overallStatus: fails.length ? 'FAIL' : checks.some((c) => c.status === 'WARN') ? 'WARN' : 'PASS',
    publishEligible: fails.length === 0 && blockingWarns.length === 0,
    blockingReasons: [...fails, ...blockingWarns].map((c) => `${c.id}: ${c.message}`),
    requiresHumanReview: checks.some((c) => c.reviewRequired),
    reviewReasons: checks.filter((c) => c.reviewRequired).map((c) => `${c.id}: ${c.message}`),
  };
}

/**
 * Interprets silence intervals against the spoken words.
 * - Interior gap: silence that starts after speech begins and ends before the last word starts.
 * - Missing ending: silence that begins at or before the last word's start and runs past it
 *   (the final word was never audible). TTS alignment often pads the last word to the end of the
 *   audio, so trailing silence *after* the last word has audibly started is not a defect.
 */
export function classifySilences(silences: Array<{ start: number; end: number }>, words: Array<{ start: number; end: number }>): string[] {
  const first = words[0].start;
  const last = words[words.length - 1];
  const problems: string[] = [];
  for (const s of silences) {
    if (s.end <= first + 0.1) continue; // leading silence
    if (s.end < last.start) problems.push(`silence during speech at ${s.start.toFixed(1)}-${s.end.toFixed(1)}s`);
    else if (s.start <= last.start + 0.1) problems.push(`final word (starting ${last.start.toFixed(2)}s) is not audible: silence from ${s.start.toFixed(1)}s`);
  }
  return problems;
}

const selectExpr = (frames: number[]) => `select='${frames.map((f) => `eq(n\\,${f})`).join('+')}'`;

/**
 * Renders the captions alone (same ASS file and fonts, via libass) over black, pulls the frame at
 * each cue's midpoint as raw grayscale pixels, and computes the exact bounding box of lit pixels.
 */
export async function measureCaptionBoxes(renderDir: string, timeline: Timeline): Promise<CaptionBox[]> {
  const fps = timeline.fps;
  const W = OUTPUT.width / 2;
  const H = OUTPUT.height / 2;
  const frames = timeline.captions.map((c) => Math.min(timeline.totalFrames - 1, Math.round(((c.start + c.end) / 2) * fps)));
  const unique = [...new Set(frames)].sort((a, b) => a - b);
  const cfg = getConfig();
  const res = await runProcessBuffer(
    cfg.FFMPEG_PATH,
    [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-f', 'lavfi', '-i', `color=c=black:s=${OUTPUT.width}x${OUTPUT.height}:r=${fps}:d=${timeline.totalDurationSeconds.toFixed(3)}`,
      '-vf', `ass=captions.ass:fontsdir=fonts,${selectExpr(unique)},scale=${W}:${H}:flags=area,format=gray`,
      '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-',
    ],
    { cwd: renderDir, description: 'caption layout measurement' }
  );
  if (res.code !== 0) throw new Error(`caption measurement render failed: ${res.stderr.slice(-300)}`);
  const frameBytes = W * H;
  if (res.stdout.length !== frameBytes * unique.length) {
    throw new Error(`caption measurement returned ${res.stdout.length / frameBytes} frames, expected ${unique.length}`);
  }
  const measured = new Map<number, CaptionBox['box']>();
  unique.forEach((frame, fi) => {
    const base = fi * frameBytes;
    let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
    for (let y = 0; y < H; y++) {
      const row = base + y * W;
      for (let x = 0; x < W; x++) {
        if (res.stdout[row + x] > 96) {
          if (x < x1) x1 = x;
          if (x > x2) x2 = x;
          if (y < y1) y1 = y;
          if (y > y2) y2 = y;
        }
      }
    }
    measured.set(frame, x2 >= x1 ? { x1: x1 * 2, x2: x2 * 2 + 1, y1: y1 * 2, y2: y2 * 2 + 1 } : null);
  });
  return timeline.captions.map((c, i) => ({
    cueIndex: c.index,
    t: frames[i] / fps,
    box: measured.get(frames[i]) ?? null,
  }));
}

/** Bounding boxes of lit pixels of an ASS file rendered alone over black, at the given times. */
export async function measureAssBoxes(renderDir: string, assFile: string, times: number[], fps: number, totalSeconds: number): Promise<Array<CaptionBox['box']>> {
  const W = OUTPUT.width / 2;
  const H = OUTPUT.height / 2;
  const frames = times.map((t) => Math.round(t * fps));
  const unique = [...new Set(frames)].sort((a, b) => a - b);
  const cfg = getConfig();
  const res = await runProcessBuffer(
    cfg.FFMPEG_PATH,
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${OUTPUT.width}x${OUTPUT.height}:r=${fps}:d=${totalSeconds.toFixed(3)}`,
      '-vf',
      `ass=${assFile}:fontsdir=fonts,${selectExpr(unique)},scale=${W}:${H}:flags=area,format=gray`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-',
    ],
    { cwd: renderDir, description: `${assFile} layout measurement` }
  );
  if (res.code !== 0) throw new Error(`${assFile} measurement render failed: ${res.stderr.slice(-300)}`);
  const frameBytes = W * H;
  const out = new Map<number, CaptionBox['box']>();
  unique.forEach((frame, fi) => {
    const base = fi * frameBytes;
    let x1 = Infinity,
      x2 = -Infinity,
      y1 = Infinity,
      y2 = -Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (res.stdout[base + y * W + x] > 96) {
          if (x < x1) x1 = x;
          if (x > x2) x2 = x;
          if (y < y1) y1 = y;
          if (y > y2) y2 = y;
        }
      }
    }
    out.set(frame, x2 >= x1 ? { x1: x1 * 2, x2: x2 * 2 + 1, y1: y1 * 2, y2: y2 * 2 + 1 } : null);
  });
  return frames.map((f) => out.get(f) ?? null);
}

/** Selected frames of a video as cropped grayscale pixel buffers (frame order = ascending frame index). */
async function grayFrames(videoPath: string, frames: number[], region: { x: number; y: number; w: number; h: number }, fps: number): Promise<Buffer[]> {
  const cfg = getConfig();
  const size = region.w * region.h;
  const out: Buffer[] = [];
  // One accurate seek per sample: exactly one frame per call, independent of container timestamp quirks.
  for (const f of frames) {
    const res = await runProcessBuffer(
      cfg.FFMPEG_PATH,
      ['-hide_banner', '-nostdin', '-v', 'error', '-ss', ((f + 0.5) / fps).toFixed(4), '-i', videoPath, '-map', '0:v:0',
        '-frames:v', '1', '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y},format=gray`, '-f', 'rawvideo', '-'],
      { description: 'frame extraction' }
    );
    if (res.code !== 0 || res.stdout.length !== size) {
      throw new Error(`frame extraction from ${videoPath} at frame ${f} returned ${res.stdout.length} bytes, expected ${size}`);
    }
    out.push(res.stdout);
  }
  return out;
}

/** Mean absolute luma difference in `region` between captioned and uncaptioned frames. */
async function captionDiff(finalPath: string, uncaptionedPath: string, frames: number[], raw: { x: number; y: number; w: number; h: number }, fps: number): Promise<number[]> {
  // yuv420p crops snap to even coordinates/sizes; align up front so byte counts are exact.
  const x = raw.x - (raw.x % 2);
  const y = raw.y - (raw.y % 2);
  const region = {
    x,
    y,
    w: Math.min(OUTPUT.width - x, raw.w + (raw.x % 2) + ((raw.w + (raw.x % 2)) % 2)),
    h: Math.min(OUTPUT.height - y, raw.h + (raw.y % 2) + ((raw.h + (raw.y % 2)) % 2)),
  };
  region.w -= region.w % 2;
  region.h -= region.h % 2;
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const [a, b] = await Promise.all([grayFrames(finalPath, sorted, region, fps), grayFrames(uncaptionedPath, sorted, region, fps)]);
  return sorted.map((_, i) => {
    let sum = 0;
    for (let k = 0; k < a[i].length; k++) sum += Math.abs(a[i][k] - b[i][k]);
    return sum / a[i].length;
  });
}

/**
 * Objective QA of the produced MP4. Every check inspects the actual artifact with ffprobe/FFmpeg.
 * A thrown tool error is converted into a FAIL check: QA never passes because it could not look.
 */
export async function evaluateMedia(input: MediaQAInput): Promise<QAReport> {
  const checks: QACheck[] = [];
  const layout = input.layout ?? CAPTION_LAYOUT;
  const { timeline, narration, limits } = input;
  const add = (id: string, category: string, status: QACheck['status'], message: string, extra: Partial<QACheck> = {}) =>
    checks.push({
      id,
      category,
      status,
      blocking: status !== 'PASS',
      reviewRequired: false,
      message,
      ...extra,
    });
  const guard = async (id: string, category: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      add(id, category, 'FAIL', `check could not be completed: ${(err as Error).message}`);
    }
  };

  // ---- Container -------------------------------------------------------------------------------
  if (!fs.existsSync(input.videoPath) || fs.statSync(input.videoPath).size === 0) {
    add('container.exists', 'container', 'FAIL', `output missing or empty: ${input.videoPath}`);
    return summarizeChecks(checks);
  }
  add('container.exists', 'container', 'PASS', `${fs.statSync(input.videoPath).size} bytes`);

  let probe: Awaited<ReturnType<typeof summarizeMedia>>;
  try {
    probe = await summarizeMedia(input.videoPath);
  } catch (err) {
    add('container.readable', 'container', 'FAIL', (err as Error).message);
    return summarizeChecks(checks);
  }
  add('container.readable', 'container', 'PASS', `format ${probe.formatName}`);
  add('container.format', 'container', probe.formatName.includes('mp4') ? 'PASS' : 'FAIL', `format ${probe.formatName}`, { expected: 'mp4' });
  await guard('container.decode', 'container', async () => {
    const errs = await decodeErrors(input.videoPath);
    add('container.decode', 'container', errs.length === 0 ? 'PASS' : 'FAIL', errs.length ? errs.slice(0, 3).join(' | ') : 'full decode without errors');
  });

  // ---- Video stream ------------------------------------------------------------------------------
  const v = probe.video;
  add('video.streams', 'video', probe.videoStreams === 1 ? 'PASS' : 'FAIL', `${probe.videoStreams} video stream(s)`, { expected: 1 });
  if (v) {
    add('video.codec', 'video', v.codec === 'h264' ? 'PASS' : 'FAIL', v.codec, {
      expected: 'h264',
    });
    add('video.geometry', 'video', v.width === OUTPUT.width && v.height === OUTPUT.height ? 'PASS' : 'FAIL', `${v.width}x${v.height}`, { expected: '1080x1920' });
    add('video.fps', 'video', Math.abs(v.fps - OUTPUT.fps) < 0.01 ? 'PASS' : 'FAIL', `${v.fps.toFixed(3)} fps`, { expected: 30 });
    add('video.pixfmt', 'video', v.pixFmt === 'yuv420p' ? 'PASS' : 'FAIL', String(v.pixFmt), { expected: 'yuv420p' });
  }

  // ---- Audio stream ------------------------------------------------------------------------------
  const a = probe.audio;
  add('audio.streams', 'audio', probe.audioStreams === 1 ? 'PASS' : 'FAIL', `${probe.audioStreams} audio stream(s)`, { expected: 1 });
  if (a) {
    add('audio.codec', 'audio', a.codec === 'aac' ? 'PASS' : 'FAIL', a.codec, {
      expected: 'aac',
    });
    add('audio.format', 'audio', a.sampleRate === 48000 && a.channels === 2 ? 'PASS' : 'FAIL', `${a.sampleRate} Hz, ${a.channels} ch`, { expected: '48000 Hz, 2 ch' });
  }

  // ---- Duration & synchronization ----------------------------------------------------------------
  const dur = probe.durationSeconds;
  const lastWordEnd = narration.wordTimestamps[narration.wordTimestamps.length - 1].end;
  add('duration.range', 'sync', dur >= limits.minSeconds && dur <= limits.maxSeconds ? 'PASS' : 'FAIL', `${dur.toFixed(2)}s`, { expected: `${limits.minSeconds}-${limits.maxSeconds}s` });
  if (v && a) {
    const diff = Math.abs(v.durationSeconds - a.durationSeconds);
    add('sync.avDuration', 'sync', diff <= 0.1 ? 'PASS' : 'FAIL', `video ${v.durationSeconds.toFixed(3)}s vs audio ${a.durationSeconds.toFixed(3)}s`, { measured: diff, expected: '<= 0.1s' });
    const notTruncated = a.durationSeconds >= lastWordEnd + 0.1 && v.durationSeconds >= lastWordEnd + 0.1;
    add('sync.narrationComplete', 'sync', notTruncated ? 'PASS' : 'FAIL', `last word ends ${lastWordEnd.toFixed(2)}s; audio ${a.durationSeconds.toFixed(2)}s; video ${v.durationSeconds.toFixed(2)}s`);
  }
  add('sync.timeline', 'sync', Math.abs(dur - timeline.totalDurationSeconds) <= 0.1 ? 'PASS' : 'FAIL', `container ${dur.toFixed(3)}s vs timeline ${timeline.totalDurationSeconds.toFixed(3)}s`);

  // Scene timeline integrity (derived from narration words).
  {
    const problems: string[] = [];
    const sc = timeline.scenes;
    if (sc[0]?.start !== 0) problems.push('first scene does not start at 0');
    for (let i = 0; i < sc.length; i++) {
      if (sc[i].end - sc[i].start < 0.4) problems.push(`scene ${sc[i].sceneNumber} shorter than 0.4s`);
      if (i > 0 && Math.abs(sc[i].start - sc[i - 1].end) > 1e-6) problems.push(`gap/overlap before scene ${sc[i].sceneNumber}`);
      const w0 = narration.wordTimestamps[sc[i].firstWordIndex];
      const w1 = narration.wordTimestamps[sc[i].lastWordIndex];
      if (w0.start + 0.05 < sc[i].start || w1.end - 0.05 > sc[i].end) problems.push(`scene ${sc[i].sceneNumber} does not contain its narration`);
    }
    if (Math.abs((sc[sc.length - 1]?.end ?? 0) - timeline.totalDurationSeconds) > 1e-6) problems.push('last scene does not end at timeline end');
    add('timeline.scenes', 'sync', problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : `${sc.length} contiguous scenes aligned to narration`);
  }

  // ---- Audio content -----------------------------------------------------------------------------
  if (a) {
    await guard('audio.notSilent', 'audio', async () => {
      const vol = await volumeStats(input.videoPath);
      add('audio.notSilent', 'audio', vol.meanDb > -40 ? 'PASS' : 'FAIL', `mean ${vol.meanDb} dB, max ${vol.maxDb} dB`, { expected: 'mean > -40 dB' });
    });
    await guard('audio.speechGaps', 'audio', async () => {
      const problems = classifySilences(await detectSilence(input.videoPath, -45, 1.2), narration.wordTimestamps);
      add('audio.speechGaps', 'audio', problems.length === 0 ? 'PASS' : 'FAIL', problems.length ? problems.join('; ') : 'no silent gaps during narration; final word audible');
    });
    await guard('audio.loudness', 'audio', async () => {
      const l = await measureLoudness(input.videoPath);
      const off = Math.abs(l.integratedLufs - limits.targetLufs);
      const status = !Number.isFinite(l.integratedLufs) || l.integratedLufs < -30 ? 'FAIL' : off > limits.toleranceLu ? 'WARN' : 'PASS';
      add('audio.loudness', 'audio', status, `${l.integratedLufs} LUFS`, {
        expected: `${limits.targetLufs}±${limits.toleranceLu}`,
      });
      const tpMax = limits.truePeakMax ?? -0.5;
      const tpStatus = l.truePeakDb > 0 ? 'FAIL' : l.truePeakDb > tpMax ? 'WARN' : 'PASS';
      add('audio.truePeak', 'audio', tpStatus, `${l.truePeakDb} dBTP`, {
        expected: `<= ${tpMax} dBTP`,
      });
    });

    // Narration continuity and pace, measured on the narration stem (music is never mistaken for speech).
    const words = narration.wordTimestamps;
    if (limits.speechStartMax !== undefined) {
      add('audio.speechStart', 'audio', words[0].start <= limits.speechStartMax ? 'PASS' : 'FAIL', `first word at ${words[0].start.toFixed(2)}s`, { expected: `<= ${limits.speechStartMax}s` });
    }
    if (limits.maxSpeechGap !== undefined) {
      const maxGap = limits.maxSpeechGap;
      await guard('audio.speechContinuity', 'audio', async () => {
        const last = words[words.length - 1];
        const gaps = (await detectSilence(narration.audioPath, -45, maxGap)).filter((s) => s.start > words[0].start + 0.05 && s.end < last.end - 0.05);
        let alignedMax = 0;
        for (let i = 1; i < words.length; i++) alignedMax = Math.max(alignedMax, words[i].start - words[i - 1].end);
        add(
          'audio.speechContinuity',
          'audio',
          gaps.length === 0 && alignedMax <= maxGap + 1e-3 ? 'PASS' : 'FAIL',
          gaps.length
            ? `narration stem has ${gaps.length} silence(s) >= ${maxGap}s (first ${gaps[0].start.toFixed(2)}-${gaps[0].end.toFixed(2)}s)`
            : `longest pause between words ${alignedMax.toFixed(2)}s; no dead air in the narration stem`,
          { measured: alignedMax, expected: `<= ${maxGap}s` }
        );
      });
    }
    if (limits.paceMin !== undefined && limits.paceMax !== undefined) {
      const span = words[words.length - 1].end - words[0].start;
      const wps = span > 0 ? words.length / span : 0;
      const inRange = wps >= limits.paceMin && wps <= limits.paceMax;
      checks.push({
        id: 'audio.pace',
        category: 'audio',
        status: inRange ? 'PASS' : 'WARN',
        blocking: false,
        reviewRequired: !inRange,
        message: `${wps.toFixed(2)} words/s over ${span.toFixed(1)}s of speech`,
        measured: Math.round(wps * 100) / 100,
        expected: `${limits.paceMin}-${limits.paceMax}`,
      });
    }

    // Music bed: audible after the narration ends (the bed carries the tail), or honestly reported as absent.
    if (input.music) {
      const m = input.music;
      if (m.trackId) {
        await guard('audio.musicBed', 'audio', async () => {
          const lastEnd = words[words.length - 1].end;
          const win = Math.max(0.15, timeline.totalDurationSeconds - 0.4 - (lastEnd + 0.1));
          const tail = await runFfmpeg(['-nostats', '-ss', (lastEnd + 0.1).toFixed(3), '-t', win.toFixed(3), '-i', input.videoPath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], {
            description: 'music bed tail level',
          });
          const mean = Number(tail.stderr.match(/mean_volume:\s*(-?[\d.]+)/)?.[1] ?? -91);
          add('audio.musicBed', 'audio', mean > -60 ? 'PASS' : 'FAIL', `track ${m.trackId}; bed level after narration ${mean} dB`, {
            expected: '> -60 dB (bed present), voice dominant (see audio.isNarration)',
          });
        });
      } else if (m.requested) {
        checks.push({
          id: 'audio.musicBed',
          category: 'audio',
          status: 'WARN',
          blocking: false,
          reviewRequired: false,
          message: `NOT MET: music requested but disabled — ${m.disabledReason ?? 'no approved track'}`,
        });
      } else {
        add('audio.musicBed', 'audio', 'PASS', 'music off for this variant (experiment arm or configuration)');
      }
    }
    await guard('audio.isNarration', 'audio', async () => {
      const [ref, out] = await Promise.all([audioEnvelope(narration.audioPath), audioEnvelope(input.videoPath)]);
      const n = Math.min(ref.length, out.length);
      const r = correlation(ref.slice(0, n), out.slice(0, n));
      // A ducked music bed fills the micro-gaps between words, so the bar is lower with a bed — and
      // voice dominance is then proven separately by loudness (audio.voiceDominant).
      const min = input.music?.trackId ? 0.85 : 0.9;
      add('audio.isNarration', 'audio', r >= min ? 'PASS' : 'FAIL', `envelope correlation with narration ${r.toFixed(3)} over ${n} windows`, { measured: r, expected: `>= ${min}` });
    });
    if (input.music?.trackId) {
      await guard('audio.voiceDominant', 'audio', async () => {
        // The bed's level is set by the mix recipe (track loudness + applied gain); it is verified here
        // against the narration stem's measured loudness. Ducking then lowers it further under speech,
        // and audio.isNarration checks the mixed artifact itself.
        const m = input.music!;
        if (typeof m.gainDb !== 'number' || typeof m.trackLufs !== 'number') {
          add('audio.voiceDominant', 'audio', 'FAIL', 'bed gain or track loudness was not recorded with the render', { expected: '>= 12 LU below the voice' });
        } else {
          const stem = await measureLoudness(narration.audioPath);
          const below = stem.integratedLufs - (m.trackLufs + m.gainDb);
          add('audio.voiceDominant', 'audio', below >= 12 ? 'PASS' : 'FAIL', `bed set ${below.toFixed(1)} LU below the narration (${stem.integratedLufs} LUFS), ducked further under speech`, {
            measured: below,
            expected: '>= 12 LU below the voice',
          });
        }
      });
    }
  }

  // ---- Visual content ----------------------------------------------------------------------------
  await guard('video.black', 'video', async () => {
    const black = await detectBlack(input.videoPath, 0.5);
    add('video.black', 'video', black.length === 0 ? 'PASS' : 'FAIL', black.length ? `black segments: ${black.map((b) => `${b.start.toFixed(1)}-${b.end.toFixed(1)}s`).join(', ')}` : 'no black segments >= 0.5s');
  });
  await guard('video.frozen', 'video', async () => {
    const res = await runFfmpeg(['-nostats', '-i', input.videoPath, '-map', '0:v:0', '-vf', 'freezedetect=n=-60dB:d=2', '-an', '-f', 'null', '-'], { description: 'freeze detection' });
    const frozen = [...res.stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    add('video.frozen', 'video', frozen.length ? 'WARN' : 'PASS', frozen.length ? `frozen picture from ${frozen.map((f) => f.toFixed(1)).join(', ')}s` : 'no frozen segments >= 2s');
  });

  // Frame content of the produced video at every shot midpoint (catches artifacts that reach the render).
  await guard('video.frameDefects', 'video', async () => {
    const box = analysisBox(OUTPUT.width, OUTPUT.height);
    const shots = timeline.shots?.length
      ? timeline.shots
      : timeline.scenes.map((s) => ({
          sceneNumber: s.sceneNumber,
          shotIndex: 0,
          start: s.start,
          end: s.end,
        }));
    const times = shots.map((s) => (s.start + s.end) / 2);
    const rgb = await extractRgbFrames(input.videoPath, times, box.w, box.h);
    const metrics = rgb.map((b, i) => analyzeFrame(b, box.w, box.h, times[i]));
    // Each shot is judged on its own frame; the static check does not apply across different shots.
    const bad = metrics.flatMap((m, i) => frameDefects([m], [rgb[i]], false).map((d) => `shot ${shots[i].sceneNumber}.${shots[i].shotIndex}: ${d}`));
    add('video.frameDefects', 'video', bad.length ? 'FAIL' : 'PASS', bad.length ? bad.join('; ') : `${metrics.length} shot frames free of black/blank/chroma-key/letterbox defects`);
  });

  // Full-bleed framing and upscale limits (from the framing decisions the renderer applied).
  if (input.framing && input.framing.length > 0) {
    const fr = input.framing;
    const boxed = fr.filter((f) => f.mode === 'letterbox');
    const ratio = (fr.length - boxed.length) / fr.length;
    const min = limits.fullBleedMinRatio ?? 0.9;
    checks.push({
      id: 'video.fullBleed',
      category: 'video',
      status: ratio >= min ? 'PASS' : 'WARN',
      blocking: false,
      reviewRequired: ratio < min,
      message: boxed.length
        ? `${Math.round(ratio * 100)}% of shots fill the frame; letterboxed: ${boxed.map((b) => `${b.label} (${b.reason})`).join('; ')}`
        : `all ${fr.length} shots fill the 9:16 frame`,
      measured: Math.round(ratio * 1000) / 1000,
      expected: `>= ${min}`,
    });
    const maxUp = limits.maxUpscale ?? 2;
    const over = fr.filter((f) => f.mode !== 'letterbox' && f.upscale > maxUp + 1e-6);
    add(
      'video.upscale',
      'video',
      over.length ? 'FAIL' : 'PASS',
      over.length ? `over-upscaled: ${over.map((o) => `${o.label} ${o.upscale}×`).join(', ')}` : `max upscale ${Math.max(...fr.map((f) => f.upscale)).toFixed(2)}×`,
      { expected: `<= ${maxUp}×` }
    );
  }

  // Title card: inside its safe area while shown, gone afterwards (never covers the whole video).
  if (fs.existsSync(path.join(input.renderDir, 'title.ass'))) {
    await guard('titleCard.layout', 'captions', async () => {
      const boxes = await measureAssBoxes(input.renderDir, 'title.ass', [1.0, Math.min(timeline.totalDurationSeconds - 0.05, 3.0)], timeline.fps, timeline.totalDurationSeconds);
      const z = TITLE_CARD_LAYOUT.safeZone;
      const shown = boxes[0];
      const after = boxes[1];
      const inside = Boolean(shown && shown.x1 >= z.left && shown.x2 <= z.right && shown.y1 >= z.top && shown.y2 <= z.bottom);
      add(
        'titleCard.layout',
        'captions',
        inside && !after ? 'PASS' : 'FAIL',
        !shown
          ? 'title card rendered no pixels'
          : !inside
            ? `title card outside its safe area: ${JSON.stringify(shown)}`
            : after
              ? 'title card still visible after 3 s'
              : `title card inside ${JSON.stringify(z)} and gone by 3 s`,
        { measured: shown, expected: z }
      );
    });
  }

  // ---- Captions ----------------------------------------------------------------------------------
  {
    const cues = timeline.captions;
    const problems: string[] = [];
    let expected = 0;
    for (const c of cues) {
      if (c.firstWordIndex !== expected) problems.push(`cue ${c.index} starts at word ${c.firstWordIndex}, expected ${expected}`);
      expected = c.lastWordIndex + 1;
      const w0 = narration.wordTimestamps[c.firstWordIndex];
      if (Math.abs(c.start - w0.start) > 0.05) problems.push(`cue ${c.index} starts ${c.start.toFixed(2)}s but its first word is spoken at ${w0.start.toFixed(2)}s`);
      if (c.end <= c.start) problems.push(`cue ${c.index} has non-positive duration`);
      if (c.end > timeline.totalDurationSeconds + 1e-6) problems.push(`cue ${c.index} ends after the video`);
    }
    for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].end - 1e-6) problems.push(`cues ${i - 1} and ${i} overlap`);
    if (expected !== narration.wordTimestamps.length) problems.push(`captions cover ${expected}/${narration.wordTimestamps.length} words`);
    add('captions.timing', 'captions', problems.length ? 'FAIL' : 'PASS', problems.length ? problems.slice(0, 5).join('; ') : `${cues.length} cues cover all ${expected} words at spoken times`);
  }

  let boxes: CaptionBox[] = [];
  await guard('captions.layout', 'captions', async () => {
    if (!fs.existsSync(path.join(input.renderDir, 'captions.ass'))) throw new Error('captions.ass not found in render directory');
    boxes = await measureCaptionBoxes(input.renderDir, timeline);
    const z = layout.safeZone;
    const missing = boxes.filter((b) => !b.box);
    const outside = boxes.filter((b) => b.box && (b.box.x1 < z.left || b.box.x2 > z.right || b.box.y1 < z.top || b.box.y2 > z.bottom));
    const extent = boxes.filter((b) => b.box).reduce(
      (acc, b) => ({ x1: Math.min(acc.x1, b.box!.x1), x2: Math.max(acc.x2, b.box!.x2), y1: Math.min(acc.y1, b.box!.y1), y2: Math.max(acc.y2, b.box!.y2) }),
      { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity }
    );
    const ok = missing.length === 0 && outside.length === 0;
    add(
      'captions.layout',
      'captions',
      ok ? 'PASS' : 'FAIL',
      ok
        ? `all ${boxes.length} cues rendered inside safe zone (extent x ${extent.x1}-${extent.x2}, y ${extent.y1}-${extent.y2})`
        : `${missing.length} cue(s) rendered no pixels; ${outside.length} cue(s) outside safe zone ${JSON.stringify(z)}${outside[0]?.box ? ` e.g. cue ${outside[0].cueIndex} at ${JSON.stringify(outside[0].box)}` : ''}`,
      { measured: extent, expected: z }
    );
  });

  await guard('captions.burnedIn', 'captions', async () => {
    if (!input.uncaptionedPath || !fs.existsSync(input.uncaptionedPath)) throw new Error('uncaptioned reference render not available');
    const withBox = boxes.filter((b) => b.box);
    if (withBox.length === 0) throw new Error('no caption boxes measured');
    const step = Math.max(1, Math.floor(withBox.length / 6));
    const sample = withBox.filter((_, i) => i % step === 0).slice(0, 6);
    const region = withBox.reduce(
      (acc, b) => ({ x1: Math.min(acc.x1, b.box!.x1), x2: Math.max(acc.x2, b.box!.x2), y1: Math.min(acc.y1, b.box!.y1), y2: Math.max(acc.y2, b.box!.y2) }),
      { x1: Infinity, x2: -Infinity, y1: Infinity, y2: -Infinity }
    );
    const frames = sample.map((b) => Math.round(b.t * timeline.fps));
    const diffs = await captionDiff(input.videoPath, input.uncaptionedPath, frames, { x: region.x1, y: region.y1, w: Math.max(2, region.x2 - region.x1), h: Math.max(2, region.y2 - region.y1) }, timeline.fps);
    const ok = diffs.length === new Set(frames).size && diffs.every((d) => d >= 4);
    add('captions.burnedIn', 'captions', ok ? 'PASS' : 'FAIL', `caption-region luma difference vs uncaptioned render: ${diffs.map((d) => d.toFixed(1)).join(', ')} (${frames.length} sampled cues)`, { expected: '>= 4 at every sampled cue' });
  });

  return summarizeChecks(checks);
}
