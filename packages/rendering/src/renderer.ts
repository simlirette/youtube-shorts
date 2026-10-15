import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssetDescriptor, RenderJob, RenderJobSchema, ShortScript, Timeline, VoiceNarration } from '@shorts/schemas';
import { ConfigurationError, InternalError, cropOffsetFraction, logger, runFfmpeg, sha256File, summarizeMedia } from '@shorts/core';
import { CAPTION_LAYOUT, CaptionLayout, CaptionStyleName, writeAss, writeTitleAss } from './captions.js';
import type { LoadedTrack } from './music.js';

export const OUTPUT = { width: 1080, height: 1920, fps: 30 } as const;

/** Limited-range BT.709 output. Full-range (JPEG/"pc") sources are converted, never passed through. */
const TV_RANGE = 'scale=out_range=tv:out_color_matrix=bt709,format=yuv420p';
const COLOR_TAGS = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];

export interface RenderInput {
  script: ShortScript;
  timeline: Timeline;
  narration: VoiceNarration;
  assets: AssetDescriptor[];
  /** Job render directory; all intermediates live here. */
  renderDir: string;
  fontFile: string;
  layout?: CaptionLayout;
  captionStyle?: CaptionStyleName;
  /** Opening topic card text (null/undefined = no title card). */
  titleCard?: string | null;
  /** Approved background track and its gain; null = narration only (reason recorded). */
  music?: { track: LoadedTrack; gainDb: number; bedLu: number } | null;
  musicDisabledReason?: string;
}

export interface RenderOutput {
  render: RenderJob;
  /** Same video without burned-in captions (kept for caption QA). */
  uncaptionedPath: string;
}

/**
 * Effective framing for an asset: the stored decision, or (legacy assets without one) a centered
 * full-bleed crop unless that would upscale more than 2×.
 */
export function framingOf(asset: AssetDescriptor): NonNullable<AssetDescriptor['framing']> & { keepFraction: number } {
  const { width: W, height: H } = OUTPUT;
  const ar = asset.probe.width / asset.probe.height;
  const keep = ar > W / H ? (asset.probe.height * (W / H)) / asset.probe.width : 1;
  if (asset.framing) return { ...asset.framing, keepFraction: asset.framing.mode === 'crop_pan' ? keep : 1 };
  if (ar <= (W / H) * 1.02) return { mode: 'cover', centerStart: 0.5, centerEnd: 0.5, upscale: Math.max(W / asset.probe.width, H / asset.probe.height), reason: 'legacy: portrait', keepFraction: 1 };
  const upscale = H / asset.probe.height;
  if (upscale > 2 || keep < 0.25) return { mode: 'letterbox', centerStart: 0.5, centerEnd: 0.5, upscale: W / asset.probe.width, reason: 'legacy: crop would upscale too much', keepFraction: 1 };
  return { mode: 'crop_pan', centerStart: 0.5, centerEnd: 0.5, upscale, reason: 'legacy: centered crop', keepFraction: keep };
}

/** Filter graph that maps any source to 1080×1920 without distortion (full-bleed unless letterboxed). */
export function sceneFilter(asset: AssetDescriptor, frames: number): string {
  const { width: W, height: H, fps } = OUTPUT;
  const f = framingOf(asset);
  const seconds = (frames / fps).toFixed(3);
  const x0 = cropOffsetFraction(f.centerStart, f.keepFraction);
  const x1 = cropOffsetFraction(f.centerEnd, f.keepFraction);
  // Crop x as a fraction of (scaled width - crop width), moving linearly from x0 to x1 over the shot.
  const xExpr = x0 === x1 ? `(iw-ow)*${x0.toFixed(4)}` : `(iw-ow)*(${x0.toFixed(4)}+(${(x1 - x0).toFixed(4)})*min(t/${seconds}\,1))`;
  if (asset.assetType === 'IMAGE') {
    // Cover-crop at 2× (crop window placed by the framing decision), then a slow punch-in (Ken Burns).
    const crop =
      f.mode === 'crop_pan'
        ? `scale=-2:${H * 2},crop=${W * 2}:${H * 2}:x='(iw-ow)*${x0.toFixed(4)}':y=0`
        : `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}`;
    return (
      `[0:v]${crop},setsar=1,` +
      `zoompan=z='min(1+0.0009*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},` +
      `trim=end_frame=${frames},${TV_RANGE}[v]`
    );
  }
  if (f.mode === 'cover') {
    return `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},${TV_RANGE}[v]`;
  }
  if (f.mode === 'crop_pan') {
    return `[0:v]scale=-2:${H}:flags=lanczos,crop=${W}:${H}:x='${xExpr}':y=0,setsar=1,fps=${fps},${TV_RANGE}[v]`;
  }
  // Letterbox (only when a crop would destroy the picture): full frame over a blurred fill of itself.
  return (
    `[0:v]split=2[bgsrc][fgsrc];` +
    `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:2,eq=brightness=-0.15[bg];` +
    `[fgsrc]scale=${W}:-2[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${fps},${TV_RANGE}[v]`
  );
}

