import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError, cacheDir, edgeDetail, runFfmpeg, sha256File } from '@shorts/core';
import { MockAssetProvider, type AssetProvider } from '@shorts/providers';
import { VisualDirectorAgent } from '@shorts/agents';
import type { ShortScript, Timeline } from '@shorts/schemas';
import { testConfig } from './helpers.js';

const script: ShortScript = {
  id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Visual test title', description: '', hookText: 'Hook here.',
  targetDurationSeconds: 45, totalWords: 10, generationAttempts: 1, format: 'STORY', createdAt: new Date().toISOString(),
  scenes: [1, 2, 3].map((n) => ({ sceneNumber: n, narration: 'Some narration.', visualObjective: 'Birds in a field', mediaFormat: 'LICENSED_STOCK' as const, visualSubject: n === 2 ? 'scattered emus' : 'steel footbridge over river', visualExclusions: [], assetKeywords: n === 2 ? ['scattered emus', 'retreating soldiers'] : ['bridge', 'river'], transitionIntent: 'CUT' as const, claimIds: [], beats: [] })),
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
  search: AssetProvider['search'] = async (req) => (/emu|soldier/.test(req.query) ? [] : this.inner.search(req));
  download: AssetProvider['download'] = (c, d) => this.inner.download(c, d);
}

describe('VisualDirectorAgent', () => {
  const cfg = testConfig();
  const opts = { mediaCacheDir: cacheDir(cfg.outputDir, 'media'), minRelevance: 0.3, maxDownloadBytes: 1e9 };

  it('when a scene has no fitting footage, uses the main subject of the Short as b-roll and flags it for human review', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'v1-'));
    const { assets } = await new VisualDirectorAgent(new SparseLibrary(), opts).collectAssets(script, timeline, dir);
    const s2 = assets.find((a) => a.sceneNumber === 2)!;
    expect(s2.visualValidation?.decision).toBe('NEEDS_REVIEW');
    expect(s2.ranking.matchedTerms.join()).toMatch(/bridge/);
  });

  it('fails closed when no footage exists at all', async () => {
    const dir = fs.mkdtempSync(path.join(cfg.outputDir, 'v1b-'));
    await expect(new VisualDirectorAgent(new MockAssetProvider({ empty: true }), opts).collectAssets(script, timeline, dir)).rejects.toBeInstanceOf(ValidationError);
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

// -----------------------------------------------------------------------------
describe('the shot is judged on the segment it actually uses', () => {
  it('edge detail separates an empty backdrop from real footage', () => {
    const w = 64, h = 36;
    const smooth = Buffer.alloc(w * h * 3);
    const busy = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      smooth.fill(150 + Math.round((40 * x) / w), i, i + 3);
      busy.fill((x * 37 + y * 91) % 256, i, i + 3);
    }
    expect(edgeDetail(smooth, w, h)).toBeLessThan(1);
    expect(edgeDetail(busy, w, h)).toBeGreaterThan(10);
  });

  it('rejects a clip whose used opening is an empty backdrop (regression: 2 s grey shot from a "falling banknotes" clip)', async () => {
    const one = { ...script, scenes: [script.scenes[0]] };
    const tl: Timeline = { ...timeline, narrationDurationSeconds: 2, totalDurationSeconds: 2, totalFrames: 60, scenes: [{ ...timeline.scenes[0], end: 2 }], shots: [{ sceneNumber: 1, shotIndex: 0, start: 0, end: 2 }] };
    class EmptyOpening implements AssetProvider {
      readonly name = 'mock-stock';
      private inner = new MockAssetProvider();
      constructor(private readonly onlyEmpty: boolean) {}
      search: AssetProvider['search'] = async (req) => {
        if (req.mediaType !== 'VIDEO') return [];
        const [a, b2] = await this.inner.search(req);
        const empty = { ...a, providerMediaId: `emptyopen${req.query.length}`, durationSeconds: 6 };
        return this.onlyEmpty ? [empty] : [empty, { ...b2, providerMediaId: `good${req.query.length}` }];
      };
      download: AssetProvider['download'] = async (c, d) => {
        if (!c.providerMediaId.startsWith('emptyopen')) return this.inner.download(c, d);
        // 3 s of a smooth grey gradient (luma std > blank threshold), then real detail.
        await runFfmpeg([
          '-y', '-f', 'lavfi', '-i', `color=c=gray:s=${c.width}x${c.height}:r=30:d=3,format=yuv420p,geq=lum='110+60*X/W':cb=128:cr=128`,
          '-f', 'lavfi', '-i', `testsrc2=size=${c.width}x${c.height}:rate=30:duration=3`,
          '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', d,
        ], { description: 'empty-opening clip' });
        return { path: d, bytes: fs.statSync(d).size, sha256: await sha256File(d), contentType: 'video/mp4' };
      };
    }
    const cfg = testConfig();
    const o = { mediaCacheDir: path.join(cacheDir(cfg.outputDir, 'media'), `empty-${randomUUID()}`), minRelevance: 0.1, maxDownloadBytes: 1e9 };
    const ok = await new VisualDirectorAgent(new EmptyOpening(false), o).collectAssets(one, tl, path.join(cfg.outputDir, `vis-${randomUUID()}`));
    expect(ok.assets[0].providerAssetId).toMatch(/^good/);
    await expect(new VisualDirectorAgent(new EmptyOpening(true), { ...o, mediaCacheDir: path.join(cacheDir(cfg.outputDir, 'media'), `empty-${randomUUID()}`) }).collectAssets(one, tl, path.join(cfg.outputDir, `vis-${randomUUID()}`))).rejects.toThrow(ValidationError);
  }, 120_000);
});
