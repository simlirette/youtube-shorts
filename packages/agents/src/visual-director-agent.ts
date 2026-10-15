import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import {
  PipelineError,
  ValidationError,
  decodeErrors,
  detectBlack,
  extractRgbFrames,
  logger,
  sanitizeSegment,
  sha256File,
  summarizeMedia,
  writeContactSheet,
  analysisBox,
  analyzeFrame,
  frameDefects,
  samplePoints,
  significantTokens,
  chooseFraming,
  cropOffsetFraction,
  edgeDetail,
  FRAME_THRESHOLDS,
  type FramingDecision,
} from '@shorts/core';
import type { FrameMetrics } from '@shorts/core';
import { mediaKey, rankCandidate } from './media-ranker.js';
import { validateGraphic, type GraphicRenderer } from './graphics.js';

/** Bump when validation rules change so cached media is re-validated. */
const VALIDATION_VERSION = 3;

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
  scene: SceneVisualBrief,
  candidates: Array<{ key: string; mediaType: string; tags: string[]; description: string }>
) => Promise<Set<string>>;

/** What a scene needs to show, used for exclusions and the semantic (vision) check. */
export interface SceneVisualBrief {
  narration: string;
  visualObjective: string;
  visualSubject: string;
  visualExclusions: string[];
}

export interface SemanticVerdict {
  verdict: 'ACCEPT' | 'REJECT' | 'UNSURE';
  showsSubject: boolean;
  issues: string[];
  reason: string;
  model: string;
}

/** Semantic check of a downloaded candidate from a contact sheet of real frames (vision model). */
export type VisionJudge = (scene: SceneVisualBrief, contactSheetJpeg: Buffer) => Promise<SemanticVerdict>;

export interface VisualOptions {
  mediaCacheDir: string;
  minRelevance: number;
  maxDownloadBytes: number;
  /** Candidates to try downloading per scene before giving up on a media type. */
  maxDownloadAttemptsPerScene?: number;
  /** Upper bound on vision checks per shot (cost control). */
  maxVisionChecksPerShot?: number;
  /** Clips that must not be selected (rejected by a reviewer), as "provider:id". */
  excludeMediaKeys?: string[];
  /** Largest upscale accepted for a full-bleed crop (else the shot is letterboxed). */
  maxUpscale?: number;
  /** Renders beats that carry a graphic spec (Blender). Without it, such beats use stock footage. */
  graphics?: GraphicRenderer;
}

export interface FrameInspection {
  frames: FrameMetrics[];
  defects: string[];
}

