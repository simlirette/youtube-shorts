import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AssetCandidate,
  AssetDescriptor,
  AssetDescriptorSchema,
  AssetRanking,
  MediaProbe,
  ShortScript,
  Timeline,
} from '@shorts/schemas';
import type { AssetProvider } from '@shorts/providers';
import { PipelineError, ValidationError, decodeErrors, detectBlack, logger, sanitizeSegment, sha256File, summarizeMedia } from '@shorts/core';
import { mediaKey, rankCandidate } from './media-ranker.js';

/** Bump when validation rules change so cached media is re-validated. */
const VALIDATION_VERSION = 2;

const VIDEO_CODECS = new Set(['h264', 'hevc', 'vp9', 'av1', 'mpeg4', 'vp8']);
const IMAGE_CODECS = new Set(['mjpeg', 'png', 'webp']);

/**
 * Suggests alternative, simpler stock-search keywords for a scene whose original keywords found no
 * usable media. Returned keywords are used both for searching and for relevance scoring.
 */
export type KeywordRefiner = (scene: { narration: string; visualObjective: string; failedKeywords: string[] }) => Promise<string[]>;

/**
 * Semantic fit check: given a scene and candidate descriptions (tags), returns the keys of candidates
 * whose content plausibly shows what the scene describes. Rejects tag coincidences (e.g. a wedding
 * for "celebration" in a scene about disease).
 */
export type VisualFitJudge = (
  scene: { narration: string; visualObjective: string },
  candidates: Array<{ key: string; mediaType: string; tags: string[]; description: string }>
) => Promise<Set<string>>;

export interface VisualOptions {
  mediaCacheDir: string;
  minRelevance: number;
  maxDownloadBytes: number;
  /** Candidates to try downloading per scene before giving up on a media type. */
  maxDownloadAttemptsPerScene?: number;
}

export interface MediaValidation {
  ok: boolean;
  probe?: MediaProbe;
  problems: string[];
}

/** ffprobe + full decode validation. Never trusts extensions or provider metadata. */
export async function validateMediaFile(filePath: string, expected: AssetCandidate): Promise<MediaValidation> {
  const problems: string[] = [];
  let summary;
  try {
    summary = await summarizeMedia(filePath);
  } catch (e) {
    return { ok: false, problems: [`unreadable media: ${(e as Error).message}`] };
  }
  const v = summary.video;
  if (!v) return { ok: false, problems: ['no video/image stream'] };
  const allowed = expected.mediaType === 'VIDEO' ? VIDEO_CODECS : IMAGE_CODECS;
  if (!allowed.has(v.codec)) problems.push(`unsupported codec ${v.codec} for ${expected.mediaType}`);
  if (v.width < 540 || v.height < 540) problems.push(`resolution too small (${v.width}x${v.height})`);
  if (Math.abs(v.width / v.height - expected.width / expected.height) > 0.05) {
    problems.push(`aspect ratio ${v.width}x${v.height} differs from provider metadata ${expected.width}x${expected.height}`);
  }
  const duration = expected.mediaType === 'VIDEO' ? v.durationSeconds || summary.durationSeconds : 0;
  if (expected.mediaType === 'VIDEO' && !(duration >= 1)) problems.push(`invalid duration ${duration}`);
  if (problems.length === 0) {
    const errs = await decodeErrors(filePath);
    if (errs.length > 0) problems.push(`decode errors: ${errs.slice(0, 3).join(' | ')}`);
  }
  if (problems.length === 0 && expected.mediaType === 'VIDEO') {
    // Fades/black leaders would show up as black gaps in the Short (and fail media QA).
    const black = await detectBlack(filePath, 0.25);
    if (black.length > 0) problems.push(`contains black segment(s) at ${black.map((b) => `${b.start.toFixed(1)}-${b.end.toFixed(1)}s`).join(', ')}`);
  }
  return {
    ok: problems.length === 0,
    probe: {
      formatName: summary.formatName,
      videoCodec: v.codec,
      width: v.width,
      height: v.height,
      durationSeconds: duration,
      hasAudio: summary.audioStreams > 0,
      sizeBytes: summary.sizeBytes,
    },
    problems,
  };
}

export class VisualDirectorAgent {
  constructor(private readonly provider: AssetProvider, private readonly opts: VisualOptions, private readonly refine?: KeywordRefiner, private readonly judge?: VisualFitJudge) {}

