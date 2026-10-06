import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError, cacheDir } from '@shorts/core';
import { MockAssetProvider, type AssetProvider } from '@shorts/providers';
import { VisualDirectorAgent } from '@shorts/agents';
import type { ShortScript, Timeline } from '@shorts/schemas';
import { testConfig } from './helpers.js';

const script: ShortScript = {
  id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Visual test title', description: '', hookText: 'Hook here.',
  targetDurationSeconds: 45, totalWords: 10, generationAttempts: 1, createdAt: new Date().toISOString(),
  scenes: [1, 2, 3].map((n) => ({ sceneNumber: n, narration: 'Some narration.', visualObjective: 'Birds in a field', mediaFormat: 'LICENSED_STOCK' as const, assetKeywords: n === 2 ? ['scattered emus', 'retreating soldiers'] : ['bridge', 'river'], transitionIntent: 'CUT' as const, claimIds: [] })),
};
const timeline: Timeline = {
  fps: 30, narrationDurationSeconds: 9, totalDurationSeconds: 9, totalFrames: 270,
  scenes: [0, 1, 2].map((i) => ({ sceneNumber: i + 1, start: i * 3, end: i * 3 + 3, firstWordIndex: i, lastWordIndex: i })),
  shots: [0, 1, 2].map((i) => ({ sceneNumber: i + 1, shotIndex: 0, start: i * 3, end: i * 3 + 3 })),
  captions: [{ index: 0, sceneNumber: 1, start: 0, end: 1, lines: ['X'], firstWordIndex: 0, lastWordIndex: 0 }],
};

/** Stock library that has nothing for the over-specific scene-2 keywords. */
class SparseLibrary implements AssetProvider {
  readonly name = 'mock-stock';
  private inner = new MockAssetProvider();
  search: AssetProvider['search'] = async (req) => (/emus|soldiers/.test(req.query) ? [] : this.inner.search(req));
  download: AssetProvider['download'] = (c, d) => this.inner.download(c, d);
}

describe('VisualDirectorAgent', () => {
  const cfg = testConfig();
  const opts = { mediaCacheDir: cacheDir(cfg.outputDir, 'media'), minRelevance: 0.3, maxDownloadBytes: 1e9 };

  it('fails closed when no media fits and no refinement is available', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'v1-'));
    await expect(new VisualDirectorAgent(new SparseLibrary(), opts).collectAssets(script, timeline, dir)).rejects.toBeInstanceOf(ValidationError);
  });

  it('retries a scene once with refined keywords and records them as the relevance basis', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'v2-'));
    let refineCalls = 0;
    const { assets } = await new VisualDirectorAgent(new SparseLibrary(), opts, async () => (refineCalls++, ['open field', 'birds'])).collectAssets(script, timeline, dir);
    expect(refineCalls).toBe(1);
    expect(assets).toHaveLength(3);
    const s2 = assets.find((a) => a.sceneNumber === 2)!;
    expect(s2.ranking.matchedTerms.join()).toMatch(/open field|birds/);
    expect(new Set(assets.map((a) => a.providerAssetId)).size).toBe(3);
  }, 120_000);
});

describe('media fit filters', () => {
  const cfg = testConfig();
  const opts = { mediaCacheDir: cacheDir(cfg.outputDir, 'media'), minRelevance: 0.3, maxDownloadBytes: 1e9 };

  it('never selects production assets such as green-screen plates', async () => {
    const { rankCandidate } = await import('@shorts/agents');
    const c = { provider: 'pixabay', providerMediaId: '1', mediaType: 'VIDEO' as const, pageUrl: 'https://pixabay.com/x', downloadUrl: 'https://cdn.pixabay.com/x.mp4', width: 1080, height: 1920, aspectRatio: 0.5625, durationSeconds: 10, tags: ['meteorite', 'green screen', 'rock'], description: '', license: 'Pixabay', commercialUseAllowed: true, attributionRequired: false };
    const r = rankCandidate(c, { keywords: ['meteorite'], sceneDurationSeconds: 5, usedMediaKeys: new Set(), minRelevance: 0.3, maxBytes: 1e9 });
    expect(r).toMatchObject({ ok: false });
  });

  it('only downloads candidates the visual-fit judge approves, and fails closed if it approves none', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'judge-'));
    let judged = 0;
    const rejectAll = async () => (judged++, new Set<string>());
    await expect(new VisualDirectorAgent(new MockAssetProvider(), opts, undefined, rejectAll).collectAssets(script, timeline, dir)).rejects.toThrow(/visual-fit judge rejected/);
    expect(judged).toBeGreaterThan(0);
    const approveOne = async (_s: unknown, cands: Array<{ key: string }>) => new Set([cands[cands.length - 1].key]);
    const { assets } = await new VisualDirectorAgent(new MockAssetProvider(), opts, async () => ['bridge', 'river'], approveOne as never).collectAssets(script, timeline, dir);
    expect(assets).toHaveLength(3);
  }, 120_000);

  it('merges a later shot into the previous one when no further distinct media fits, but never empties a scene', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'merge-'));
    const twoShots: Timeline = {
      ...timeline,
      shots: [
        { sceneNumber: 1, shotIndex: 0, start: 0, end: 1.5 },
        { sceneNumber: 1, shotIndex: 1, start: 1.5, end: 3 },
        { sceneNumber: 2, shotIndex: 0, start: 3, end: 6 },
        { sceneNumber: 3, shotIndex: 0, start: 6, end: 9 },
      ],
    };
    // Judge approves the top candidate, except for scene 1 shot 1 (2nd and 3rd calls: video and image passes).
    let call = 0;
    const judge = async (_s: unknown, cands: Array<{ key: string }>) => {
      call++;
      return call === 2 || call === 3 ? new Set<string>() : new Set([cands[0].key]);
    };
    const res = await new VisualDirectorAgent(new MockAssetProvider(), opts, undefined, judge as never).collectAssets(script, twoShots, dir);
    expect(res.shots).toHaveLength(3);
    expect(res.assets).toHaveLength(res.shots.length);
    for (const sceneNumber of [1, 2, 3]) expect(res.shots.some((s) => s.sceneNumber === sceneNumber)).toBe(true);
    const s1 = res.shots.filter((s) => s.sceneNumber === 1);
    expect(s1[0].start).toBe(0);
    expect(s1[s1.length - 1].end).toBe(3);
  }, 120_000);
});
