import fs from 'node:fs';
import path from 'node:path';
import { WordTimestamp, Scene } from '@shorts/schemas';

export class CaptionGenerator {
  /**
   * Formats seconds into SRT timestamp string: HH:MM:SS,mmm
   */
  static formatSrtTime(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const milliseconds = Math.floor((totalSeconds % 1) * 1000);

    const pad = (n: number, z = 2) => String(n).padStart(z, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`;
  }

  /**
   * Generates standard SRT subtitle file from scene script or word timestamps
   */
  static generateSrtFromScenes(scenes: Scene[], outputPath: string): string {
    const outDir = path.dirname(path.resolve(outputPath));
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    let srtContent = '';
    let counter = 1;

    for (const scene of scenes) {
      // Chunk scene narration into small 4-6 word readable chunks
      const words = scene.narration.trim().split(/\s+/);
      const chunkSize = 5;
      const durationPerWord = scene.durationSeconds / Math.max(1, words.length);

      for (let i = 0; i < words.length; i += chunkSize) {
        const chunkWords = words.slice(i, i + chunkSize);
        const chunkStart = scene.startTime + i * durationPerWord;
        const chunkEnd = Math.min(scene.endTime, scene.startTime + (i + chunkWords.length) * durationPerWord);

        srtContent += `${counter++}\n`;
        srtContent += `${this.formatSrtTime(chunkStart)} --> ${this.formatSrtTime(chunkEnd)}\n`;
        srtContent += `${chunkWords.join(' ')}\n\n`;
      }
    }

    fs.writeFileSync(outputPath, srtContent, 'utf-8');
    return outputPath;
  }

  /**
   * Generates ASS subtitle file with mobile-friendly vertical layout and styling
   */
  static generateAssFromScenes(scenes: Scene[], outputPath: string): string {
    const outDir = path.dirname(path.resolve(outputPath));
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const formatAssTime = (totalSeconds: number): string => {
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = Math.floor(totalSeconds % 60);
      const centiseconds = Math.floor(((totalSeconds % 1) * 100));
      const pad = (n: number, z = 2) => String(n).padStart(z, '0');
      return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
    };

    let assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,4,2,2,80,80,380,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    for (const scene of scenes) {
      const words = scene.narration.trim().split(/\s+/);
      const chunkSize = 5;
      const durationPerWord = scene.durationSeconds / Math.max(1, words.length);

      for (let i = 0; i < words.length; i += chunkSize) {
        const chunkWords = words.slice(i, i + chunkSize);
        const chunkStart = scene.startTime + i * durationPerWord;
        const chunkEnd = Math.min(scene.endTime, scene.startTime + (i + chunkWords.length) * durationPerWord);
        const text = chunkWords.join(' ').toUpperCase();

        assContent += `Dialogue: 0,${formatAssTime(chunkStart)},${formatAssTime(chunkEnd)},Default,,0,0,0,,${text}\n`;
      }
    }

    fs.writeFileSync(outputPath, assContent, 'utf-8');
    return outputPath;
  }
}