/** Samples frames across the clip and applies the deterministic frame checks. */
export async function inspectFrames(filePath: string, probe: MediaProbe, isVideo: boolean): Promise<FrameInspection> {
  const box = analysisBox(probe.width, probe.height);
  const times = samplePoints(probe.durationSeconds, isVideo);
  const rgb = await extractRgbFrames(filePath, times, box.w, box.h);
  const frames = rgb.map((buf, i) => analyzeFrame(buf, box.w, box.h, times[i]));
  return { frames, defects: frameDefects(frames, rgb, isVideo) };
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
  constructor(
    private readonly provider: AssetProvider,
    private readonly opts: VisualOptions,
    private readonly refine?: KeywordRefiner,
    private readonly judge?: VisualFitJudge,
    private readonly vision?: VisionJudge
  ) {}

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
    const used = new Set<string>(this.opts.excludeMediaKeys ?? []);
    const out: AssetDescriptor[] = [];
    const shots: Timeline['shots'] = [];
    // Refinements are remembered per visual unit: a beat ("scene.beat") or a whole scene ("scene").
    const refined = new Map<string, string[]>();
    const reviewNotes = new Map<string, string>(); // asset id → why it needs a human look
    for (const shot of timeline.shots) {
      const scene = script.scenes.find((s) => s.sceneNumber === shot.sceneNumber);
      if (!scene) throw new ValidationError(`Timeline shot references unknown scene ${shot.sceneNumber}`);
      const sceneBrief: SceneVisualBrief = {
        narration: scene.narration,
        visualObjective: scene.visualObjective,
        visualSubject: scene.visualSubject || scene.assetKeywords[0] || scene.visualObjective,
        visualExclusions: scene.visualExclusions ?? [],
      };
      // Clause-level beat (when the script has beats): its own literal subject, keywords and exclusions.
      const beat = shot.beatIndex !== undefined ? scene.beats?.[shot.beatIndex] : undefined;
      const unitKey = beat ? `${scene.sceneNumber}.${shot.beatIndex}` : `${scene.sceneNumber}`;
      const unitKeywords = beat ? [...new Set([beat.visualSubject, ...beat.assetKeywords].map((k) => k.trim().toLowerCase()).filter(Boolean))] : scene.assetKeywords;
      const brief: SceneVisualBrief = beat
        ? { narration: beat.text, visualObjective: beat.visualIntent || scene.visualObjective, visualSubject: beat.visualSubject, visualExclusions: beat.visualExclusions ?? [] }
        : sceneBrief;
      const duration = shot.end - shot.start;
      // Generated graphic for this clause: rendered locally, never searched or sent to a vision model.
      if (beat?.graphic && this.opts.graphics) {
        const g = await this.graphicAsset(scene.sceneNumber, scene.narration, shot.shotIndex, beat.text, beat.graphic, duration, mediaDir);
        used.add(`${g.provider}:${g.providerAssetId}`);
        out.push(g);
        shots.push({ ...shot });
        await onAsset?.(g);
        continue;
      }
      let asset: AssetDescriptor;
      // The subject the judges check must follow the keywords being searched, or a refinement can
      // never succeed (live: refined keywords were still judged against "airplane with clouds").
      const briefFor = (kw: string[]): SceneVisualBrief => (kw === unitKeywords ? brief : { ...brief, visualSubject: kw[0] });
      try {
        const current = refined.get(unitKey) ?? unitKeywords;
        try {
          asset = await this.sourceScene(scene.sceneNumber, shot.shotIndex, current, duration, used, mediaDir, briefFor(current));
        } catch (err) {
          if (!(err instanceof ValidationError) || refined.has(unitKey)) throw err;
          // Tier 2: one model refinement (simpler keywords + subject) for this clause.
          let lastErr: unknown = err;
          const alt = this.refine
            ? (await this.refine({ narration: brief.narration, visualObjective: brief.visualObjective, failedKeywords: unitKeywords }))
                .map((k) => k.trim().toLowerCase())
                .filter((k) => k && !/\d/.test(k))
            : [];
          if (alt.length) {
            refined.set(unitKey, alt);
            logger.info(`Scene ${unitKey}: no usable media for [${unitKeywords.join(', ')}]; retrying with refined keywords [${alt.join(', ')}]`, { stage: 'MEDIA' });
            try {
              asset = await this.sourceScene(scene.sceneNumber, shot.shotIndex, alt, duration, used, mediaDir, briefFor(alt));
            } catch (e2) {
              lastErr = e2;
            }
          }
          // Tier 3 (beats only): the scene-level subject — related to the line but not literal, so reviewed.
          if (!asset! && beat && lastErr instanceof ValidationError) {
            try {
              const got = await this.sourceScene(scene.sceneNumber, shot.shotIndex, scene.assetKeywords, duration, used, mediaDir, sceneBrief);
              reviewNotes.set(got.id, `beat "${beat.text}" uses the scene-level subject "${sceneBrief.visualSubject}" instead of "${beat.visualSubject}"`);
              asset = got;
            } catch (e3) {
              if (!(e3 instanceof ValidationError)) throw e3;
              lastErr = e3;
            }
          }
          // Tier 4 (only when this unit has no footage yet; later shots merge into the previous one):
          // a broad b-roll subject, then the Short's main subject — always flagged for human review.
          const unitHasShot = shots.some((x) => x.sceneNumber === shot.sceneNumber && x.beatIndex === shot.beatIndex);
          if (!asset! && unitHasShot) throw lastErr;
          if (!asset!) {
            if (!(lastErr instanceof ValidationError)) throw lastErr;
            const candidates = [broadSubject(unitKeywords, brief.visualSubject), broadSubject(scene.assetKeywords, scene.visualSubject), mainSubject(script)].filter(
              (x, i, a): x is string => Boolean(x) && a.indexOf(x) === i
            );
            let picked: AssetDescriptor | null = null;
            let usedBroad = '';
            for (const broad of candidates) {
              try {
                picked = await this.brollFallback(scene, shot, broad, brief, duration, used, mediaDir);
                usedBroad = broad;
                break;
              } catch (e4) {
                if (!(e4 instanceof ValidationError)) throw e4;
                lastErr = e4;
              }
            }
            if (!picked) throw lastErr;
            refined.set(unitKey, [usedBroad, ...unitKeywords.filter((k) => k !== usedBroad)].slice(0, 3));
            asset = picked;
          }
        }
      } catch (err) {
        const prev = shots[shots.length - 1];
        if (err instanceof ValidationError && prev && prev.sceneNumber === shot.sceneNumber) {
          logger.warn(`Scene ${shot.sceneNumber} shot ${shot.shotIndex}: no further suitable distinct media; extending the previous shot instead`, { stage: 'MEDIA' });
          // A different beat now plays over this clause: never silent — the asset goes to human review.
          if (prev.beatIndex !== shot.beatIndex) {
            const prevAsset = out[out.length - 1];
            reviewNotes.set(prevAsset.id, `shot extended over the next clause "${beat?.text ?? scene.narration}" (no fitting footage for it)`);
          }
          prev.end = shot.end;
          if (shot.lastWordIndex !== undefined) prev.lastWordIndex = shot.lastWordIndex;
          continue;
        }
        throw err;
      }
      used.add(`${asset.provider}:${asset.providerAssetId}`);
      out.push(asset);
      shots.push({ ...shot });
      await onAsset?.(asset);
    }
    // Fallback and extension notes become explicit review flags on the affected assets.
    for (let i = 0; i < out.length; i++) {
      const note = reviewNotes.get(out[i].id);
      if (!note) continue;
      const v = out[i].visualValidation!;
      out[i] = AssetDescriptorSchema.parse({
        ...out[i],
        visualValidation: { ...v, decision: 'NEEDS_REVIEW', semantic: v.semantic ? { ...v.semantic, issues: [...v.semantic.issues, note], reason: `${v.semantic.reason} | ${note}` } : null },
      });
      await onAsset?.(out[i]);
    }
    return { assets: out, shots };
  }

  private async graphicAsset(
    sceneNumber: number,
    sceneNarration: string,
    shotIndex: number,
    beatText: string,
    spec: NonNullable<NonNullable<ShortScript['scenes'][number]['beats']>[number]['graphic']>,
    seconds: number,
    mediaDir: string
  ): Promise<AssetDescriptor> {
    // Re-checked here: a graphic may only repeat what the narration says.
    const problems = validateGraphic(spec, beatText, sceneNarration);
    if (problems.length) throw new ValidationError(`Graphic for scene ${sceneNumber} shot ${shotIndex} is not supported by its narration`, problems);
    const renderer = this.opts.graphics!;
    // Rendered slightly longer than the shot so a later timing change of a few frames still fits.
    const length = Math.ceil((seconds + 0.2) * 10) / 10;
    const local = path.join(mediaDir, `scene_${sceneNumber}_${shotIndex}_blender_${spec.template}.mp4`);
    await renderer.render(spec, length, local);
    const summary = await summarizeMedia(local);
    const v = summary.video;
    if (!v) throw new ValidationError(`Rendered graphic for scene ${sceneNumber} has no video stream`);
    const probe: MediaProbe = { formatName: summary.formatName, videoCodec: v.codec, width: v.width, height: v.height, durationSeconds: v.durationSeconds || summary.durationSeconds, hasAudio: false, sizeBytes: summary.sizeBytes };
    const inspection = await inspectFrames(local, probe, true);
    if (inspection.defects.length) throw new ValidationError(`Rendered graphic for scene ${sceneNumber} failed frame checks`, inspection.defects);
    const sha = await sha256File(local);
    const url = pathToFileURL(local).href;
    return AssetDescriptorSchema.parse({
      id: randomUUID(),
      assetType: 'VIDEO',
      provider: 'blender',
      providerAssetId: `${spec.template}-${sha.slice(0, 12)}`,
      sourceUrl: url,
      pageUrl: url,
      license: 'Original graphic rendered locally with Blender from the script text (no third-party material)',
      licenseVerified: true,
      commercialUseAllowed: true,
      attributionRequired: false,
      width: v.width,
      height: v.height,
      localPath: local,
      sha256: sha,
      sceneNumber,
      shotIndex,
      probe,
      ranking: { score: 1, relevance: 1, matchedTerms: [], orientation: 1, resolution: 1, duration: 1, reasons: ['generated graphic restating this clause'] },
      // Deterministic checks only: the text is verified against the narration above, so no vision verdict is claimed.
      visualValidation: { frames: inspection.frames, defects: [], semantic: null, decision: 'ACCEPTED' },
      framing: { mode: 'cover', centerStart: 0.5, centerEnd: 0.5, upscale: 1, reason: 'generated at 1080x1920' },
      generated: { tool: 'blender', version: renderer.version, spec, beatText },
      retrievedAt: new Date().toISOString(),
      metadata: {},
    });
  }

  private queries(keywords: string[]): string[] {
    const qs = [keywords.slice(0, 2).join(' '), ...keywords];
    return [...new Set(qs.map((q) => q.trim()).filter(Boolean))];
  }

  /** Broad b-roll for a scene, judged in context, always flagged for human review. */
  private async brollFallback(
    scene: { sceneNumber: number; assetKeywords: string[] },
    shot: { shotIndex: number },
    broad: string,
    brief: SceneVisualBrief,
    duration: number,
    used: Set<string>,
    mediaDir: string
  ): Promise<AssetDescriptor> {
    const kw = [broad, ...scene.assetKeywords.filter((k) => k !== broad)].slice(0, 3);
    logger.info(`Scene ${scene.sceneNumber}: falling back to broad b-roll subject "${broad}" (scene exclusions relaxed; flagged for human review)`, { stage: 'MEDIA' });
    // Judged in context: a bare word is ambiguous (live: "board" from "notice board" matched a circuit board).
    const got = await this.sourceScene(scene.sceneNumber, shot.shotIndex, kw, duration, used, mediaDir, {
      ...brief,
      visualSubject: `${broad} (general b-roll for: ${brief.visualSubject})`,
      visualExclusions: [],
    });
    const v = got.visualValidation!;
    const note = `broad b-roll fallback ("${broad}") for "${brief.visualSubject}" — check the shot still fits the line`;
    return AssetDescriptorSchema.parse({
      ...got,
      visualValidation: { ...v, decision: 'NEEDS_REVIEW', semantic: v.semantic ? { ...v.semantic, issues: [...v.semantic.issues, note], reason: `${v.semantic.reason} | ${note}` } : null },
    });
  }

  private async sourceScene(
    sceneNumber: number,
    shotIndex: number,
    keywords: string[],
    sceneDuration: number,
    used: Set<string>,
    mediaDir: string,
    brief: SceneVisualBrief
  ): Promise<AssetDescriptor> {
    const rejections: string[] = [];
    let fallback: AssetDescriptor | null = null;
    let visionChecks = 0;
    const maxVision = this.opts.maxVisionChecksPerShot ?? 3;
    for (const mediaType of ['VIDEO', 'IMAGE'] as const) {
      const ranked = new Map<string, { c: AssetCandidate; r: AssetRanking }>();
      for (const q of this.queries(keywords)) {
        const results = await this.provider.search({ query: q, mediaType, perPage: 30 });
        for (const c of results) {
          const outcome = rankCandidate(c, {
            keywords,
            exclusions: brief.visualExclusions,
            sceneDurationSeconds: sceneDuration,
            usedMediaKeys: used,
            minRelevance: this.opts.minRelevance,
            maxBytes: this.opts.maxDownloadBytes,
          });
          if (!outcome.ok) continue;
          const k = mediaKey(c);
          if (!ranked.has(k) || ranked.get(k)!.r.score < outcome.ranking.score) ranked.set(k, { c, r: outcome.ranking });
        }
        if ([...ranked.values()].filter((x) => x.r.score >= 0.75).length >= 3) break;
      }
      let ordered = [...ranked.values()].sort((a, b) => b.r.score - a.r.score).slice(0, 8);
      if (this.judge && ordered.length > 0) {
        const fit = await this.judge(brief, ordered.map(({ c }) => ({ key: mediaKey(c), mediaType: c.mediaType, tags: c.tags, description: c.description })));
        const rejected = ordered.filter(({ c }) => !fit.has(mediaKey(c)));
        if (rejected.length) rejections.push(`visual-fit judge rejected ${rejected.map(({ c }) => mediaKey(c)).join(', ')}`);
        ordered = ordered.filter(({ c }) => fit.has(mediaKey(c)));
      }
      for (const { c, r } of ordered.slice(0, this.opts.maxDownloadAttemptsPerScene ?? 4)) {
        try {
          const acquired = await this.acquire(c, r, sceneNumber, shotIndex, mediaDir, sceneDuration);
          if (!acquired.asset) {
            rejections.push(`${mediaKey(c)}: ${acquired.reason}`);
            continue;
          }
          // Semantic check of the real frames, only for candidates that passed every deterministic check.
          let semantic: SemanticVerdict | null = null;
          if (this.vision) {
            if (visionChecks >= maxVision) break;
            visionChecks++;
            semantic = await this.visionCheck(acquired.asset, brief, mediaDir, sceneDuration);
            if (semantic.verdict === 'REJECT') {
              rejections.push(`${mediaKey(c)}: vision check rejected — ${semantic.reason}`);
              continue;
            }
          }
          const decision = semantic?.verdict === 'ACCEPT' ? 'ACCEPTED' : 'NEEDS_REVIEW';
          const asset = AssetDescriptorSchema.parse({ ...acquired.asset, visualValidation: { ...acquired.asset.visualValidation!, semantic, decision } });
          if (decision === 'NEEDS_REVIEW') {
            // Keep the first uncertain candidate as a fallback, but keep looking for a confident match.
            fallback ??= asset;
            rejections.push(`${mediaKey(c)}: ${semantic ? `vision check unsure — ${semantic.reason}` : 'no vision check available'}`);
            if (!this.vision) break;
            continue;
          }
          logger.info(`Scene ${sceneNumber}.${shotIndex}: selected ${c.provider} ${c.mediaType.toLowerCase()} ${c.providerMediaId} (${c.width}x${c.height}, score ${r.score}, vision ${semantic?.verdict ?? 'n/a'})`, { stage: 'MEDIA' });
          return asset;
        } catch (err) {
          // Authentication/configuration problems are not candidate-specific: stop immediately.
          if (err instanceof PipelineError && (err.kind === 'AUTHENTICATION' || err.kind === 'CONFIGURATION' || err.kind === 'QUOTA_EXCEEDED')) throw err;
          rejections.push(`${mediaKey(c)}: ${(err as Error).message}`);
        }
      }
      if (fallback || visionChecks >= maxVision) break;
      if (ordered.length === 0) rejections.push(`no ${mediaType.toLowerCase()} candidates met relevance/resolution requirements for [${keywords.join(', ')}]`);
    }
    if (fallback) {
      logger.warn(`Scene ${sceneNumber}.${shotIndex}: no confidently matching media; using ${fallback.provider} ${fallback.providerAssetId} pending human review`, { stage: 'MEDIA' });
      return fallback;
    }
    throw new ValidationError(`No suitable media for scene ${sceneNumber} shot ${shotIndex}`, rejections.slice(0, 8));
  }

  private async visionCheck(asset: AssetDescriptor, brief: SceneVisualBrief, mediaDir: string, usedSeconds = 4): Promise<SemanticVerdict> {
    const sheet = path.join(mediaDir, `.sheet_${asset.providerAssetId}.jpg`);
    // Judge what the viewer will see: frames from the segment the shot uses, with the framing crop.
    // (Live: a clip whose banknotes only appear after 3 s was accepted from 25/50/75 % samples, but
    // its 2 s shot showed an empty backdrop.)
    const d = asset.probe.durationSeconds;
    const span = Math.min(usedSeconds, d || usedSeconds);
    const fractions = asset.assetType === 'VIDEO' ? [0.15, 0.5, 0.85] : [0];
    const times = fractions.map((f) => Math.max(0, Math.min(d - 0.05, f * span)));
    const fr = asset.framing;
    const keep = Math.min(1, (asset.probe.height * 9) / 16 / asset.probe.width);
    const crops = fractions.map((f) =>
      fr?.mode === 'crop_pan' && keep < 1 ? `crop=ih*9/16:ih:(iw-ow)*${cropOffsetFraction(fr.centerStart + (fr.centerEnd - fr.centerStart) * f, keep).toFixed(4)}:0` : null
    );
    try {
      await writeContactSheet(asset.localPath, times, 240, sheet, crops);
      return await this.vision!(brief, fs.readFileSync(sheet));
    } finally {
      fs.rmSync(sheet, { force: true });
    }
  }

  private async acquire(
    c: AssetCandidate,
    ranking: AssetRanking,
    sceneNumber: number,
    shotIndex: number,
    mediaDir: string,
    usedSeconds = 4
  ): Promise<{ asset: AssetDescriptor | null; reason: string }> {
    const ext = c.mediaType === 'VIDEO' ? 'mp4' : path.extname(new URL(c.downloadUrl).pathname).replace('.', '') || 'jpg';
    const base = sanitizeSegment(`${c.provider}_${c.providerMediaId}_${c.width}x${c.height}`);
    const cachePath = path.join(this.opts.mediaCacheDir, `${base}.${sanitizeSegment(ext, 5)}`);
    const sidecar = `${cachePath}.valid.json`;

    let probe: MediaProbe | undefined;
    let sha: string | undefined;
    let inspection: FrameInspection | undefined;
    if (fs.existsSync(cachePath) && fs.existsSync(sidecar)) {
      const meta = JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as { v?: number; sha256: string; probe: MediaProbe; inspection: FrameInspection };
      if (meta.v === VALIDATION_VERSION && (await sha256File(cachePath)) === meta.sha256) {
        probe = meta.probe;
        sha = meta.sha256;
        inspection = meta.inspection;
        logger.debug(`Media cache hit ${base}`, { stage: 'MEDIA' });
      }
    }
    if (!probe || !inspection) {
      const dl = fs.existsSync(cachePath)
        ? { sha256: await sha256File(cachePath) } // already downloaded; re-validate under current rules
        : await this.provider.download(c, cachePath);
      const validation = await validateMediaFile(cachePath, c);
      const frames = validation.ok && validation.probe ? await inspectFrames(cachePath, validation.probe, c.mediaType === 'VIDEO') : undefined;
      const problems = [...validation.problems, ...(frames?.defects ?? [])];
      if (problems.length > 0 || !validation.probe || !frames) {
        logger.warn(`Rejected downloaded media ${base}: ${problems.join('; ')}`, { stage: 'MEDIA' });
        fs.rmSync(cachePath, { force: true });
        fs.rmSync(sidecar, { force: true });
        return { asset: null, reason: `failed validation: ${problems.join('; ')}` };
      }
      probe = validation.probe;
      sha = dl.sha256;
      inspection = frames;
      fs.writeFileSync(sidecar, JSON.stringify({ v: VALIDATION_VERSION, sha256: sha, probe, inspection }));
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

    // Full-bleed framing, decided from frames of the segment this shot actually uses; a blank or
    // black stretch inside that segment rejects the clip even if the rest of it is fine.
    const { framing, defects: windowDefects } = await this.frame(local, probe, c.mediaType === 'VIDEO', usedSeconds);
    if (windowDefects.length) return { asset: null, reason: `used segment (first ${usedSeconds.toFixed(1)} s): ${windowDefects.join('; ')}` };

    const asset = AssetDescriptorSchema.parse({
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
      visualValidation: { frames: inspection.frames, defects: inspection.defects, semantic: null, decision: 'NEEDS_REVIEW' },
      framing: { mode: framing.mode, centerStart: framing.centerStart, centerEnd: framing.centerEnd, upscale: framing.upscale, reason: framing.reason },
      retrievedAt: new Date().toISOString(),
      metadata: { tags: c.tags, author: c.author, previewUrl: c.previewUrl },
    });
    return { asset, reason: 'ok' };
  }

  private async frame(file: string, probe: MediaProbe, isVideo: boolean, usedSeconds: number): Promise<{ framing: FramingDecision; defects: string[] }> {
    const span = isVideo ? Math.min(usedSeconds, probe.durationSeconds || usedSeconds) : 0;
    const times = isVideo ? [0.1, 0.5, 0.9].map((f) => Math.max(0, Math.min(probe.durationSeconds - 0.05, f * span))) : [0];
    const box = analysisBox(probe.width, probe.height);
    const rgb = await extractRgbFrames(file, times, box.w, box.h);
    const metrics = rgb.map((b, i) => analyzeFrame(b, box.w, box.h, times[i]));
    // Only black/blank here: a short window of a slow clip can legitimately look "frozen".
    const defects = frameDefects(metrics, rgb, false).filter((d) => /^(black|blank)/.test(d));
    const featureless = rgb.map((b, i) => ({ t: times[i], d: edgeDetail(b, box.w, box.h) })).filter((x) => x.d < FRAME_THRESHOLDS.featurelessDetail);
    if (featureless.length >= Math.min(2, rgb.length)) defects.push(`featureless frame(s) (no visible subject) at ${featureless.map((x) => `${x.t.toFixed(1)}s`).join(', ')}`);
    const framing = chooseFraming({ width: probe.width, height: probe.height }, rgb.map((b) => ({ rgb: b, w: box.w, h: box.h })), {
      outWidth: 1080,
      outHeight: 1920,
      maxUpscale: this.opts.maxUpscale ?? 2,
    });
    return { framing, defects };
  }
}

