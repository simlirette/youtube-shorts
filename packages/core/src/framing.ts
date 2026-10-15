/**
 * Full-bleed 9:16 framing. Landscape footage is cropped to fill the vertical frame, with the crop
 * window placed where the picture's visual detail is (column gradient energy), and a restrained
 * pan when the subject moves. Letterboxing is used only when the crop would upscale too much or
 * discard almost the whole picture. Pure and deterministic: same frames, same decision.
 */

export interface FramingDecision {
  mode: 'cover' | 'crop_pan' | 'letterbox';
  /** Horizontal center (0-1 of source width) of the crop window at the start and end of the shot. */
  centerStart: number;
  centerEnd: number;
  /** Source-to-output scale factor (> 1 = upscaling). */
  upscale: number;
  /** Fraction of the source width kept by the crop (1 for cover/letterbox). */
  keepFraction: number;
  reason: string;
}

export interface FramingOptions {
  outWidth: number;
  outHeight: number;
  /** Largest acceptable upscale for a crop; above it the shot is letterboxed instead. */
  maxUpscale: number;
  /** Below this kept fraction the crop would destroy the picture (ultra-wide) → letterbox. */
  minKeepFraction?: number;
  /** Largest pan, as a fraction of the source width, over one shot. */
  maxPan?: number;
}

/** Per-column visual detail (sum of absolute luma gradients) of an RGB24 frame. */
export function columnEnergy(rgb: Buffer, w: number, h: number): Float64Array {
  const luma = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) luma[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  const e = new Float64Array(w);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      e[x] += Math.abs(luma[i + 1] - luma[i - 1]) + Math.abs(luma[i + w] - luma[i - w]);
    }
  }
  return e;
}

/** Center (0-1) of the window of `keep` width with the most detail; ties go to the frame center. */
export function bestWindowCenter(energy: Float64Array, keep: number): number {
  const w = energy.length;
  const win = Math.max(1, Math.min(w, Math.round(w * keep)));
  const prefix = new Float64Array(w + 1);
  for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x] + energy[x];
  const total = prefix[w] || 1;
  let best = -Infinity;
  let bestStart = Math.round((w - win) / 2);
  for (let s = 0; s + win <= w; s++) {
    const center = (s + win / 2) / w;
    // Detail share, with a small pull toward the middle so flat pictures stay centered.
    const score = (prefix[s + win] - prefix[s]) / total - 0.02 * Math.abs(center - 0.5);
    if (score > best + 1e-9) {
      best = score;
      bestStart = s;
    }
  }
  return (bestStart + win / 2) / w;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function chooseFraming(
  src: { width: number; height: number },
  frames: Array<{ rgb: Buffer; w: number; h: number }>,
  opts: FramingOptions
): FramingDecision {
  const outAr = opts.outWidth / opts.outHeight;
  const srcAr = src.width / src.height;
  if (srcAr <= outAr * 1.02) {
    const upscale = Math.max(opts.outWidth / src.width, opts.outHeight / src.height);
    return { mode: 'cover', centerStart: 0.5, centerEnd: 0.5, upscale: r3(upscale), keepFraction: 1, reason: 'portrait source fills the frame' };
  }
  const keep = (src.height * outAr) / src.width;
  const upscale = opts.outHeight / src.height;
  const letterboxUpscale = r3(opts.outWidth / src.width);
  if (upscale > opts.maxUpscale) {
    return { mode: 'letterbox', centerStart: 0.5, centerEnd: 0.5, upscale: letterboxUpscale, keepFraction: 1, reason: `cropping would upscale ${upscale.toFixed(2)}× (max ${opts.maxUpscale}×)` };
  }
  if (keep < (opts.minKeepFraction ?? 0.25)) {
    return { mode: 'letterbox', centerStart: 0.5, centerEnd: 0.5, upscale: letterboxUpscale, keepFraction: 1, reason: `ultra-wide source: a crop would keep only ${(keep * 100).toFixed(0)}% of the picture` };
  }
  const lo = keep / 2;
  const hi = 1 - keep / 2;
  const centers = frames.map((f) => clamp(bestWindowCenter(columnEnergy(f.rgb, f.w, f.h), keep), lo, hi));
  if (centers.length === 0) return { mode: 'crop_pan', centerStart: 0.5, centerEnd: 0.5, upscale: r3(upscale), keepFraction: r3(keep), reason: 'no frames analysed: centered crop' };
  // Start/end from the first and last thirds of the sampled frames; small moves become a static crop.
  const head = centers.slice(0, Math.max(1, Math.ceil(centers.length / 3)));
  const tail = centers.slice(-Math.max(1, Math.ceil(centers.length / 3)));
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let start = avg(head);
  let end = avg(tail);
  if (Math.abs(end - start) < 0.04) start = end = avg(centers);
  const maxPan = opts.maxPan ?? 0.25;
  if (Math.abs(end - start) > maxPan) end = start + Math.sign(end - start) * maxPan;
  return {
    mode: 'crop_pan',
    centerStart: r3(clamp(start, lo, hi)),
    centerEnd: r3(clamp(end, lo, hi)),
    upscale: r3(upscale),
    keepFraction: r3(keep),
    reason: start === end ? 'static crop on the most detailed region' : 'crop follows the moving subject (restrained pan)',
  };
}

/** Crop x offset (0-1 of the scaled width minus crop width) for a window center. */
export function cropOffsetFraction(center: number, keepFraction: number): number {
  if (keepFraction >= 1) return 0.5;
  return clamp((center - keepFraction / 2) / (1 - keepFraction), 0, 1);
}
