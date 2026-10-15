import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AssetDescriptor, QAReport, ShortScript, Timeline, VoiceNarration } from '@shorts/schemas';
import { InternalError, InvalidResponseError, ValidationError, cacheDir, runFfmpeg, summarizeMedia } from '@shorts/core';
import { MockAssetProvider, MockTTSProvider } from '@shorts/providers';
import { VisualDirectorAgent, VoiceAgent } from '@shorts/agents';
import { CAPTION_LAYOUT, VideoRenderer, buildAss, buildTimeline, evaluateMedia, layoutLines, measureCaptionBoxes } from '@shorts/rendering';
import { testConfig } from './helpers.js';

const cfg = testConfig();
const FONT = path.resolve(__dirname, '../assets/fonts/Anton-Regular.ttf');
const limits = { minSeconds: 5, maxSeconds: 60, targetLufs: -14, toleranceLu: 2 };

const script: ShortScript = {
  id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Test Short Title', description: 'd', hookText: 'Why did it sway?',
  targetDurationSeconds: 45, totalWords: 0, generationAttempts: 1, format: 'STORY', createdAt: new Date().toISOString(),
  scenes: [
    'Why did it sway?',
    'The bridge opened in June and thousands of people crossed it on the very first day of operation.',
    'Within two days engineers closed it again, because the deck moved sideways under the crowd in a way nobody expected.',
  ].map((narration, i) => ({ sceneNumber: i + 1, narration, visualObjective: 'bridge', mediaFormat: 'LICENSED_STOCK' as const, visualSubject: 'steel footbridge over river', visualExclusions: [], assetKeywords: ['bridge', 'river'], transitionIntent: 'CUT' as const, claimIds: [], beats: [] })),
};
script.totalWords = script.scenes.reduce((n, s) => n + s.narration.split(/\s+/).length, 0);

const check = (r: QAReport, id: string) => r.checks.find((c) => c.id === id);
const voiceOpts = (dir: string) => ({ targetLufs: -14, toleranceLu: 2, minSeconds: 5, maxSeconds: 60, tailSeconds: 0.6, ttsCacheDir: path.join(dir, 'tts') });

let workDir: string;
let narration: VoiceNarration;
let timeline: Timeline;
let assets: AssetDescriptor[];
let renderDir: string;
let finalPath: string;
let goodReport: QAReport;

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(cfg.outputDir, 'media-'));
  narration = await new VoiceAgent(new MockTTSProvider(), voiceOpts(workDir)).generateVoiceover(script, path.join(workDir, 'audio'));
  timeline = buildTimeline(script, narration, { fps: 30, tailSeconds: 0.6, maxShotSeconds: 3 });
  ({ assets } = await new VisualDirectorAgent(new MockAssetProvider(), { mediaCacheDir: cacheDir(cfg.outputDir, 'media'), minRelevance: 0.3, maxDownloadBytes: 1e9 }).collectAssets(script, timeline, path.join(workDir, 'media')));
  renderDir = path.join(workDir, 'render');
  const out = await new VideoRenderer().render({ script, timeline, narration, assets, renderDir, fontFile: FONT });
  finalPath = out.render.videoPath;
  goodReport = await evaluateMedia({ videoPath: finalPath, uncaptionedPath: out.uncaptionedPath, narration, timeline, renderDir, limits });
}, 300_000);

describe('timeline from real narration timing', () => {
  // Regression 4: the video length comes from the narration, never from a words-per-second estimate.
  it('covers the full narration plus tail, with contiguous scenes containing their words', () => {
    const last = narration.wordTimestamps[narration.wordTimestamps.length - 1];
    expect(timeline.totalDurationSeconds).toBeGreaterThanOrEqual(last.end + 0.6 - 1 / 30);
    expect(timeline.scenes[0].start).toBe(0);
    for (let i = 1; i < timeline.scenes.length; i++) expect(timeline.scenes[i].start).toBe(timeline.scenes[i - 1].end);
    for (const s of timeline.scenes) {
      expect(narration.wordTimestamps[s.firstWordIndex].start).toBeGreaterThanOrEqual(s.start);
      expect(narration.wordTimestamps[s.lastWordIndex].end).toBeLessThanOrEqual(s.end);
    }
    // the length is the measured narration, not a words-per-second estimate
    expect(timeline.narrationDurationSeconds).toBe(narration.durationSeconds);
  });

  it('splits long scenes into shots of at most the configured length', () => {
    for (const sh of timeline.shots) expect(sh.end - sh.start).toBeLessThanOrEqual(3 + 1e-9);
    expect(timeline.shots.length).toBeGreaterThan(timeline.scenes.length);
  });

  it('caption cues start exactly when their first word is spoken and cover every word once', () => {
    let next = 0;
    for (const c of timeline.captions) {
      expect(c.firstWordIndex).toBe(next);
      expect(c.start).toBeCloseTo(narration.wordTimestamps[c.firstWordIndex].start, 5);
      next = c.lastWordIndex + 1;
    }
    expect(next).toBe(narration.wordTimestamps.length);
  });

  it('refuses narration whose words do not match the script', () => {
    const bad = { ...narration, wordTimestamps: narration.wordTimestamps.map((w, i) => (i === 3 ? { ...w, word: 'DIFFERENT' } : w)) };
    expect(() => buildTimeline(script, bad, { fps: 30, tailSeconds: 0.6 })).toThrow(InternalError);
  });
});