/**
 * Broadest filmable subject for a scene: a single-word keyword if there is one, else the last word
 * of the visual subject (usually its head noun, e.g. "airplane" in "airplane with clouds" is the
 * first word, so single-word keywords are preferred).
 */
export function broadSubject(keywords: string[], visualSubject: string): string | null {
  const single = keywords.map((k) => k.trim().toLowerCase()).find((k) => /^[a-z]{3,}$/.test(k));
  if (single) return single;
  // Otherwise the word the subject and keywords agree on most (e.g. "emus" in "scattered emus").
  const counts = new Map<string, number>();
  for (const t of [...significantTokens(visualSubject ?? ''), ...keywords.flatMap((k) => significantTokens(k))]) counts.set(t, (counts.get(t) ?? 0) + 1);
  // Ties go to the later word of the subject: English noun phrases end with their head noun.
  const order = significantTokens(visualSubject ?? '');
  const best = [...counts.entries()].sort((x, y) => y[1] - x[1] || order.lastIndexOf(y[0]) - order.lastIndexOf(x[0]))[0];
  return best && best[1] >= 2 ? best[0] : null;
}

/** The Short's most recurrent visual noun across all scenes (e.g. "crow"), for last-resort b-roll. */
export function mainSubject(script: { scenes: Array<{ visualSubject?: string; assetKeywords: string[] }> }): string | null {
  // Scenes mentioning the word, plus a bonus when it is a search keyword (keywords are what stock is tagged with).
  const scenesWith = new Map<string, number>();
  const keywordHits = new Map<string, number>();
  const firstKeywordPos = new Map<string, number>();
  for (const sc of script.scenes) {
    const kwTokens = sc.assetKeywords.flatMap((k) => significantTokens(k));
    for (const t of new Set([...significantTokens(sc.visualSubject ?? ''), ...kwTokens])) scenesWith.set(t, (scenesWith.get(t) ?? 0) + 1);
    kwTokens.forEach((t, i) => {
      keywordHits.set(t, (keywordHits.get(t) ?? 0) + 1);
      if (!firstKeywordPos.has(t) || firstKeywordPos.get(t)! > i) firstKeywordPos.set(t, i);
    });
  }
  const score = (t: string) => (scenesWith.get(t) ?? 0) + 0.5 * (keywordHits.get(t) ?? 0);
  const best = [...scenesWith.keys()].sort((x, y) => score(y) - score(x) || (firstKeywordPos.get(x) ?? 99) - (firstKeywordPos.get(y) ?? 99))[0];
  return best && (scenesWith.get(best) ?? 0) >= 2 ? best : null;
}

