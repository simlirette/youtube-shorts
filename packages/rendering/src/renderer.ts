import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssetDescriptor, RenderJob, RenderJobSchema, ShortScript, Timeline, VoiceNarration } from '@shorts/schemas';
import { ConfigurationError, InternalError, logger, runFfmpeg, sha256File, summarizeMedia } from '@shorts/core';
import { CAPTION_LAYOUT, CaptionLayout, writeAss } from './captions.js';

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
}

export interface RenderOutput {
  render: RenderJob;
  /** Same video without burned-in captions (kept for caption QA). */
  uncaptionedPath: string;
}

/** Filter graph that maps any source to 1080×1920 without distortion. */
export function sceneFilter(asset: AssetDescriptor, frames: number): string {
  const { width: W, height: H, fps } = OUTPUT;
  const ar = asset.probe.width / asset.probe.height;
  if (asset.assetType === 'IMAGE') {
    // Cover-crop at 2× then a slow centered zoom (Ken Burns) rendered at the output size.
    return (
      `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},setsar=1,` +
      `zoompan=z='min(1+0.0009*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},` +
      `trim=end_frame=${frames},${TV_RANGE}[v]`
    );
  }
  if (ar <= 0.8) {
    // Portrait: cover-crop to fill the frame.
    return `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},${TV_RANGE}[v]`;
  }
  // Landscape/square: full frame visible over a blurred, darkened fill of itself.
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
    writeAss(timeline.captions, assPath, layout);

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

    // 3. Burn captions and attach the narration with explicit stream mapping. The narration is padded
    //    with silence to the full timeline length; nothing is truncated.
    const narrationRel = path.relative(renderDir, narration.audioPath);
    const total = timeline.totalDurationSeconds.toFixed(3);
    const finalName = 'short.mp4';
    await runFfmpeg(
      [
        '-y',
        '-i', uncaptioned,
        '-i', narrationRel,
        '-filter_complex',
        `[0:v]ass=captions.ass:fontsdir=fonts,${TV_RANGE}[v];[1:a]aresample=48000,apad,atrim=0:${total},aformat=sample_fmts=fltp:channel_layouts=stereo[a]`,
        '-map', '[v]',
        '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...COLOR_TAGS, '-r', String(fps),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-t', total,
        '-movflags', '+faststart',
        finalName,
      ],
      { cwd: renderDir, description: 'final mux (captions + narration)' }
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
    });
    logger.info(`Rendered ${finalPath} (${probe.durationSeconds.toFixed(2)}s, ${(probe.sizeBytes / 1e6).toFixed(1)} MB)`, { stage: 'RENDER' });
    return { render, uncaptionedPath: path.join(renderDir, uncaptioned) };
  }
}
