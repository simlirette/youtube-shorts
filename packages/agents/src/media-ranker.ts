import type { AssetCandidate, AssetRanking } from '@shorts/schemas';
import { significantTokens } from '@shorts/core';

export interface RankContext {
  keywords: string[];
  /** Imagery the scene must not show; a candidate whose tags contain an exclusion is rejected. */
  exclusions?: string[];
  sceneDurationSeconds: number;
  usedMediaKeys: Set<string>;
  minRelevance: number;
  maxBytes: number;
}

export type RankOutcome = { ok: true; ranking: AssetRanking } | { ok: false; reason: string };

export const mediaKey = (c: { provider: string; providerMediaId: string }) => `${c.provider}:${c.providerMediaId}`;

/** Fraction of keyword phrases (partially) present in the candidate's tags/description. */
export function relevanceScore(keywords: string[], c: AssetCandidate): { relevance: number; matched: string[] } {
  const bag = new Set(significantTokens(`${c.tags.join(' ')} ${c.description}`));
  const phrases = keywords
    .map((k, i) => ({ kw: k, tokens: significantTokens(k), weight: i === 0 ? 2 : 1 }))
    .filter((p) => p.tokens.length > 0);
  if (phrases.length === 0) return { relevance: 0, matched: [] };
  const matched: string[] = [];
  let sum = 0;
  let weights = 0;
  // The first keyword is the scene's primary visual subject and counts double.
  for (const p of phrases) {
    const hit = p.tokens.filter((t) => bag.has(t)).length / p.tokens.length;
    sum += hit * p.weight;
    weights += p.weight;
    if (hit > 0) matched.push(p.kw);
  }
  return { relevance: sum / weights, matched };
}

/**
 * Scores a candidate against the scene's real requirements. Hard rejections: duplicates, low
 * relevance, insufficient resolution, oversize files. Portrait footage is preferred for Shorts.
 */
/** Production assets (keying plates, overlays, templates) are never usable as finished footage. */
const PRODUCTION_ASSET = /\b(green ?screen|blue ?screen|chroma ?key|chroma|alpha( channel)?|transparent|overlay|mock-?up|template|lower third|logo|intro|outro|watermark|placeholder|luma matte)\b/i;

export function rankCandidate(c: AssetCandidate, ctx: RankContext): RankOutcome {
  if (ctx.usedMediaKeys.has(mediaKey(c))) return { ok: false, reason: 'already used in this Short' };
  const prod = `${c.tags.join(', ')} ${c.description}`.match(PRODUCTION_ASSET);
  if (prod) return { ok: false, reason: `production asset (${prod[0]}), not finished footage` };
  if (ctx.exclusions?.length) {
    const bag = new Set(significantTokens(`${c.tags.join(' ')} ${c.description}`));
    const hit = ctx.exclusions.find((ex) => {
      const t = significantTokens(ex);
      return t.length > 0 && t.every((x) => bag.has(x));
    });
    if (hit) return { ok: false, reason: `matches scene exclusion "${hit}"` };
  }
  if (c.fileSizeBytes && c.fileSizeBytes > ctx.maxBytes) return { ok: false, reason: `file too large (${c.fileSizeBytes} bytes)` };

  const { relevance, matched } = relevanceScore(ctx.keywords, c);
  if (relevance < ctx.minRelevance) return { ok: false, reason: `relevance ${relevance.toFixed(2)} < ${ctx.minRelevance}` };

  const reasons: string[] = [];
  const ar = c.width / c.height;
  const portrait = ar <= 0.8;
  let orientation: number;
  if (ar <= 0.6) orientation = 1;
  else if (ar <= 0.8) orientation = 0.8;
  else if (ar <= 1.05) orientation = 0.45;
  else orientation = 0.3;
  if (!portrait) reasons.push('landscape/square: cropped to fill the vertical frame');

  let resolution: number;
  if (portrait) {
    if (c.width >= 1080) resolution = 1;
    else if (c.width >= 720) resolution = 0.6;
    else return { ok: false, reason: `portrait width ${c.width} < 720` };
  } else {
    // Landscape clips are cropped to fill 9:16, so their height decides the output sharpness
    // (≥ 960 px keeps the upscale ≤ 2×; below that the shot would have to be letterboxed).
    if (c.width < 1080) return { ok: false, reason: `landscape width ${c.width} < 1080` };
    if (c.height >= 1920) resolution = 1;
    else if (c.height >= 1080) resolution = 0.8;
    else if (c.height >= 960) resolution = 0.6;
    else {
      resolution = 0.25;
      reasons.push('low height: would be letterboxed instead of filling the frame');
    }
  }

  let duration: number;
  if (c.mediaType === 'IMAGE') {
    duration = 0.6;
    reasons.push('still image: animated with slow zoom');
  } else if (!c.durationSeconds) {
    return { ok: false, reason: 'video has no duration metadata' };
  } else if (c.durationSeconds >= ctx.sceneDurationSeconds) {
    duration = 1;
  } else if (c.durationSeconds >= ctx.sceneDurationSeconds * 0.6) {
    duration = 0.6;
    reasons.push('shorter than scene: will loop once');
  } else {
    duration = 0.2;
    reasons.push('much shorter than scene: will loop');
  }

  const score = 0.5 * relevance + 0.2 * orientation + 0.15 * resolution + 0.15 * duration;
  return { ok: true, ranking: { score: Math.round(score * 1000) / 1000, relevance: Math.round(relevance * 1000) / 1000, matchedTerms: matched, orientation, resolution, duration, reasons } };
}