  /**
   * One distinct validated asset per timeline shot, sized to the shot's real duration.
   * Shots are a pacing target: if a later shot of a scene cannot get a suitable distinct asset, it is
   * merged into the previous shot of the same scene (that clip holds longer). A scene with no
   * suitable media at all still fails. Returns the (possibly merged) shot list that was fulfilled.
   */
  async collectAssets(
    script: ShortScript,
    timeline: Timeline,
    mediaDir: string,
    onAsset?: (a: AssetDescriptor) => Promise<void>
  ): Promise<{ assets: AssetDescriptor[]; shots: Timeline['shots'] }> {
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.mkdirSync(this.opts.mediaCacheDir, { recursive: true });
    const used = new Set<string>();
    const out: AssetDescriptor[] = [];
    const shots: Timeline['shots'] = [];
    const refined = new Map<number, string[]>();
    for (const shot of timeline.shots) {
      const scene = script.scenes.find((s) => s.sceneNumber === shot.sceneNumber);
      if (!scene) throw new ValidationError(`Timeline shot references unknown scene ${shot.sceneNumber}`);
      const duration = shot.end - shot.start;
      let asset: AssetDescriptor;
      try {
        try {
          asset = await this.sourceScene(scene.sceneNumber, shot.shotIndex, refined.get(scene.sceneNumber) ?? scene.assetKeywords, duration, used, mediaDir, scene);
        } catch (err) {
          // One bounded refinement per scene: ask for simpler keywords, then retry once.
          if (!(err instanceof ValidationError) || !this.refine || refined.has(scene.sceneNumber)) throw err;
          const alt = (await this.refine({ narration: scene.narration, visualObjective: scene.visualObjective, failedKeywords: scene.assetKeywords }))
            .map((k) => k.trim().toLowerCase())
            .filter((k) => k && !/\d/.test(k));
          if (alt.length === 0) throw err;
          refined.set(scene.sceneNumber, alt);
          logger.info(`Scene ${scene.sceneNumber}: no usable media for [${scene.assetKeywords.join(', ')}]; retrying with refined keywords [${alt.join(', ')}]`, { stage: 'MEDIA' });
          asset = await this.sourceScene(scene.sceneNumber, shot.shotIndex, alt, duration, used, mediaDir, scene);
        }
      } catch (err) {
        const prev = shots[shots.length - 1];
        if (err instanceof ValidationError && prev && prev.sceneNumber === shot.sceneNumber) {
          logger.warn(`Scene ${shot.sceneNumber} shot ${shot.shotIndex}: no further suitable distinct media; extending the previous shot instead`, { stage: 'MEDIA' });
          prev.end = shot.end;
          continue;
        }
        throw err;
      }
      used.add(`${asset.provider}:${asset.providerAssetId}`);
      out.push(asset);
      shots.push({ ...shot });
      await onAsset?.(asset);
    }
    return { assets: out, shots };
  }

  private queries(keywords: string[]): string[] {
    const qs = [keywords.slice(0, 2).join(' '), ...keywords];
    return [...new Set(qs.map((q) => q.trim()).filter(Boolean))];
  }

  private async sourceScene(sceneNumber: number, shotIndex: number, keywords: string[], sceneDuration: number, used: Set<string>, mediaDir: string, scene: { narration: string; visualObjective: string }): Promise<AssetDescriptor> {
    const rejections: string[] = [];
    for (const mediaType of ['VIDEO', 'IMAGE'] as const) {
      const ranked = new Map<string, { c: AssetCandidate; r: AssetRanking }>();
      for (const q of this.queries(keywords)) {
        const results = await this.provider.search({ query: q, mediaType, perPage: 30 });
        for (const c of results) {
          const outcome = rankCandidate(c, { keywords, sceneDurationSeconds: sceneDuration, usedMediaKeys: used, minRelevance: this.opts.minRelevance, maxBytes: this.opts.maxDownloadBytes });
          if (!outcome.ok) continue;
          const k = mediaKey(c);
          if (!ranked.has(k) || ranked.get(k)!.r.score < outcome.ranking.score) ranked.set(k, { c, r: outcome.ranking });
        }
        if ([...ranked.values()].filter((x) => x.r.score >= 0.75).length >= 3) break;
      }
      let ordered = [...ranked.values()].sort((a, b) => b.r.score - a.r.score).slice(0, 8);
      if (this.judge && ordered.length > 0) {
        const fit = await this.judge(scene, ordered.map(({ c }) => ({ key: mediaKey(c), mediaType: c.mediaType, tags: c.tags, description: c.description })));
        const rejected = ordered.filter(({ c }) => !fit.has(mediaKey(c)));
        if (rejected.length) rejections.push(`visual-fit judge rejected ${rejected.map(({ c }) => mediaKey(c)).join(', ')}`);
        ordered = ordered.filter(({ c }) => fit.has(mediaKey(c)));
      }
      for (const { c, r } of ordered.slice(0, this.opts.maxDownloadAttemptsPerScene ?? 4)) {
        try {
          const asset = await this.acquire(c, r, sceneNumber, shotIndex, mediaDir);
          if (asset) {
            logger.info(`Scene ${sceneNumber}.${shotIndex}: selected ${c.provider} ${c.mediaType.toLowerCase()} ${c.providerMediaId} (${c.width}x${c.height}, score ${r.score}, matched: ${r.matchedTerms.join(', ') || '—'})`, { stage: 'MEDIA' });
            return asset;
          }
          rejections.push(`${mediaKey(c)}: failed validation`);
        } catch (err) {
          // Authentication/configuration problems are not candidate-specific: stop immediately.
          if (err instanceof PipelineError && (err.kind === 'AUTHENTICATION' || err.kind === 'CONFIGURATION')) throw err;
          rejections.push(`${mediaKey(c)}: ${(err as Error).message}`);
        }
      }
      if (ordered.length === 0) rejections.push(`no ${mediaType.toLowerCase()} candidates met relevance/resolution requirements for [${keywords.join(', ')}]`);
    }
    throw new ValidationError(`No suitable media for scene ${sceneNumber} shot ${shotIndex}`, rejections.slice(0, 8));
  }