const stem = (t: string) => t.replace(/(ies|es|s)$/, '');
const tagBag = (c: AssetCandidate) => new Set(significantTokens(`${c.tags.join(' ')} ${c.description}`).map(stem));

export interface VisualPreflightOptions {
  minRelevance: number;
  maxDownloadBytes: number;
  /** Ranked stock candidates a scene needs before voice credits are spent. */
  minCandidates: number;
  /** Typical shot length used for duration scoring. */
  shotSeconds?: number;
}

/**
 * Pre-voice footage check: runs the same searches and ranking rules as media sourcing (searches
 * are cached, so sourcing reuses them) and reports scenes whose visual subject has too little
 * usable stock footage. Cheap (no downloads, no model calls) and catches unsourceable scripts
 * before narration is paid for.
 */
export async function visualPreflight(
  provider: AssetProvider,
  scenes: Array<{ label?: string; visualSubject: string; assetKeywords: string[]; visualExclusions: string[] }>,
  opts: VisualPreflightOptions
): Promise<string[]> {
  const violations: string[] = [];
  for (const [i, s] of scenes.entries()) {
    const keywords = [s.visualSubject, ...s.assetKeywords].map((k) => k.trim()).filter(Boolean);
    const subjectTokens = significantTokens(s.visualSubject).map(stem);
    const queries = [...new Set([keywords.slice(0, 2).join(' '), ...keywords].filter(Boolean))].slice(0, 3);
    const ok = new Set<string>();
    // Tags on usable results, so a failing subject comes back with words stock actually uses.
    const seen = new Set<string>();
    const tagCounts = new Map<string, number>();
    for (const mediaType of ['VIDEO', 'IMAGE'] as const) {
      for (const q of queries) {
        for (const c of await provider.search({ query: q, mediaType, perPage: 30 })) {
          const r = rankCandidate(c, {
            keywords,
            exclusions: s.visualExclusions,
            sceneDurationSeconds: opts.shotSeconds ?? 6,
            usedMediaKeys: new Set(),
            minRelevance: opts.minRelevance,
            maxBytes: opts.maxDownloadBytes,
          });
          // Count only clips whose tags/description contain every word of the visual subject: the
          // visual-fit and vision judges reject loose matches (live: "injured crow" → tiger clips).
          if (r.ok && subjectTokens.every((t) => tagBag(c).has(t))) ok.add(mediaKey(c));
          if (r.ok && !seen.has(mediaKey(c))) {
            seen.add(mediaKey(c));
            for (const t of new Set(c.tags.map((x) => x.trim().toLowerCase()).filter((x) => x.length > 2))) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
          }
        }
        if (ok.size >= opts.minCandidates) break;
      }
      if (ok.size >= opts.minCandidates) break;
    }
    if (ok.size < opts.minCandidates) {
      const common = [...tagCounts.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6)
        .map(([t]) => t);
      // Words of the failing subject that stock carries by themselves (live: "boat near shore" kept
      // failing while "boat" alone had plenty of clips).
      const alone = [...tagCounts.entries()]
        .filter(([t, n]) => n >= opts.minCandidates && !t.includes(' ') && subjectTokens.includes(stem(t)))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([t]) => t);
      violations.push(
        `${s.label ?? `scene ${i + 1}`} visualSubject "${s.visualSubject}" matches only ${ok.size} stock clip(s) (need ${opts.minCandidates}); use a simpler, common subject that stock libraries tag literally (e.g. "crow on branch" rather than "injured crow"), 2-3 words` +
          (common.length ? `; tags on the stock clips these searches found: ${common.map((t) => `"${t}"`).join(', ')} (only use one if it literally shows what this beat says)` : '') +
          (alone.length ? `; on its own, ${alone.map((t) => `"${t}"`).join(' or ')} has enough footage` : '')
      );
    }
  }
  return violations;
}
