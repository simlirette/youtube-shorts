/**
 * Production-hardening regressions: voice/length contract, visual defect detection on real frames,
 * the YouTube upload boundary, publish-gate invariants, safe publication retry, and source hygiene.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigurationError, PublishError, QuotaExceededError, ValidationError, loadConfig, runFfmpeg } from '@shorts/core';
import { ElevenLabsTTSProvider, StructuredLLMBase, YouTubePublisher, createProviders, type ProviderBundle, type Publisher, type RawCompletion } from '@shorts/providers';
import { inspectFrames } from '@shorts/agents';
import { PipelineRunner, assertPublishable } from '@shorts/pipeline';
import { AssetDescriptorSchema, QAResultSchema, ResearchPacketSchema, ShortScriptSchema, VoiceNarrationSchema } from '@shorts/schemas';
import { jsonResponse, memoryRepo, testConfig } from './helpers.js';

const ROOT = path.resolve(__dirname, '..');

// -----------------------------------------------------------------------------
describe('voice constraint: the generation contract must fit the voice', () => {
  it('defaults to 100-118 words, derived from the slowest measured pace (2.0 w/s)', () => {
    const cfg = loadConfig({ PIPELINE_MODE: 'mock' });
    expect(cfg.SCRIPT_MIN_WORDS).toBe(100);
    expect(cfg.SCRIPT_MAX_WORDS).toBe(118);
    expect(cfg.SCRIPT_MAX_WORDS / cfg.VOICE_MIN_WORDS_PER_SECOND + 0.6).toBeLessThanOrEqual(cfg.SHORT_MAX_SECONDS - 0.4);
  });
  it('rejects a word budget the voice cannot deliver inside the Short (the old 130-word contract)', () => {
    expect(() => loadConfig({ SCRIPT_MAX_WORDS: '130' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ SCRIPT_MAX_WORDS: '130' })).toThrow(/VOICE_MIN_WORDS_PER_SECOND/);
  });
  it('allows a larger budget only when a faster voice is declared', () => {
    expect(loadConfig({ SCRIPT_MAX_WORDS: '130', VOICE_MIN_WORDS_PER_SECOND: '2.3' }).SCRIPT_MAX_WORDS).toBe(130);
  });
});

// -----------------------------------------------------------------------------
describe('visual defect detection on real decoded frames', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-frames-'));
  const W = 320;
  const H = 568;
  async function clip(name: string, args: string[]): Promise<string> {
    const out = path.join(dir, name);
    await runFfmpeg(['-y', ...args, '-t', '2', '-r', '30', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', out]);
    return out;
  }
  const inspect = (file: string) => inspectFrames(file, { width: W, height: H, durationSeconds: 2 } as never, true);

  it('a normal moving clip has no defects', async () => {
    const f = await clip('ok.mp4', ['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:d=2`]);
    expect((await inspect(f)).defects).toEqual([]);
  }, 60_000);
  it('flags green-screen plates', async () => {
    const f = await clip('green.mp4', ['-f', 'lavfi', '-i', `color=c=0x10E020:s=${W}x${H}:d=2`]);
    expect((await inspect(f)).defects.join()).toMatch(/chroma/);
  }, 60_000);
  it('flags black frames', async () => {
    const f = await clip('black.mp4', ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=2`]);
    expect((await inspect(f)).defects.join()).toMatch(/black/);
  }, 60_000);
  it('flags blank (flat) frames', async () => {
    const f = await clip('flat.mp4', ['-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:d=2`]);
    expect((await inspect(f)).defects.join()).toMatch(/blank/);
  }, 60_000);
  it('flags letterboxed footage', async () => {
    const f = await clip('letterbox.mp4', ['-f', 'lavfi', '-i', `testsrc2=s=${W}x320:d=2`, '-vf', `pad=${W}:${H}:0:124:black`]);
    expect((await inspect(f)).defects.join()).toMatch(/letterbox/);
  }, 60_000);
  it('flags a "video" that is a frozen still', async () => {
    const png = path.join(dir, 'still.png');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:d=1`, '-frames:v', '1', png]);
    const f = await clip('static.mp4', ['-loop', '1', '-i', png]);
    expect((await inspect(f)).defects.join()).toMatch(/static/);
  }, 60_000);
  it('a corrupt file cannot be inspected (no fabricated metrics)', async () => {
    const f = path.join(dir, 'corrupt.mp4');
    fs.writeFileSync(f, Buffer.alloc(4096, 7));
    await expect(inspect(f)).rejects.toThrow();
  }, 60_000);
});

// -----------------------------------------------------------------------------
describe('YouTube upload boundary (injected transport; NOT a real-channel verification)', () => {
  const creds = { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' };
  const opts = { timeoutMs: 5000, uploadTimeoutMs: 5000, maxAttempts: 2 };
  const video = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-yt-')), 'v.mp4');
  fs.writeFileSync(video, Buffer.alloc(2048, 1));
  const req = { jobId: 'j', videoPath: video, metadata: { title: 'A valid title', description: 'd', tags: ['x'], privacyStatus: 'private' as const, categoryId: '27', containsSyntheticMedia: true, defaultLanguage: 'en' } };

  function transport(handlers: { token?: () => Response; init?: () => Response; put?: () => Response | Promise<Response> }) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('oauth2')) return calls.push('token'), (handlers.token ?? (() => jsonResponse({ access_token: 'at' })))();
      if (init?.method === 'POST') return calls.push('init'), (handlers.init ?? (() => new Response('', { status: 200, headers: { location: 'https://upload.example/session' } })))();
      calls.push('put');
      return (handlers.put ?? (() => jsonResponse({ id: 'vid123' })))();
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('missing credentials fail clearly at construction, naming every missing key', () => {
    expect(() => new YouTubePublisher({ clientId: '', clientSecret: '', refreshToken: '' }, opts)).toThrow(/YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN/);
  });
  it('success returns the video id after exactly one upload', async () => {
    const t = transport({});
    const r = await new YouTubePublisher(creds, opts, { fetchImpl: t.fetchImpl, sleep: async () => {} }).publish(req);
    expect(r.externalId).toBe('vid123');
    expect(t.calls.filter((c) => c === 'put')).toHaveLength(1);
  });
  it('token refresh failure → uploadStarted=false (safe to retry), no upload attempted', async () => {
    const t = transport({ token: () => jsonResponse({ error: 'invalid_grant' }, 400) });
    const err = await new YouTubePublisher(creds, opts, { fetchImpl: t.fetchImpl, sleep: async () => {} }).publish(req).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.uploadStarted).toBe(false);
    expect(t.calls).not.toContain('put');
    expect(String(err.message)).not.toMatch(/secret|refresh_token=/);
  });
  it('session init failure → uploadStarted=false, no bytes sent', async () => {
    const t = transport({ init: () => new Response('quota', { status: 403 }) });
    const err = await new YouTubePublisher(creds, opts, { fetchImpl: t.fetchImpl, sleep: async () => {} }).publish(req).catch((e) => e);
    expect(err.uploadStarted).toBe(false);
    expect(t.calls).not.toContain('put');
  });
  it('upload failure after bytes started → uploadStarted=true and is never retried automatically', async () => {
    for (const put of [() => new Response('backend error', { status: 503 }), () => Promise.reject(new Error('socket hang up'))]) {
      const t = transport({ put });
      const err = await new YouTubePublisher(creds, opts, { fetchImpl: t.fetchImpl, sleep: async () => {} }).publish(req).catch((e) => e);
      expect(err).toBeInstanceOf(PublishError);
      expect(err.uploadStarted).toBe(true);
      expect(err.retryable).toBe(false);
      expect(t.calls.filter((c) => c === 'put')).toHaveLength(1);
    }
  });
  it('a 200 without a video id is treated as an uncertain outcome, not success', async () => {
    const t = transport({ put: () => jsonResponse({}) });
    const err = await new YouTubePublisher(creds, opts, { fetchImpl: t.fetchImpl, sleep: async () => {} }).publish(req).catch((e) => e);
    expect(err.uploadStarted).toBe(true);
  });
});

// -----------------------------------------------------------------------------
async function pipelineToFinalGate(overrides: Record<string, string> = {}, mutate?: (b: ProviderBundle) => ProviderBundle) {
  const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'auto', ...overrides });
  const repo = await memoryRepo(cfg);
  const bundle = createProviders(cfg, 'mock');
  const runner = new PipelineRunner(cfg, repo, mutate ? mutate(bundle) : bundle);
  const job = await runner.createJob();
  const waiting = await runner.run(job.id);
  expect(waiting.state).toBe('AWAITING_FINAL_APPROVAL');
  return { cfg, repo, runner, bundle, job: waiting };
}

describe('publish gate invariants are enforced in code', () => {
  it('blocks review-required, defective media, rejected sources and altered narration; human approval covers only review', async () => {
    const { cfg, repo, runner, job } = await pipelineToFinalGate({ APPROVAL_FINAL: 'auto_after_qa' }, (b) => ({
      ...b,
      // Force the "uncertain visual" path: vision says UNSURE for every candidate.
      verifierLlm: wrapVision(b.verifierLlm, 'UNSURE'),
    }));
    // auto_after_qa did NOT auto-approve because QA requires human review.
    const qa = await repo.requireArtifact(job.artifacts.qaId, 'qa', QAResultSchema);
    expect(qa.requiresHumanReview).toBe(true);
    expect(qa.reviewReasons.join()).toMatch(/semanticRelevance/);
    expect((await repo.getLatestApproval(job.id, 'FINAL_VIDEO'))).toBeNull();

    const script = await repo.requireArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema);
    const topic = (await repo.getTopic(job.artifacts.topicId!))!;
    // Force the job state so the gate itself (not the state machine) is what is under test.
    const forced = await repo.updateJobState(job.id, 'AWAITING_FINAL_APPROVAL', { state: 'READY_TO_PUBLISH' });
    const gate = () => assertPublishable(forced, repo, cfg, script, topic);

    // A policy approval can never cover a review-required Short.
    await repo.saveApproval({ id: randomUUID(), jobId: job.id, stage: 'FINAL_VIDEO', targetId: job.artifacts.renderId!, decision: 'APPROVED', decidedBy: 'policy:auto_after_qa', decidedAt: new Date().toISOString() });
    await expect(gate()).rejects.toThrow(/Publication blocked/);
    await expect(gate()).rejects.toMatchObject({ violations: expect.arrayContaining([expect.stringMatching(/human review required/)]) });

    // A human approval does.
    await new Promise((r) => setTimeout(r, 5));
    await repo.saveApproval({ id: randomUUID(), jobId: job.id, stage: 'FINAL_VIDEO', targetId: job.artifacts.renderId!, decision: 'APPROVED', decidedBy: 'human', decidedAt: new Date().toISOString() });
    await expect(gate()).resolves.toBeTruthy();

    // ...but never covers objective defects.
    const assetId = job.artifacts.assetIds![0];
    const asset = await repo.requireArtifact(assetId, 'asset', AssetDescriptorSchema);
    await repo.saveArtifact(job.id, 'asset', { ...asset, visualValidation: { ...asset.visualValidation!, defects: ['chroma-key green screen'] } });
    await expect(gate()).rejects.toMatchObject({ violations: expect.arrayContaining([expect.stringMatching(/visual defects/)]) });
    await repo.saveArtifact(job.id, 'asset', { ...asset, visualValidation: undefined });
    await expect(gate()).rejects.toMatchObject({ violations: expect.arrayContaining([expect.stringMatching(/not visually validated/)]) });
    await repo.saveArtifact(job.id, 'asset', asset);

    // Unacceptable source behind a referenced claim.
    const research = await repo.requireArtifact(job.artifacts.researchId, 'research', ResearchPacketSchema);
    const rejected = { ...research, sources: research.sources.map((s) => ({ ...s, credibility: { tier: 'REJECTED' as const, category: 'advocacy' as const, method: 'rule' as const, conflictOfInterest: false, reason: 'test' } })) };
    await repo.saveArtifact(job.id, 'research', rejected);
    await expect(gate()).rejects.toMatchObject({ violations: expect.arrayContaining([expect.stringMatching(/rejected sources/), expect.stringMatching(/not permitted for publication/)]) });
    await repo.saveArtifact(job.id, 'research', research);

    // Narration replaced after validation.
    const narration = await repo.requireArtifact(job.artifacts.narrationId, 'narration', VoiceNarrationSchema);
    const original = fs.readFileSync(narration.audioPath);
    fs.appendFileSync(narration.audioPath, Buffer.alloc(16));
    await expect(gate()).rejects.toMatchObject({ violations: expect.arrayContaining([expect.stringMatching(/narration audio/)]) });
    fs.writeFileSync(narration.audioPath, original);
    await expect(gate()).resolves.toBeTruthy();
    expect(runner).toBeTruthy();
  }, 900_000);
});

/** Wraps an LLM so media_vision returns a fixed verdict (everything else passes through). */
function wrapVision<T extends ProviderBundle['verifierLlm']>(llm: T, verdict: 'ACCEPT' | 'REJECT' | 'UNSURE'): T {
  return new Proxy(llm, {
    get(target, prop, recv) {
      if (prop === 'generateStructured') {
        return async (req: { task: string; schema: { parse: (v: unknown) => unknown } }) => {
          if (req.task !== 'media_vision') return (target as any).generateStructured(req);
          return { content: req.schema.parse({ verdict, showsSubject: verdict === 'ACCEPT', issues: [], reason: 'fixture' }), model: 'fixture-vision', attempts: 1, durationMs: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });
}

// -----------------------------------------------------------------------------
describe('publication retry safety', () => {
  const failing = (uploadStarted: boolean): Publisher => ({
    name: 'flaky',
    target: 'mock',
    publish: async () => {
      throw new PublishError('flaky', uploadStarted ? 'connection reset mid-upload' : 'token refresh failed', uploadStarted);
    },
  });

  it('retries only failures that provably happened before upload; uncertain uploads require reconciliation', async () => {
    const { cfg, repo, runner, bundle, job } = await pipelineToFinalGate();
    await runner.approve(job.id, 'FINAL_VIDEO', 'APPROVED');

    // 1) failure before upload → retryable via retryPublish, publishes exactly once.
    const pre = new PipelineRunner(cfg, repo, { ...bundle, publisher: failing(false) });
    const failed = await pre.run(job.id);
    expect(failed.state).toBe('FAILED');
    expect(failed.failedStage).toBe('PUBLISHING');
    expect((await repo.getPublishForJob(job.id))).toMatchObject({ status: 'FAILED', uploadAttempted: false });
    await expect(runner.resume(job.id)).rejects.toThrow(); // generic resume never re-enters PUBLISHING
    const done = await runner.retryPublish(job.id);
    expect(done.state).toBe('PUBLISHED');
    expect((await repo.getPublishForJob(job.id))?.status).toBe('PUBLISHED');
    await expect(runner.retryPublish(job.id)).rejects.toThrow(/only jobs that failed while publishing/);
  }, 900_000);

  it('a failure after upload started is never retried automatically', async () => {
    const { cfg, repo, runner, bundle, job } = await pipelineToFinalGate();
    await runner.approve(job.id, 'FINAL_VIDEO', 'APPROVED');
    const mid = new PipelineRunner(cfg, repo, { ...bundle, publisher: failing(true) });
    expect((await mid.run(job.id)).state).toBe('FAILED');
    expect((await repo.getPublishForJob(job.id))).toMatchObject({ status: 'FAILED', uploadAttempted: true });
    await expect(runner.retryPublish(job.id)).rejects.toThrow(/reconcile manually/);
    await expect(runner.resume(job.id)).rejects.toThrow();
    expect((await repo.getPublishForJob(job.id))?.status).toBe('FAILED');
  }, 900_000);
});

// -----------------------------------------------------------------------------
describe('source hygiene (regression: an empty provider file shipped and broke boot)', () => {
  it('no TypeScript source file under packages/ or apps/ is empty', () => {
    const empty: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', 'dist'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) && fs.readFileSync(p, 'utf-8').trim() === '') empty.push(path.relative(ROOT, p));
      }
    };
    for (const top of ['packages', 'apps']) walk(path.join(ROOT, top));
    expect(empty).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('invalid LLM output fails closed', () => {
  class ScriptedLLM extends StructuredLLMBase {
    readonly name = 'scripted';
    readonly model = 'scripted-1';
    calls = 0;
    constructor(private readonly replies: string[]) {
      super();
    }
    protected async complete(): Promise<RawCompletion> {
      const text = this.replies[Math.min(this.calls++, this.replies.length - 1)];
      return { text, inputTokens: 1, outputTokens: 1, model: this.model, httpAttempts: 1 };
    }
  }
  const req = { task: 't', system: 's', prompt: 'p', schemaHint: '{"n":1}', schema: z.object({ n: z.number().int().min(1) }), maxValidationAttempts: 3 };

  it('non-JSON, truncated JSON and schema-violating JSON are all rejected after bounded re-prompts', async () => {
    for (const bad of ['Sure! Here you go: n is five', '{"n": 5', '{"n": "five"}', '{"n": 0}']) {
      const llm = new ScriptedLLM([bad]);
      await expect(llm.generateStructured(req)).rejects.toBeInstanceOf(ValidationError);
      expect(llm.calls).toBe(3);
    }
  });
  it('a corrected reply after a bad one is accepted (and only then)', async () => {
    const llm = new ScriptedLLM(['nope', '```json\n{"n": 2}\n```']);
    expect((await llm.generateStructured(req)).content).toEqual({ n: 2 });
  });
});

// -----------------------------------------------------------------------------
describe('provider quota exhaustion (regression: live ElevenLabs quota error reported as AUTHENTICATION)', () => {
  it('is classified as QUOTA_EXCEEDED, not retried, and not mistaken for bad credentials', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ detail: { type: 'invalid_request', code: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } }, 401);
    }) as typeof fetch;
    const tts = new ElevenLabsTTSProvider('k', 'voice', 'model', { timeoutMs: 5000, maxAttempts: 3, usdPer1kChars: 0.22, speed: 1.1 }, { fetchImpl, sleep: async () => {} });
    const err = await tts.synthesize({ text: 'Hello there.' }).catch((e) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.kind).toBe('QUOTA_EXCEEDED');
    expect(err.retryable).toBe(false);
    expect(calls).toBe(1);
  });
});