  private async acquire(c: AssetCandidate, ranking: AssetRanking, sceneNumber: number, shotIndex: number, mediaDir: string): Promise<AssetDescriptor | null> {
    const ext = c.mediaType === 'VIDEO' ? 'mp4' : path.extname(new URL(c.downloadUrl).pathname).replace('.', '') || 'jpg';
    const base = sanitizeSegment(`${c.provider}_${c.providerMediaId}_${c.width}x${c.height}`);
    const cachePath = path.join(this.opts.mediaCacheDir, `${base}.${sanitizeSegment(ext, 5)}`);
    const sidecar = `${cachePath}.valid.json`;

    let probe: MediaProbe | undefined;
    let sha: string | undefined;
    if (fs.existsSync(cachePath) && fs.existsSync(sidecar)) {
      const meta = JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as { v?: number; sha256: string; probe: MediaProbe };
      if (meta.v === VALIDATION_VERSION && (await sha256File(cachePath)) === meta.sha256) {
        probe = meta.probe;
        sha = meta.sha256;
        logger.debug(`Media cache hit ${base}`, { stage: 'MEDIA' });
      }
    }
    if (!probe) {
      const dl = fs.existsSync(cachePath)
        ? { sha256: await sha256File(cachePath) } // already downloaded; re-validate under current rules
        : await this.provider.download(c, cachePath);
      const validation = await validateMediaFile(cachePath, c);
      if (!validation.ok || !validation.probe) {
        logger.warn(`Rejected downloaded media ${base}: ${validation.problems.join('; ')}`, { stage: 'MEDIA' });
        fs.rmSync(cachePath, { force: true });
        fs.rmSync(sidecar, { force: true });
        return null;
      }
      probe = validation.probe;
      sha = dl.sha256;
      fs.writeFileSync(sidecar, JSON.stringify({ v: VALIDATION_VERSION, sha256: sha, probe }));
    }

    // Job-local reference (hard link when possible, so the job directory is self-contained).
    const local = path.join(mediaDir, `scene_${sceneNumber}_${shotIndex}_${base}.${sanitizeSegment(ext, 5)}`);
    if (!fs.existsSync(local)) {
      try {
        fs.linkSync(cachePath, local);
      } catch {
        fs.copyFileSync(cachePath, local);
      }
    }

    return AssetDescriptorSchema.parse({
      id: randomUUID(),
      assetType: c.mediaType,
      provider: c.provider,
      providerAssetId: c.providerMediaId,
      sourceUrl: c.downloadUrl,
      pageUrl: c.pageUrl,
      license: c.license,
      licenseVerified: c.license.length > 0 && c.commercialUseAllowed,
      commercialUseAllowed: c.commercialUseAllowed,
      attributionRequired: c.attributionRequired,
      width: probe.width,
      height: probe.height,
      localPath: local,
      sha256: sha!,
      sceneNumber,
      shotIndex,
      probe,
      ranking,
      retrievedAt: new Date().toISOString(),
      metadata: { tags: c.tags, author: c.author, previewUrl: c.previewUrl },
    });
  }
}
