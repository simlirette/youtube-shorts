/**
 * Deterministic frame-level checks for stock media and rendered output.
 * Thresholds are deliberately conservative: they target unusable footage (black/blank frames,
 * chroma-key plates, baked-in letterbox bars, static placeholders), not artistic choices.
 */

export interface FrameMetrics {
  t: number;
  /** Mean Rec.601 luma, 0-255. */
  meanLuma: number;
  /** Luma standard deviation; near zero means a flat/blank frame. */
  stdLuma: number;
  /** Fraction of pixels that look like a chroma-key green screen. */
  greenFraction: number;
  /** Fraction of frame height (or width) occupied by uniform dark bars at the edges. */
  barFraction: number;
}

export const FRAME_THRESHOLDS = {
  blackMeanLuma: 18,
  blankStdLuma: 6,
  /**
   * Mean luma gradient below which a frame shows no subject (an empty backdrop or a smooth gradient
   * still has luma variance, so blankStdLuma misses it). Live calibration on 47 accepted stock
   * clips: empty grey backdrop 0.6; lowest real footage (dark tunnel) 1.6; typical 10-40.
   */
  featurelessDetail: 1.0,
  chromaGreenFraction: 0.3,
  letterboxBarFraction: 0.2,
  staticMeanAbsDiff: 0.6,
};

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Rows (or columns) from an edge that are uniformly dark. */
function darkRun(rgb: Buffer, w: number, h: number, axis: 'row' | 'col', fromEnd: boolean): number {
  const len = axis === 'row' ? h : w;
  let run = 0;
  for (let k = 0; k < len; k++) {
    const idx = fromEnd ? len - 1 - k : k;
    let sum = 0;
    let max = 0;
    const n = axis === 'row' ? w : h;
    for (let j = 0; j < n; j++) {
      const p = axis === 'row' ? (idx * w + j) * 3 : (j * w + idx) * 3;
      const y = luma(rgb[p], rgb[p + 1], rgb[p + 2]);
      sum += y;
      if (y > max) max = y;
    }
    if (sum / n < 20 && max < 40) run++;
    else break;
  }
  return run;
}

export function analyzeFrame(rgb: Buffer, w: number, h: number, t: number): FrameMetrics {
  const n = w * h;
  let sum = 0;
  let sumSq = 0;
  let green = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const y = luma(r, g, b);
    sum += y;
    sumSq += y * y;
    if (g > 90 && g > 1.4 * r && g > 1.4 * b) green++;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const top = darkRun(rgb, w, h, 'row', false);
  const bottom = darkRun(rgb, w, h, 'row', true);
  const left = darkRun(rgb, w, h, 'col', false);
  const right = darkRun(rgb, w, h, 'col', true);
  // Bars only count when present on both opposite edges (a dark sky or floor is one-sided).
  const vertical = top > 0 && bottom > 0 ? (top + bottom) / h : 0;
  const horizontal = left > 0 && right > 0 ? (left + right) / w : 0;
  const barFraction = mean < FRAME_THRESHOLDS.blackMeanLuma ? 0 : Math.max(vertical, horizontal);
  return { t, meanLuma: round(mean), stdLuma: round(std), greenFraction: round(green / n), barFraction: round(barFraction) };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function meanAbsDiff(a: Buffer, b: Buffer): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 3) s += Math.abs(luma(a[i], a[i + 1], a[i + 2]) - luma(b[i], b[i + 1], b[i + 2]));
  return s / (a.length / 3);
}

/** Converts frame metrics into publication-blocking defect labels. */
export function frameDefects(metrics: FrameMetrics[], frames: Buffer[], isVideo: boolean): string[] {
  const d: string[] = [];
  const T = FRAME_THRESHOLDS;
  const black = metrics.filter((m) => m.meanLuma < T.blackMeanLuma);
  if (black.length) d.push(`black/near-black frame(s) at ${black.map((m) => `${m.t.toFixed(1)}s`).join(', ')}`);
  const blank = metrics.filter((m) => m.meanLuma >= T.blackMeanLuma && m.stdLuma < T.blankStdLuma);
  if (blank.length) d.push(`blank/flat frame(s) at ${blank.map((m) => `${m.t.toFixed(1)}s`).join(', ')}`);
  const chroma = metrics.filter((m) => m.greenFraction > T.chromaGreenFraction);
  if (chroma.length >= Math.min(2, metrics.length)) d.push(`chroma-key green screen (${Math.round(Math.max(...chroma.map((m) => m.greenFraction)) * 100)}% of frame)`);
  const bars = metrics.filter((m) => m.barFraction > T.letterboxBarFraction);
  if (bars.length >= Math.min(2, metrics.length)) d.push(`baked-in letterbox/pillarbox bars (${Math.round(Math.max(...bars.map((m) => m.barFraction)) * 100)}% of frame)`);
  if (isVideo && frames.length >= 2) {
    let maxDiff = 0;
    for (let i = 1; i < frames.length; i++) maxDiff = Math.max(maxDiff, meanAbsDiff(frames[i - 1], frames[i]));
    if (maxDiff < T.staticMeanAbsDiff) d.push(`static picture: video does not change across samples (max diff ${maxDiff.toFixed(2)})`);
  }
  return d;
}

/** Sample points at 10/30/50/70/90 % of a clip (single frame for stills). */
export function samplePoints(durationSeconds: number, isVideo: boolean): number[] {
  if (!isVideo || durationSeconds <= 0) return [0];
  return [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.round(f * durationSeconds * 1000) / 1000);
}

/** Small analysis box that preserves the source aspect ratio (so bars stay detectable). */
/** Mean absolute horizontal + vertical luma difference between neighbouring pixels (RGB24 frame). */
export function edgeDetail(rgb: Buffer, w: number, h: number): number {
  const L = (i: number) => 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  let s = 0;
  let n = 0;
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = L(i);
      s += Math.abs(v - L(i - 3)) + Math.abs(v - L(i - w * 3));
      n++;
    }
  }
  return n ? Math.round((s / n) * 100) / 100 : 0;
}

export function analysisBox(width: number, height: number): { w: number; h: number } {
  const w = 160;
  const h = Math.max(2, Math.round((160 * height) / width / 2) * 2);
  return { w, h };
}
