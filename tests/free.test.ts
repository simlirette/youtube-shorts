/**
 * $0 workflow: free-tier guards for Gemini and Tavily, and the Blender graphics path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { QuotaExceededError, RollingMinuteLimiter, UsageBudget, periodKey } from '@shorts/core';
import { GeminiLLMProvider, TavilySearchProvider, type ProviderCallReport } from '@shorts/providers';

const tmpFile = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'free-')), name);

describe('free-tier usage budgets', () => {
  it('periods reset in the provider time zone (Gemini: Pacific day; Tavily: UTC month)', () => {
    const d = new Date('2026-10-11T05:30:00Z'); // 22:30 on Oct 10 in Los Angeles
    expect(periodKey(d, 'day', 'America/Los_Angeles')).toBe('2026-10-10');
    expect(periodKey(d, 'day', 'UTC')).toBe('2026-10-11');
    expect(periodKey(d, 'month', 'UTC')).toBe('2026-10');
  });

  it('refuses the call that would exceed the budget, records nothing for it, and resets next period', () => {
    let now = new Date('2026-10-10T12:00:00Z');
    const file = tmpFile('usage.json');
    const b = new UsageBudget({ file, provider: 'tavily', limit: 3, period: 'month', timeZone: 'UTC', unit: 'credits', now: () => now });
    b.reserve(2);
    expect(() => b.reserve(2)).toThrow(QuotaExceededError);
    expect(b.used()).toBe(2);
    b.reserve(1);
    expect(b.remaining()).toBe(0);
    // A second budget object (another process) sees the same counter.
    expect(() => new UsageBudget({ file, provider: 'tavily', limit: 3, period: 'month', timeZone: 'UTC', unit: 'credits', now: () => now }).reserve(1)).toThrow(/free-tier budget reached: 3\/3 credits/);
    now = new Date('2026-11-01T00:00:01Z');
    expect(b.used()).toBe(0);
    b.reserve(3);
  });

  it('the per-minute limiter waits instead of failing', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const l = new RollingMinuteLimiter(2, () => t, async (ms) => { sleeps.push(ms); t += ms; });
    expect(await l.acquire()).toBe(0);
    t += 1000;
    expect(await l.acquire()).toBe(0);
    expect(await l.acquire()).toBe(59_050);
  });
});

describe('Gemini on the free tier', () => {
  const ok = (text: string) =>
    new Response(JSON.stringify({ modelVersion: 'gemini-2.5-flash', candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('records $0, turns thinking off on Flash, and stops at the daily request budget before calling Google', async () => {
    const bodies: any[] = [];
    const reports: ProviderCallReport[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return ok('{"a":1}');
    }) as typeof fetch;
    const g = new GeminiLLMProvider('k', 'gemini-2.5-flash', { timeoutMs: 5000, maxAttempts: 1, thinkingBudget: 0, freeTier: { rpm: 100, rpd: 2, budgetFile: tmpFile('u.json') } }, { fetchImpl, observer: (r) => reports.push(r) });
    const req = { task: 't', system: 's', prompt: 'p', schemaHint: '{}', schema: z.object({ a: z.number() }) };
    const r = await g.generateStructured(req);
    expect(r.usage.estimatedCostUsd).toBe(0);
    expect(reports[0].costUsd).toBe(0);
    expect(bodies[0].generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    await g.generateStructured(req);
    await expect(g.generateStructured(req)).rejects.toMatchObject({ kind: 'QUOTA_EXCEEDED' });
    expect(bodies).toHaveLength(2);
  });

  it('a paid Gemini key still records the list-price estimate', async () => {
    const fetchImpl = (async () => ok('{"a":1}')) as unknown as typeof fetch;
    const g = new GeminiLLMProvider('k', 'gemini-2.5-flash', { timeoutMs: 5000, maxAttempts: 1 }, { fetchImpl });
    const r = await g.generateStructured({ task: 't', system: 's', prompt: 'p', schemaHint: '{}', schema: z.object({ a: z.number() }) });
    expect(r.usage.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe('Tavily on the free plan', () => {
  it('counts credits per search depth and refuses before exceeding the monthly credits', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://example.org/a', content: 'c' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const t = new TavilySearchProvider('k', { timeoutMs: 5000, maxAttempts: 1, searchDepth: 'basic', usdPerCredit: 0, monthlyCredits: { limit: 2, budgetFile: tmpFile('u.json') } }, { fetchImpl });
    await t.search('q1', { maxResults: 3, includeRawContent: false });
    await t.search('q2', { maxResults: 3, includeRawContent: false });
    await expect(t.search('q3', { maxResults: 3, includeRawContent: false })).rejects.toMatchObject({ kind: 'QUOTA_EXCEEDED' });
    expect(calls).toBe(2);
  });
});

// -----------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import { createProviders } from '@shorts/providers';
import { PipelineRunner } from '@shorts/pipeline';
import { BlenderGraphicRenderer, findBlender } from '@shorts/rendering';
import { numbersIn, validateGraphic } from '@shorts/agents';
import { summarizeMedia } from '@shorts/core';
import { memoryRepo, testConfig } from './helpers.js';

describe('generated graphics may only restate the narration', () => {
  const scene = 'Over 617,000 U.S. bridges carry traffic. Forty-two percent of them are deficient or obsolete.';
  it('accepts numbers spoken in the beat and words from the scene', () => {
    expect(numbersIn('617,000 and 1.5 and 42%')).toEqual(['617000', '1.5', '42']);
    expect(validateGraphic({ template: 'stat', value: '617,000', label: 'U.S. bridges' }, 'Over 617,000 U.S. bridges carry traffic.', scene)).toEqual([]);
    expect(validateGraphic({ template: 'process', steps: ['Bridges carry traffic', 'Deficient'] }, 'Over 617,000 U.S. bridges carry traffic.', scene)).toEqual([]);
  });
  it('rejects invented numbers, numbers from another clause, invented words and inconsistent bars', () => {
    expect(validateGraphic({ template: 'stat', value: '700,000', label: 'bridges' }, 'Over 617,000 U.S. bridges carry traffic.', scene).join()).toMatch(/shows "700000"/);
    expect(validateGraphic({ template: 'stat', value: '617,000', label: 'bridges' }, 'Forty-two percent of them are deficient.', scene).join()).toMatch(/does not say/);
    expect(validateGraphic({ template: 'keyword', text: 'Collapse risk' }, 'deficient or obsolete', scene).join()).toMatch(/not in the narration: "collapse", "risk"/);
    expect(validateGraphic({ template: 'compare', items: [{ label: 'bridges', value: 9, display: '617,000' }, { label: 'traffic', value: 1, display: '1' }] }, 'Over 617,000 U.S. bridges carry traffic, 1 by 1.', scene).join()).toMatch(/bar value 9 does not match/);
    expect(validateGraphic({ template: 'stat', value: 'many', label: 'bridges' }, 'Over 617,000 U.S. bridges carry traffic.', scene).join()).toMatch(/needs a number/);
  });
});

describe('pipeline with graphics (mock mode)', () => {
  it('renders the graphic beat locally, skips stock and vision for it, and content QA re-verifies its text', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'auto', APPROVAL_FINAL: 'manual' });
    const repo = await memoryRepo(cfg);
    const runner = new PipelineRunner(cfg, repo, createProviders(cfg, 'mock'));
    const job = await runner.createJob();
    const done = await runner.run(job.id);
    expect(done.state).toBe('AWAITING_FINAL_APPROVAL');
    const report = (await runner.report(job.id)) as any;
    const graphics = report.media.filter((m: any) => m.provider === 'blender');
    expect(graphics.length).toBe(1);
    expect(report.qa.checks.some((c: string) => /^PASS media\.generatedGraphics/.test(c))).toBe(true);
    // No vision verdict is claimed for it: it is accepted on deterministic checks only.
    expect(graphics[0]).toMatchObject({ visual: { decision: 'ACCEPTED', semantic: null, defects: [] } });
    // Disabled: no graphic is planned and every shot is stock footage.
    const off = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'auto', GRAPHICS_ENABLED: 'false' });
    const r2 = new PipelineRunner(off, await memoryRepo(off), createProviders(off, 'mock'));
    const j2 = await r2.createJob();
    await r2.run(j2.id);
    expect(((await r2.report(j2.id)) as any).media.every((m: any) => m.provider !== 'blender')).toBe(true);
  }, 600_000);
});

const blender = findBlender(process.env.BLENDER_PATH);
describe.skipIf(!blender)('Blender renderer (real Blender, local)', () => {
  it('renders a stat card to a 1080x1920 H.264 clip of the requested length and caches it', async () => {
    const r = new BlenderGraphicRenderer({ blenderPath: blender!, fontFile: path.resolve(__dirname, '../assets/fonts/Anton-Regular.ttf'), cacheDir: path.join(os.tmpdir(), `graphics-${randomUUID()}`) });
    const out = tmpFile('stat.mp4');
    await r.render({ template: 'stat', value: '617,000', label: 'U.S. bridges' }, 1.0, out);
    const s = await summarizeMedia(out);
    expect(s.video).toMatchObject({ codec: 'h264', width: 1080, height: 1920 });
    expect(s.durationSeconds).toBeCloseTo(1.0, 1);
    const t0 = Date.now();
    await r.render({ template: 'stat', value: '617,000', label: 'U.S. bridges' }, 1.0, tmpFile('again.mp4'));
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 300_000);
});
