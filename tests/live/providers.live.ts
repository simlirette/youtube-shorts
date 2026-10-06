/**
 * REAL-PROVIDER ACCEPTANCE (incurs API cost). Run with: pnpm test:live
 * Uses credentials from .env. Nothing here is mocked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuthenticationError, loadConfig, summarizeMedia } from '@shorts/core';
import { ElevenLabsTTSProvider, OpenAILLMProvider, PixabayAssetProvider, TavilySearchProvider } from '@shorts/providers';
import { rankCandidate, validateMediaFile, wordsFromAlignment } from '@shorts/agents';

const cfg = loadConfig();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-providers-'));
const results: Record<string, unknown> = {};

describe('Pixabay (live)', () => {
  const pixabay = new PixabayAssetProvider(cfg.PIXABAY_API_KEY, { timeoutMs: 30_000, downloadTimeoutMs: 180_000, maxAttempts: 2, maxDownloadBytes: cfg.MAX_DOWNLOAD_BYTES, cacheDir: path.join(tmp, 'search') });

  it('searches, ranks for vertical suitability, downloads and validates real footage', async () => {
    const candidates = await pixabay.search({ query: 'ocean waves', mediaType: 'VIDEO' });
    expect(candidates.length).toBeGreaterThan(0);
    const ranked = candidates
      .map((c) => ({ c, r: rankCandidate(c, { keywords: ['ocean waves', 'sea'], sceneDurationSeconds: 5, usedMediaKeys: new Set(), minRelevance: 0.3, maxBytes: cfg.MAX_DOWNLOAD_BYTES }) }))
      .filter((x) => x.r.ok)
      .sort((a, b) => (b.r.ok && a.r.ok ? b.r.ranking.score - a.r.ranking.score : 0));
    expect(ranked.length).toBeGreaterThan(0);
    const best = ranked[0].c;
    const dest = path.join(tmp, `pixabay_${best.providerMediaId}.mp4`);
    const dl = await pixabay.download(best, dest);
    const v = await validateMediaFile(dest, best);
    results.pixabay = { candidates: candidates.length, eligible: ranked.length, chosen: `${best.providerMediaId} ${best.width}x${best.height} ${best.durationSeconds}s`, bytes: dl.bytes, valid: v.ok, problems: v.problems };
    expect(v.ok).toBe(true);
    expect(Math.min(v.probe!.width, v.probe!.height)).toBeGreaterThanOrEqual(720);
  });

  it('vertical image search returns portrait images', async () => {
    const imgs = await pixabay.search({ query: 'mountain', mediaType: 'IMAGE' });
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs.every((i) => i.height > i.width)).toBe(true);
  });

  it('an invalid key is an authentication error', async () => {
    const bad = new PixabayAssetProvider('invalid-key-000', { timeoutMs: 30_000, downloadTimeoutMs: 30_000, maxAttempts: 3, maxDownloadBytes: 1e6, cacheDir: path.join(tmp, 'bad') });
    await expect(bad.search({ query: 'ocean', mediaType: 'VIDEO' })).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('OpenAI (live)', () => {
  it('returns schema-validated structured output', async () => {
    const llm = new OpenAILLMProvider(cfg.OPENAI_API_KEY, cfg.OPENAI_MODEL, { timeoutMs: 60_000, maxAttempts: 2 });
    const res = await llm.generateStructured({
      task: 'acceptance',
      system: 'You answer precisely.',
      prompt: 'Return the capital of France and the number of days in a leap year.',
      schemaHint: '{"capital":"string","days":number}',
      schema: z.object({ capital: z.string(), days: z.number().int() }),
      validate: (v) => (v.days === 366 ? [] : ['days must be the number of days in a leap year']),
      maxTokens: 50,
    });
    results.openai = { content: res.content, usage: res.usage, model: res.model };
    expect(res.content.capital.toLowerCase()).toContain('paris');
    expect(res.content.days).toBe(366);
  });

  it('an invalid key is an authentication error (not retried)', async () => {
    const bad = new OpenAILLMProvider('sk-invalid-acceptance-key', cfg.OPENAI_MODEL, { timeoutMs: 30_000, maxAttempts: 3 });
    await expect(bad.generateStructured({ task: 'x', system: 's', prompt: 'p', schemaHint: '{}', schema: z.object({}) })).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('Tavily (live)', () => {
  it('returns results with page content', async () => {
    const t = new TavilySearchProvider(cfg.TAVILY_API_KEY, { timeoutMs: 60_000, maxAttempts: 2, searchDepth: 'basic', usdPerCredit: cfg.TAVILY_USD_PER_CREDIT });
    const r = await t.search('Millennium Bridge London 2000 closure', { maxResults: 3, includeRawContent: true });
    results.tavily = r.map((x) => ({ url: x.url, raw: x.rawContent?.length ?? 0 }));
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => (x.rawContent ?? '').length > 400)).toBe(true);
  });

  it('an invalid key is an authentication error', async () => {
    const t = new TavilySearchProvider('tvly-invalid-acceptance', { timeoutMs: 30_000, maxAttempts: 2, searchDepth: 'basic', usdPerCredit: 0 });
    await expect(t.search('ocean waves', { maxResults: 1, includeRawContent: false })).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('ElevenLabs (live)', () => {
  it('returns real audio with character alignment that matches the text', async () => {
    const tts = new ElevenLabsTTSProvider(cfg.ELEVENLABS_API_KEY, cfg.ELEVENLABS_VOICE_ID, cfg.ELEVENLABS_MODEL_ID, { timeoutMs: 120_000, maxAttempts: 2, usdPer1kChars: cfg.ELEVENLABS_USD_PER_1K_CHARS, speed: cfg.ELEVENLABS_SPEED });
    const text = 'Acceptance test. The bridge opened in June.';
    const r = await tts.synthesize({ text });
    const file = path.join(tmp, 'tts.mp3');
    fs.writeFileSync(file, r.audio);
    const s = await summarizeMedia(file);
    const words = wordsFromAlignment(r.alignment);
    results.elevenlabs = { bytes: r.audio.length, codec: s.audio?.codec, duration: s.audio?.durationSeconds, words: words.map((w) => w.word) };
    expect(s.audio?.codec).toBe('mp3');
    expect(words.map((w) => w.word)).toEqual(text.split(' '));
    expect(words[words.length - 1].end).toBeLessThanOrEqual((s.audio?.durationSeconds ?? 0) + 0.1);
  });

  it('an invalid key is an authentication error', async () => {
    const bad = new ElevenLabsTTSProvider('invalid-elevenlabs-key', cfg.ELEVENLABS_VOICE_ID, cfg.ELEVENLABS_MODEL_ID, { timeoutMs: 30_000, maxAttempts: 2, usdPer1kChars: 0, speed: 1 });
    await expect(bad.synthesize({ text: 'Hello there.' })).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('writes a results summary', () => {
    fs.mkdirSync(path.join(cfg.outputDir, 'acceptance'), { recursive: true });
    fs.writeFileSync(path.join(cfg.outputDir, 'acceptance', 'providers.json'), JSON.stringify(results, null, 2));
  });
});