describe('caption layout', () => {
  it('breaks lines within the character budget and uses the real 1080x1920 coordinate system', () => {
    const lines = layoutLines(['NONREPEATING', 'ATOMIC', 'PATTERNS', 'EVERYWHERE'], CAPTION_LAYOUT);
    expect(lines.every((l) => l.length <= CAPTION_LAYOUT.maxCharsPerLine)).toBe(true);
    const ass = buildAss(timeline.captions);
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('WrapStyle: 2');
  });

  it('compresses a single over-long word instead of letting it overflow', () => {
    const ass = buildAss([{ index: 0, sceneNumber: 1, start: 0, end: 1, lines: ['INTERNATIONALIZATIONS'], firstWordIndex: 0, lastWordIndex: 0 }]);
    expect(ass).toMatch(/\{\\fscx\d+\}INTERNATIONALIZATIONS/);
  });
});

describe('render + objective media QA (happy path)', () => {
  it('produces a valid 1080x1920 30fps H.264/AAC Short that passes every media check', async () => {
    const s = await summarizeMedia(finalPath);
    expect(s.video).toMatchObject({ codec: 'h264', width: 1080, height: 1920 });
    expect(s.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    const failing = goodReport.checks.filter((c) => c.status !== 'PASS');
    expect(failing).toEqual([]);
    expect(goodReport.publishEligible).toBe(true);
  });

  // Regression 3: mock stock clips carry a loud stereo 880 Hz track; the final audio must be the narration.
  it('final audio is the narration even though every stock clip has its own audio track', async () => {
    expect(assets.every((a) => a.probe.hasAudio)).toBe(true);
    const c = check(goodReport, 'audio.isNarration')!;
    expect(c.status).toBe('PASS');
    expect(c.measured as number).toBeGreaterThan(0.9);
  });

  // Regression 5: captions are measured on rendered frames and must sit inside the safe zone.
  it('captions render inside the safe zone and are burned into the final video', () => {
    expect(check(goodReport, 'captions.layout')!.status).toBe('PASS');
    expect(check(goodReport, 'captions.burnedIn')!.status).toBe('PASS');
  });
});

describe('media QA failure detection', () => {
  // Regression 2: silent narration must FAIL (previously reported as WARN and passed).
  it('a silent Short fails QA', async () => {
    const dir = path.join(workDir, 'silent');
    fs.mkdirSync(dir, { recursive: true });
    const silentWav = path.join(dir, 'silent.wav');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${narration.durationSeconds}`, '-c:a', 'pcm_s16le', silentWav]);
    const silentNarration = { ...narration, audioPath: silentWav };
    const rd = path.join(dir, 'render');
    const out = await new VideoRenderer().render({ script, timeline, narration: silentNarration, assets, renderDir: rd, fontFile: FONT });
    const r = await evaluateMedia({ videoPath: out.render.videoPath, uncaptionedPath: out.uncaptionedPath, narration, timeline, renderDir: rd, limits });
    expect(r.overallStatus).toBe('FAIL');
    expect(r.publishEligible).toBe(false);
    expect(check(r, 'audio.notSilent')!.status).toBe('FAIL');
    expect(check(r, 'audio.isNarration')!.status).toBe('FAIL');
  }, 300_000);

  it('a video without an audio stream fails QA', async () => {
    const noAudio = path.join(workDir, 'noaudio.mp4');
    await runFfmpeg(['-y', '-i', finalPath, '-an', '-c:v', 'copy', noAudio]);
    const r = await evaluateMedia({ videoPath: noAudio, narration, timeline, renderDir, limits });
    expect(check(r, 'audio.streams')!.status).toBe('FAIL');
    expect(r.publishEligible).toBe(false);
  });

  it('a malformed / truncated MP4 fails QA', async () => {
    const broken = path.join(workDir, 'broken.mp4');
    fs.writeFileSync(broken, fs.readFileSync(finalPath).subarray(0, 50_000));
    const r = await evaluateMedia({ videoPath: broken, narration, timeline, renderDir, limits });
    expect(r.overallStatus).toBe('FAIL');
    expect(r.publishEligible).toBe(false);
  });

  it('a video cut before the narration ends fails the truncation check', async () => {
    const cut = path.join(workDir, 'cut.mp4');
    await runFfmpeg(['-y', '-i', finalPath, '-t', String(narration.durationSeconds - 2), '-c', 'copy', cut]);
    const r = await evaluateMedia({ videoPath: cut, narration, timeline, renderDir, limits });
    expect(check(r, 'sync.narrationComplete')!.status).toBe('FAIL');
  });

  // Regression 5 (failure side): captions placed outside the safe zone are detected on rendered pixels.
  it('detects captions rendered outside the safe zone', async () => {
    const dir = path.join(workDir, 'badcaptions');
    fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
    fs.copyFileSync(FONT, path.join(dir, 'fonts', path.basename(FONT)));
    fs.writeFileSync(path.join(dir, 'captions.ass'), buildAss(timeline.captions, { ...CAPTION_LAYOUT, marginV: 1750 }));
    const boxes = await measureCaptionBoxes(dir, timeline);
    const z = CAPTION_LAYOUT.safeZone;
    expect(boxes.some((b) => b.box && b.box.y1 < z.top)).toBe(true);
    const r = await evaluateMedia({ videoPath: finalPath, uncaptionedPath: undefined, narration, timeline, renderDir: dir, limits });
    expect(check(r, 'captions.layout')!.status).toBe('FAIL');
  });
});

describe('narration validation (TTS)', () => {
  it('rejects silent TTS output', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'silent-tts-'));
    await expect(new VoiceAgent(new MockTTSProvider({ silent: true }), voiceOpts(dir)).generateVoiceover(script, path.join(dir, 'audio'))).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects TTS output without timing alignment (no fabricated timestamps)', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'noalign-'));
    await expect(new VoiceAgent(new MockTTSProvider({ omitAlignment: true }), voiceOpts(dir)).generateVoiceover(script, path.join(dir, 'audio'))).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('rejects audio that ends before the last aligned word (truncated TTS)', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'trunc-'));
    await expect(new VoiceAgent(new MockTTSProvider({ truncateAudioToSeconds: 4 }), voiceOpts(dir)).generateVoiceover(script, path.join(dir, 'audio'))).rejects.toThrow(/truncated/);
  });

  it('reuses cached TTS for identical text (no repeat provider call)', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'cache-'));
    let calls = 0;
    const tts = new MockTTSProvider();
    const counting = { ...tts, name: tts.name, voiceId: tts.voiceId, modelId: tts.modelId, settingsKey: tts.settingsKey, synthesize: (r: { text: string }) => (calls++, tts.synthesize(r)) };
    const agent = new VoiceAgent(counting, voiceOpts(dir));
    await agent.generateVoiceover(script, path.join(dir, 'a1'));
    await agent.generateVoiceover(script, path.join(dir, 'a2'));
    expect(calls).toBe(1);
  });
});

describe('color range (regression: full-range JPEG source leaked yuvj420p into the final video)', () => {
  it('renders full-range still images as limited-range yuv420p BT.709', async () => {
    const dir = path.join(workDir, 'jpeg');
    fs.mkdirSync(dir, { recursive: true });
    const jpg = path.join(dir, 'still.jpg');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=1', '-frames:v', '1', '-pix_fmt', 'yuvj420p', jpg]);
    const src = await summarizeMedia(jpg);
    expect(src.video?.pixFmt).toBe('yuvj420p');
    const imageAssets = assets.map((a) => ({ ...a, assetType: 'IMAGE' as const, localPath: jpg, probe: { ...a.probe, videoCodec: 'mjpeg', width: 720, height: 1280, durationSeconds: 0, hasAudio: false } }));
    const out = await new VideoRenderer().render({ script, timeline, narration, assets: imageAssets, renderDir: path.join(dir, 'render'), fontFile: FONT });
    const s = await summarizeMedia(out.render.videoPath);
    expect(s.video?.pixFmt).toBe('yuv420p');
    const r = await evaluateMedia({ videoPath: out.render.videoPath, uncaptionedPath: out.uncaptionedPath, narration, timeline, renderDir: path.join(dir, 'render'), limits });
    expect(check(r, 'video.pixfmt')!.status).toBe('PASS');
  }, 300_000);
});

describe('speech gap classification (regression: trailing alignment padding flagged as a gap)', () => {
  const words = [{ start: 0.2, end: 0.6 }, { start: 0.7, end: 10 }, { start: 50.306, end: 51.455 }];
  it('accepts trailing silence after the last word has audibly started', async () => {
    const { classifySilences } = await import('@shorts/rendering');
    expect(classifySilences([{ start: 50.76, end: 52.07 }], words)).toEqual([]);
  });
  it('flags interior gaps and a missing final word', async () => {
    const { classifySilences } = await import('@shorts/rendering');
    expect(classifySilences([{ start: 20, end: 22 }], words)[0]).toMatch(/silence during speech/);
    expect(classifySilences([{ start: 49.8, end: 52.07 }], words)[0]).toMatch(/final word/);
  });
});
