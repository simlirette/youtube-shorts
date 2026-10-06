import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { InternalError, TimeoutError } from './errors.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  description?: string;
}

export function runProcess(bin: string, args: string[], opts: RunOptions = {}): Promise<ProcessResult> {
  const timeoutMs = opts.timeoutMs ?? getConfig().FFMPEG_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
      if (stdout.length > 20_000_000) stdout = stdout.slice(-10_000_000);
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
      if (stderr.length > 5_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new InternalError(`Failed to launch ${bin} (${opts.description ?? 'process'}): ${err.message}`, err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new TimeoutError(bin, `${opts.description ?? 'process'} exceeded ${timeoutMs} ms and was killed`));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Like runProcess but returns stdout as raw bytes (for rawvideo/PCM pipes). */
export function runProcessBuffer(bin: string, args: string[], opts: RunOptions = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? getConfig().FFMPEG_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c) => {
      stderr += c.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new InternalError(`Failed to launch ${bin}: ${err.message}`, err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new TimeoutError(bin, `${opts.description ?? 'process'} exceeded ${timeoutMs} ms`));
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

/** Last meaningful stderr lines, without the FFmpeg version banner. */
export function stderrTail(stderr: string, maxLines = 12): string {
  return stderr
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*(lib\w+|configuration:|built with|ffmpeg version|Copyright)/.test(l))
    .slice(-maxLines)
    .join('\n');
}

export async function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<ProcessResult> {
  const cfg = getConfig();
  const fullArgs = ['-hide_banner', '-nostdin', ...args];
  logger.debug(`ffmpeg ${opts.description ?? ''}`, { args: fullArgs.join(' ').slice(0, 2000) });
  const res = await runProcess(cfg.FFMPEG_PATH, fullArgs, opts);
  if (res.code !== 0) {
    throw new InternalError(`FFmpeg failed (${opts.description ?? 'ffmpeg'}), exit ${res.code}: ${stderrTail(res.stderr)}`);
  }
  return res;
}

// -----------------------------------------------------------------------------
// ffprobe
// -----------------------------------------------------------------------------

export interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
}

export interface ProbeResult {
  format: { format_name: string; duration?: string; size?: string; bit_rate?: string };
  streams: ProbeStream[];
}

export interface MediaSummary {
  formatName: string;
  sizeBytes: number;
  durationSeconds: number;
  videoStreams: number;
  audioStreams: number;
  video?: {
    codec: string;
    profile?: string;
    width: number;
    height: number;
    pixFmt?: string;
    fps: number;
    durationSeconds: number;
  };
  audio?: {
    codec: string;
    sampleRate: number;
    channels: number;
    durationSeconds: number;
  };
}

function parseRate(rate?: string): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? n / d : n;
}

/** Runs ffprobe; throws InvalidMedia-style InternalError when the file cannot be parsed at all. */
export async function probeMedia(filePath: string): Promise<ProbeResult> {
  if (!fs.existsSync(filePath)) throw new InternalError(`Media file not found: ${filePath}`);
  const cfg = getConfig();
  const res = await runProcess(
    cfg.FFPROBE_PATH,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: 60_000, description: 'ffprobe' }
  );
  if (res.code !== 0) throw new InternalError(`ffprobe cannot read ${filePath}: ${stderrTail(res.stderr, 4)}`);
  try {
    const parsed = JSON.parse(res.stdout) as ProbeResult;
    if (!parsed.format || !Array.isArray(parsed.streams)) throw new Error('missing format/streams');
    return parsed;
  } catch (e) {
    throw new InternalError(`ffprobe returned unparseable output for ${filePath}`, e);
  }
}

export async function summarizeMedia(filePath: string): Promise<MediaSummary> {
  const p = await probeMedia(filePath);
  const videos = p.streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audios = p.streams.filter((s) => s.codec_type === 'audio');
  const v = videos[0];
  const a = audios[0];
  const formatDuration = Number(p.format.duration ?? 0);
  return {
    formatName: p.format.format_name,
    sizeBytes: Number(p.format.size ?? fs.statSync(filePath).size),
    durationSeconds: Number.isFinite(formatDuration) ? formatDuration : 0,
    videoStreams: videos.length,
    audioStreams: audios.length,
    video: v
      ? {
          codec: v.codec_name ?? 'unknown',
          profile: v.profile,
          width: v.width ?? 0,
          height: v.height ?? 0,
          pixFmt: v.pix_fmt,
          fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
          durationSeconds: Number(v.duration ?? formatDuration ?? 0),
        }
      : undefined,
    audio: a
      ? {
          codec: a.codec_name ?? 'unknown',
          sampleRate: Number(a.sample_rate ?? 0),
          channels: a.channels ?? 0,
          durationSeconds: Number(a.duration ?? formatDuration ?? 0),
        }
      : undefined,
  };
}

// -----------------------------------------------------------------------------
// Audio analysis
// -----------------------------------------------------------------------------

export interface LoudnessResult {
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
}

export async function measureLoudness(filePath: string, streamSpec = 'a:0'): Promise<LoudnessResult> {
  const res = await runFfmpeg(['-nostats', '-i', filePath, '-map', `0:${streamSpec}`, '-af', 'ebur128=peak=true', '-f', 'null', '-'], {
    description: 'loudness measurement',
  });
  const summary = res.stderr.slice(res.stderr.lastIndexOf('Summary:'));
  const i = summary.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/);
  const lra = summary.match(/LRA:\s+(-?[\d.]+)\s+LU/);
  const peak = summary.match(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/);
  const toNum = (m: RegExpMatchArray | null) => (m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN);
  return { integratedLufs: toNum(i), truePeakDb: toNum(peak), lra: toNum(lra) };
}