export class VideoRenderer {
  async render(input: RenderInput): Promise<RenderOutput> {
    const { script, timeline, narration, assets, renderDir } = input;
    const layout = input.layout ?? CAPTION_LAYOUT;
    const renderId = randomUUID();
    const fps = OUTPUT.fps;
    if (timeline.fps !== fps) throw new InternalError(`Timeline fps ${timeline.fps} != output fps ${fps}`);
    if (!fs.existsSync(input.fontFile)) throw new ConfigurationError(`Caption font file not found: ${input.fontFile}`);
    if (!fs.existsSync(narration.audioPath)) throw new InternalError(`Narration audio missing: ${narration.audioPath}`);
    fs.mkdirSync(renderDir, { recursive: true });

    // Work with relative paths inside renderDir (avoids filter-graph escaping of Windows drive paths).
    const fontsDir = path.join(renderDir, 'fonts');
    fs.mkdirSync(fontsDir, { recursive: true });
    fs.copyFileSync(input.fontFile, path.join(fontsDir, path.basename(input.fontFile)));
    const assPath = path.join(renderDir, 'captions.ass');
    writeAss(timeline.captions, assPath, layout, input.captionStyle ?? 'plain');
    const titlePath = path.join(renderDir, 'title.ass');
    if (input.titleCard) writeTitleAss(input.titleCard, titlePath, layout);
    else fs.rmSync(titlePath, { force: true });

    // 1. One clip per scene, exactly the timeline's frame count, with NO audio.
    const clipNames: string[] = [];
    let expectedFrames = 0;
    for (const shot of timeline.shots) {
      const label = `scene ${shot.sceneNumber} shot ${shot.shotIndex}`;
      const asset = assets.find((a) => a.sceneNumber === shot.sceneNumber && a.shotIndex === shot.shotIndex);
      if (!asset) throw new InternalError(`No asset for ${label}`);
      if (!fs.existsSync(asset.localPath)) throw new InternalError(`Asset file missing for ${label}: ${asset.localPath}`);
      const frames = Math.round(shot.end * fps) - Math.round(shot.start * fps);
      if (frames < 1) throw new InternalError(`${label} has no frames`);
      expectedFrames += frames;
      const seconds = frames / fps;
      const clip = `shot_${String(shot.sceneNumber).padStart(2, '0')}_${String(shot.shotIndex).padStart(2, '0')}.mp4`;
      const needsLoop = asset.assetType === 'VIDEO' && asset.probe.durationSeconds < seconds + 0.2;
      const inputArgs =
        asset.assetType === 'IMAGE'
          ? ['-loop', '1', '-framerate', String(fps), '-i', asset.localPath]
          : [...(needsLoop ? ['-stream_loop', '-1'] : []), '-i', asset.localPath];
      await runFfmpeg(
        [
          '-y',
          ...inputArgs,
          '-filter_complex', sceneFilter(asset, frames),
          '-map', '[v]',
          '-an', '-sn', '-dn',
          '-frames:v', String(frames),
          '-r', String(fps),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', ...COLOR_TAGS,
          clip,
        ],
        { cwd: renderDir, description: `${label} clip` }
      );
      const s = await summarizeMedia(path.join(renderDir, clip));
      if (s.audioStreams !== 0) throw new InternalError(`Scene clip ${clip} unexpectedly contains audio`);
      if (!s.video || s.video.width !== OUTPUT.width || s.video.height !== OUTPUT.height) {
        throw new InternalError(`Scene clip ${clip} has wrong geometry ${s.video?.width}x${s.video?.height}`);
      }
      clipNames.push(clip);
    }
    if (expectedFrames !== timeline.totalFrames) {
      throw new InternalError(`Shot frames (${expectedFrames}) != timeline frames (${timeline.totalFrames})`);
    }

    // 2. Concatenate (identical encoding parameters → stream copy).
    fs.writeFileSync(path.join(renderDir, 'concat.txt'), clipNames.map((c) => `file '${c}'`).join('\n') + '\n');
    const uncaptioned = 'video_uncaptioned.mp4';
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', '-an', uncaptioned], {
      cwd: renderDir,
      description: 'concat scenes',
    });

    // 3. Burn captions (+ title card) and attach the narration with explicit stream mapping. The
    //    narration is padded to the full timeline length; nothing is truncated. With an approved
    //    track, a music bed is mixed under it and ducked whenever the narration speaks.
    const narrationRel = path.relative(renderDir, narration.audioPath);
    const total = timeline.totalDurationSeconds.toFixed(3);
    const finalName = 'short.mp4';
    const videoChain = `[0:v]ass=captions.ass:fontsdir=fonts${input.titleCard ? ',ass=title.ass:fontsdir=fonts' : ''},${TV_RANGE}[v]`;
    const voice = `[1:a]aresample=48000,apad,atrim=0:${total},aformat=sample_fmts=fltp:channel_layouts=stereo`;
    const music = input.music;
    const audioInputs = music ? ['-stream_loop', '-1', '-i', path.relative(renderDir, music.track.filePath)] : [];
    const fadeOut = Math.max(0, timeline.totalDurationSeconds - 0.35).toFixed(3);
    const audioChain = music
      ? `${voice},asplit=2[voice][key];` +
        `[2:a]aresample=48000,atrim=0:${total},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${music.gainDb}dB,` +
        `afade=t=in:d=0.4,afade=t=out:st=${fadeOut}:d=0.35[bed];` +
        `[bed][key]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=350[ducked];` +
        `[voice][ducked]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.89:level=false[a]`
      : `${voice}[a]`;
    await runFfmpeg(
      [
        '-y',
        '-i', uncaptioned,
        '-i', narrationRel,
        ...audioInputs,
        '-filter_complex',
        `${videoChain};${audioChain}`,
        '-map', '[v]',
        '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...COLOR_TAGS, '-r', String(fps),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-t', total,
        '-movflags', '+faststart',
        finalName,
      ],
      { cwd: renderDir, description: `final mux (captions${input.titleCard ? ' + title' : ''} + narration${music ? ' + music bed' : ''})` }
    );

    // 4. Clean intermediates (keep final + uncaptioned for QA).
    for (const c of clipNames) fs.rmSync(path.join(renderDir, c), { force: true });
    fs.rmSync(path.join(renderDir, 'concat.txt'), { force: true });

    const finalPath = path.join(renderDir, finalName);
    const probe = await summarizeMedia(finalPath);
    const render = RenderJobSchema.parse({
      id: renderId,
      scriptId: script.id,
      templateType: 'DOCUMENTARY',
      videoPath: finalPath,
      captionsPath: assPath,
      durationSeconds: probe.durationSeconds,
      resolution: { width: 1080, height: 1920 },
      fps,
      sha256: await sha256File(finalPath),
      renderedAt: new Date().toISOString(),
      status: 'COMPLETED',
      music: music
        ? { trackId: music.track.id, title: music.track.title, source: music.track.source, licence: music.track.licence, bedLu: music.bedLu, gainDb: music.gainDb, trackLufs: music.track.integratedLufs }
        : null,
      musicDisabledReason: music ? undefined : input.musicDisabledReason ?? 'music not requested',
      titleCard: input.titleCard ?? null,
      captionStyle: input.captionStyle ?? 'plain',
    });
    logger.info(`Rendered ${finalPath} (${probe.durationSeconds.toFixed(2)}s, ${(probe.sizeBytes / 1e6).toFixed(1)} MB)`, { stage: 'RENDER' });
    return { render, uncaptionedPath: path.join(renderDir, uncaptioned) };
  }
}
