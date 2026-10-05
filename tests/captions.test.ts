import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CaptionGenerator } from '@shorts/rendering';
import { Scene } from '@shorts/schemas';

describe('CaptionGenerator', () => {
  const sampleScenes: Scene[] = [
    {
      sceneNumber: 1,
      startTime: 0,
      endTime: 8,
      durationSeconds: 8,
      narration: 'In June 2000, London opened this futuristic bridge.',
      visualObjective: 'Show bridge',
      mediaFormat: 'LICENSED_STOCK',
      assetKeywords: ['bridge'],
      transitionIntent: 'CUT',
      claimIds: [],
    },
    {
      sceneNumber: 2,
      startTime: 8,
      endTime: 16,
      durationSeconds: 8,
      narration: 'Two days later, it was shut down.',
      visualObjective: 'Show closure sign',
      mediaFormat: 'HISTORICAL_IMAGE',
      assetKeywords: ['sign'],
      transitionIntent: 'CUT',
      claimIds: [],
    },
  ];

  it('formats SRT timestamp correctly', () => {
    expect(CaptionGenerator.formatSrtTime(0)).toBe('00:00:00,000');
    expect(CaptionGenerator.formatSrtTime(65.5)).toBe('00:01:05,500');
  });

  it('generates standard SRT subtitle file', () => {
    const testSrtPath = path.resolve(process.cwd(), 'output/temp/test_captions.srt');
    CaptionGenerator.generateSrtFromScenes(sampleScenes, testSrtPath);

    expect(fs.existsSync(testSrtPath)).toBe(true);
    const content = fs.readFileSync(testSrtPath, 'utf-8');
    expect(content).toContain('-->');
    expect(content).toContain('futuristic bridge');

    // Clean up
    fs.unlinkSync(testSrtPath);
  });

  it('generates ASS subtitle file with vertical styling specs', () => {
    const testAssPath = path.resolve(process.cwd(), 'output/temp/test_captions.ass');
    CaptionGenerator.generateAssFromScenes(sampleScenes, testAssPath);

    expect(fs.existsSync(testAssPath)).toBe(true);
    const content = fs.readFileSync(testAssPath, 'utf-8');
    expect(content).toContain('[Script Info]');
    expect(content).toContain('PlayResX: 1080');
    expect(content).toContain('PlayResY: 1920');
    expect(content).toContain('Dialogue:');

    // Clean up
    fs.unlinkSync(testAssPath);
  });
});