export interface Interval {
  start: number;
  end: number;
  duration: number;
}

export async function detectSilence(filePath: string, noiseDb = -50, minDurationS = 0.5): Promise<Interval[]> {
  const res = await runFfmpeg(
    ['-nostats', '-i', filePath, '-map', '0:a:0', '-af', `silencedetect=n=${noiseDb}dB:d=${minDurationS}`, '-f', 'null', '-'],
    { description: 'silence detection' }
  );
  const intervals: Interval[] = [];
  let openStart: number | null = null;
  for (const line of res.stderr.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) openStart = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (e && openStart !== null) {
      intervals.push({ start: openStart, end: Number(e[1]), duration: Number(e[2]) });
      openStart = null;
    }
  }
  if (openStart !== null) {
    const total = (await summarizeMedia(filePath)).audio?.durationSeconds ?? openStart;
    intervals.push({ start: openStart, end: total, duration: Math.max(0, total - openStart) });
  }
  return intervals;
}

export async function volumeStats(filePath: string): Promise<{ meanDb: number; maxDb: number }> {
  const res = await runFfmpeg(['-nostats', '-i', filePath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], {
    description: 'volume detection',
  });
  const mean = res.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  const max = res.stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  const n = (m: RegExpMatchArray | null) => (m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : -Infinity);
  return { meanDb: n(mean), maxDb: n(max) };
}

/** Full decode of every stream; returns decoder error lines (empty array = clean). */
export async function decodeErrors(filePath: string): Promise<string[]> {
  const cfg = getConfig();
  const res = await runProcess(cfg.FFMPEG_PATH, ['-hide_banner', '-nostdin', '-v', 'error', '-i', filePath, '-f', 'null', '-'], {
    description: 'decode check',
  });
  const lines = res.stderr.split(/\r?\n/).filter((l) => l.trim());
  if (res.code !== 0 && lines.length === 0) lines.push(`ffmpeg exited with ${res.code}`);
  return lines;
}

export async function detectBlack(filePath: string, minDurationS = 0.5): Promise<Interval[]> {
  const res = await runFfmpeg(
    ['-nostats', '-i', filePath, '-map', '0:v:0', '-vf', `blackdetect=d=${minDurationS}:pic_th=0.98`, '-an', '-f', 'null', '-'],
    { description: 'black detection' }
  );
  const out: Interval[] = [];
  for (const m of res.stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    out.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
  }
  return out;
}

/**
 * Two-pass EBU R128 normalisation to a mono/stereo PCM WAV. Throws on failure — never silently
 * returns un-normalised audio.
 */
export async function loudnormToWav(
  input: string,
  output: string,
  opts: { targetLufs: number; truePeak?: number; lra?: number; sampleRate?: number; channels?: number }
): Promise<void> {
  const tp = opts.truePeak ?? -1.5;
  const lra = opts.lra ?? 11;
  const first = await runFfmpeg(
    ['-nostats', '-i', input, '-af', `loudnorm=I=${opts.targetLufs}:TP=${tp}:LRA=${lra}:print_format=json`, '-f', 'null', '-'],
    { description: 'loudnorm pass 1' }
  );
  const jsonStart = first.stderr.lastIndexOf('{');
  const jsonEnd = first.stderr.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new InternalError('loudnorm pass 1 produced no measurement');
  const m = JSON.parse(first.stderr.slice(jsonStart, jsonEnd + 1)) as Record<string, string>;
  const filter =
    `loudnorm=I=${opts.targetLufs}:TP=${tp}:LRA=${lra}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  await runFfmpeg(
    [
      '-y',
      '-i',
      input,
      '-af',
      filter,
      '-ar',
      String(opts.sampleRate ?? 48000),
      '-ac',
      String(opts.channels ?? 1),
      '-c:a',
      'pcm_s16le',
      output,
    ],
    { description: 'loudnorm pass 2' }
  );
}

/**
 * Short-window RMS envelope (dBFS, floored at -90) of the first audio stream, mixed to mono.
 * Used to prove the final mix carries the narration (not some other audio) without drift.
 */
export async function audioEnvelope(filePath: string, windowMs = 50): Promise<number[]> {
  const sampleRate = 8000;
  const n = Math.round((sampleRate * windowMs) / 1000);
  const cfg = getConfig();
  const res = await runProcess(
    cfg.FFMPEG_PATH,
    [
      '-hide_banner', '-nostdin', '-v', 'error', '-i', filePath, '-map', '0:a:0',
      '-af', `aresample=${sampleRate},aformat=channel_layouts=mono,asetnsamples=n=${n}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      '-f', 'null', '-',
    ],
    { description: 'audio envelope' }
  );
  if (res.code !== 0) throw new InternalError(`audio envelope failed for ${filePath}: ${stderrTail(res.stderr, 4)}`);
  const values: number[] = [];
  for (const m of res.stdout.matchAll(/RMS_level=(-?[\d.]+|-?inf)/g)) {
    const v = m[1].includes('inf') ? -90 : Number(m[1]);
    values.push(Math.max(-90, v));
  }
  return values;
}

/** Pearson correlation of two equal-length series (0 when degenerate). */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
