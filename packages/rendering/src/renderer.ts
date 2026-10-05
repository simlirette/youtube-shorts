import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  ShortScript,
  AssetDescriptor,
  VoiceNarration,
  RenderJob,
  VideoTemplateType,
} from '@shorts/schemas';
import { ShortsRepository, ContentStateMachine, logger } from '@shorts/core';
import { CaptionGenerator } from './captions.js';
import { TEMPLATES } from './templates.js';

export interface RenderOptions {
  templateType?: VideoTemplateType;
  outputFilePath?: string;
  enableSubtitles?: boolean;
}

export class VideoRenderer {
  constructor(private repo: ShortsRepository) {}

  private async runFFmpeg(args: string[], description: string): Promise<void> {
    logger.debug(`FFmpeg command [${description}]: ffmpeg ${args.join(' ')}`, {
      stage: 'RENDER',
    });

    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          logger.error(`FFmpeg failed [${description}] with code ${code}`, stderr.slice(-500), {
            stage: 'RENDER',
          });
          reject(new Error(`FFmpeg error (${code}): ${stderr.slice(-300)}`));
        }
      });

      child.on('error', (err) => {
        logger.error(`Failed to launch FFmpeg for ${description}`, err, { stage: 'RENDER' });
        reject(err);
      });
    });
  }

  async renderShort(
    script: ShortScript,
    assets: AssetDescriptor[],
    voice: VoiceNarration,
    options?: RenderOptions
  ): Promise<RenderJob> {
    const templateType = options?.templateType || 'DOCUMENTARY';
    const template = TEMPLATES[templateType] || TEMPLATES.DOCUMENTARY;
    const renderId = randomUUID();

    const outputDir = path.resolve(process.cwd(), 'output/renders');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const tempDir = path.resolve(process.cwd(), `output/temp/render_${renderId}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const finalVideoPath =
      options?.outputFilePath || path.join(outputDir, `short_${script.id}_${Date.now()}.mp4`);

    logger.info(`Starting video render job: ${renderId} (${template.name})`, {
      stage: 'RENDER',
      scriptId: script.id,
      scenes: script.scenes.length,
      template: templateType,
    });

    // Advance state to RENDERING
    ContentStateMachine.transition('ASSET_PREPARATION', 'RENDERING', { scriptId: script.id });
    await this.repo.updateTopicState(script.topicId, 'RENDERING');

    try {
      // 1. Render individual scene video clips
      const sceneClipPaths: string[] = [];

      for (const scene of script.scenes) {
        const sceneAsset = assets.find((a) => a.sceneNumber === scene.sceneNumber) || assets[0];
        const clipPath = path.join(tempDir, `scene_${scene.sceneNumber}.mp4`);

        // Create 1080x1920 clip from scene image
        const sceneArgs = [
          '-y',
          '-loop', '1',
          '-i', sceneAsset.localPath,
          '-t', scene.durationSeconds.toString(),
          '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
          '-r', '30',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          clipPath,
        ];

        await this.runFFmpeg(sceneArgs, `Scene ${scene.sceneNumber} clip`);
        sceneClipPaths.push(clipPath);
      }

      // 2. Concatenate scene clips
      const concatListPath = path.join(tempDir, 'concat_list.txt');
      const concatContent = sceneClipPaths
        .map((p) => `file '${p.replace(/\\/g, '/')}'`)
        .join('\n');
      fs.writeFileSync(concatListPath, concatContent, 'utf-8');

      const concatenatedVideoPath = path.join(tempDir, 'concatenated_video.mp4');
      const concatArgs = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        concatenatedVideoPath,
      ];
      await this.runFFmpeg(concatArgs, 'Concatenate scene clips');

      // 3. Generate subtitles
      const subPath = path.join(tempDir, 'captions.srt');
      CaptionGenerator.generateSrtFromScenes(script.scenes, subPath);

      // 4. Mux concatenated video with voice audio track and burned-in subtitles
      // Windows path escape for subtitles filter
      const escapedSubPath = subPath.replace(/\\/g, '/').replace(/:/g, '\\:');

      let renderArgs: string[];
      if (options?.enableSubtitles !== false) {
        renderArgs = [
          '-y',
          '-i', concatenatedVideoPath,
          '-i', voice.audioPath,
          '-vf', `subtitles='${escapedSubPath}':force_style='FontSize=22,FontName=Arial,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Alignment=2,MarginV=120'`,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-shortest',
          finalVideoPath,
        ];
      } else {
        renderArgs = [
          '-y',
          '-i', concatenatedVideoPath,
          '-i', voice.audioPath,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-shortest',
          finalVideoPath,
        ];
      }

      try {
        await this.runFFmpeg(renderArgs, 'Final mux with audio and captions');
      } catch (subErr) {
        logger.warn('Subtitles filter warning, falling back to direct video+audio mux', {
          stage: 'RENDER',
          err: subErr,
        });
        // Fallback without burned-in subtitles if libass has font issues
        const fallbackArgs = [
          '-y',
          '-i', concatenatedVideoPath,
          '-i', voice.audioPath,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-shortest',
          finalVideoPath,
        ];
        await this.runFFmpeg(fallbackArgs, 'Fallback mux without burned subtitles');
      }

      // Cleanup temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore temp cleanup errors
      }

      const totalDuration = script.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);

      const renderJob: RenderJob = {
        id: renderId,
        scriptId: script.id,
        templateType,
        videoPath: finalVideoPath,
        durationSeconds: totalDuration,
        resolution: { width: 1080, height: 1920 },
        fps: 30,
        renderedAt: new Date().toISOString(),
        status: 'COMPLETED',
      };

      await this.repo.saveRender(renderJob);

      // Advance state to RENDERED, then QA
      ContentStateMachine.transition('RENDERING', 'RENDERED', { renderId });
      ContentStateMachine.transition('RENDERED', 'QA', { renderId });
      await this.repo.updateTopicState(script.topicId, 'QA');

      logger.info(`Render completed successfully: ${finalVideoPath} (Duration: ${totalDuration}s)`, {
        stage: 'RENDER',
        renderId,
        videoPath: finalVideoPath,
      });

      return renderJob;
    } catch (err: any) {
      const renderJob: RenderJob = {
        id: renderId,
        scriptId: script.id,
        templateType,
        videoPath: finalVideoPath,
        durationSeconds: 0,
        resolution: { width: 1080, height: 1920 },
        fps: 30,
        renderedAt: new Date().toISOString(),
        status: 'FAILED',
        error: err.message || 'Unknown render failure',
      };
      await this.repo.saveRender(renderJob);
      throw err;
    }
  }
}
