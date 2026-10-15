import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError, ShortsRepository } from '@shorts/core';
import { MockTTSProvider, createProviders, type LLMProvider, type ProviderBundle, type TTSProvider } from '@shorts/providers';
import { summarize } from '@shorts/agents';
import { PipelineRunner, assertPublishable } from '@shorts/pipeline';
import { QAResultSchema, ShortScriptSchema } from '@shorts/schemas';
import { memoryRepo, testConfig } from './helpers.js';

const ROOT = path.resolve(__dirname, '..');

async function setup(overrides: Record<string, string> = {}, mutate?: (b: ProviderBundle) => ProviderBundle) {
  const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'auto', ...overrides });
  const repo = await memoryRepo(cfg);
  const bundle = createProviders(cfg, 'mock');
  const runner = new PipelineRunner(cfg, repo, mutate ? mutate(bundle) : bundle);
  return { cfg, repo, runner };
}

describe('application boot (regression 1)', () => {
  it('the CLI starts and lists its commands', () => {
    const r = spawnSync('npx', ['tsx', 'apps/cli/src/index.ts', '--help'], { cwd: ROOT, shell: true, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/run\|pipeline|run \[options\]/);
    expect(r.stdout).toMatch(/resume/);
  }, 120_000);

  it('refuses to run without an explicit mode', () => {
    const r = spawnSync('npx', ['tsx', 'apps/cli/src/index.ts', 'run'], { cwd: ROOT, shell: true, encoding: 'utf-8', env: { ...process.env, PIPELINE_MODE: '' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/Choose an execution mode/);
  }, 120_000);
});

describe('pipeline lifecycle (mock providers, real media)', () => {
  it('runs to the final human gate, publishes only after approval, and never twice', async () => {
    const { cfg, repo, runner } = await setup();
    const job = await runner.createJob();
    const settled = await runner.run(job.id);
    expect(settled.state).toBe('AWAITING_FINAL_APPROVAL');

    const qa = await repo.requireArtifact(settled.artifacts.qaId, 'qa', QAResultSchema);
    expect(qa.publishEligible).toBe(true);
    expect(qa.media.checks.filter((c) => c.status === 'FAIL')).toEqual([]);

    // No approval → the publish gate refuses.
    const script = await repo.requireArtifact(settled.artifacts.scriptId, 'script', ShortScriptSchema);
    const topic = (await repo.getTopic(settled.artifacts.topicId!))!;
    await expect(assertPublishable(settled, repo, cfg, script, topic)).rejects.toThrow(/Publication blocked/);
    expect((await runner.run(job.id)).state).toBe('AWAITING_FINAL_APPROVAL'); // running again does not publish

    const approved = await runner.approve(job.id, 'FINAL_VIDEO', 'APPROVED', 'looks good');
    expect(approved.state).toBe('READY_TO_PUBLISH');
    const published = await runner.run(job.id);
    expect(published.state).toBe('PUBLISHED');
    const pub = await repo.getPublishForJob(job.id);
    expect(pub?.status).toBe('PUBLISHED');
    expect(fs.existsSync(path.join(cfg.outputDir, 'exports-mock', job.id, 'short.mp4'))).toBe(true);
    expect((await repo.getTopic(topic.id))?.status).toBe('USED');

    // Duplicate publication is impossible: state machine, gate, and storage uniqueness all refuse.
    expect((await runner.run(job.id)).state).toBe('PUBLISHED');
    await expect(runner.approve(job.id, 'FINAL_VIDEO', 'APPROVED')).rejects.toThrow();
    await expect(repo.insertPublish({ ...pub!, id: randomUUID() })).rejects.toThrow(/UNIQUE/);

    const events = await repo.listJobEvents(job.id);
    expect(events.map((e) => e.to)).toEqual(
      expect.arrayContaining(['SELECTING_TOPIC', 'RESEARCHING', 'SCRIPTING', 'SYNTHESIZING_VOICE', 'BUILDING_TIMELINE', 'SOURCING_MEDIA', 'RENDERING', 'QA', 'AWAITING_FINAL_APPROVAL', 'READY_TO_PUBLISH', 'PUBLISHING', 'PUBLISHED'])
    );
  }, 600_000);

  it('manual idea approval is a real waiting state, not an automatic pass', async () => {
    const { runner } = await setup({ APPROVAL_IDEA: 'manual' });
    const job = await runner.createJob();
    expect((await runner.run(job.id)).state).toBe('AWAITING_IDEA_APPROVAL');
    expect((await runner.run(job.id)).state).toBe('AWAITING_IDEA_APPROVAL');
    expect((await runner.approve(job.id, 'IDEA', 'REJECTED', 'not interesting')).state).toBe('REJECTED');
  }, 120_000);

  it('a tampered video is refused at publication (sha256 differs from the QA-ed file)', async () => {
    const { repo, runner } = await setup({ APPROVAL_FINAL: 'auto_after_qa' }, (b) => b);
    const job = await runner.createJob();
    // Stop before publishing by pausing at READY_TO_PUBLISH: run, then inspect.
    const ready = await runner.run(job.id);
    // auto_after_qa publishes in the same run; use a fresh job that we tamper with before publishing instead.
    expect(['PUBLISHED']).toContain(ready.state);

    const { runner: r2, repo: repo2 } = await setup();
    const j2 = await r2.createJob();
    const waiting = await r2.run(j2.id);
    await r2.approve(j2.id, 'FINAL_VIDEO', 'APPROVED');
    const render = (await repo2.requireArtifact(waiting.artifacts.qaId, 'qa', QAResultSchema));
    const renderJob = JSON.parse(fs.readFileSync(path.join(waiting.workDir, 'qa', 'qa.json'), 'utf-8'));
    expect(renderJob.videoSha256).toBe(render.videoSha256);
    const videoPath = path.join(waiting.workDir, 'render', 'short.mp4');
    fs.appendFileSync(videoPath, Buffer.from('tampered'));
    const after = await r2.run(j2.id);
    expect(after.state).toBe('FAILED');
    expect(after.errorMessage).toMatch(/changed after QA/);
    expect(await repo2.getPublishForJob(j2.id)).toBeNull();
    expect(repo).toBeInstanceOf(ShortsRepository);
  }, 900_000);
});

describe('QA gates block publication (regression 6)', () => {
  it('a blocking WARN makes a report non-eligible', () => {
    const r = summarize('MEDIA', [
      { id: 'a', category: 'x', status: 'PASS', blocking: false, reviewRequired: false, message: '' },
      { id: 'audio.loudness', category: 'audio', status: 'WARN', blocking: true, reviewRequired: false, message: '-20 LUFS' },
    ]);
    expect(r.overallStatus).toBe('WARN');
    expect(r.publishEligible).toBe(false);
    expect(r.blockingReasons[0]).toMatch(/audio.loudness/);
  });

  it('a non-eligible QA result can never be approved or published, even if the job state is forced', async () => {
    const { cfg, repo, runner } = await setup();
    const job = await runner.createJob();
    const waiting = await runner.run(job.id);
    expect(waiting.state).toBe('AWAITING_FINAL_APPROVAL');
    // Downgrade the stored QA result to a blocking WARN.
    const qa = await repo.requireArtifact(waiting.artifacts.qaId, 'qa', QAResultSchema);
    const downgraded = { ...qa, overallStatus: 'WARN' as const, publishEligible: false, blockingReasons: ['media.audio.loudness: -22 LUFS'] };
    await repo.saveArtifact(job.id, 'qa', downgraded);
    await expect(runner.approve(job.id, 'FINAL_VIDEO', 'APPROVED')).rejects.toThrow(/not publish-eligible/);

    // Even with a forged approval and a forced state, the publish gate re-checks QA.
    await repo.saveApproval({ id: randomUUID(), jobId: job.id, stage: 'FINAL_VIDEO', targetId: waiting.artifacts.renderId!, decision: 'APPROVED', decidedBy: 'human', decidedAt: new Date().toISOString() });
    const forced = await repo.updateJobState(job.id, 'AWAITING_FINAL_APPROVAL', { state: 'READY_TO_PUBLISH' });
    const script = await repo.requireArtifact(forced.artifacts.scriptId, 'script', ShortScriptSchema);
    const topic = (await repo.getTopic(forced.artifacts.topicId!))!;
    await expect(assertPublishable(forced, repo, cfg, script, topic)).rejects.toThrow(/not publish-eligible/);
    const after = await runner.run(job.id);
    expect(after.state).toBe('FAILED');
    expect(await repo.getPublishForJob(job.id)).toBeNull();
  }, 600_000);
});

describe('failure, resume and locking', () => {
  it('a provider failure fails the job with a classified, retryable error; resume continues without repeating finished stages', async () => {
    let ttsCalls = 0;
    let flaky = true;
    const llmTasks: string[] = [];
    const { repo, runner } = await setup({}, (b) => {
      const realTts = new MockTTSProvider();
      const tts: TTSProvider = {
        name: realTts.name, voiceId: realTts.voiceId, modelId: realTts.modelId, settingsKey: realTts.settingsKey,
        synthesize: async (r) => {
          ttsCalls++;
          if (flaky) throw new ProviderUnavailableError('mock-tts', 'HTTP 503');
          return realTts.synthesize(r);
        },
      };
      const llm = b.llm;
      const counting: LLMProvider = { name: llm.name, model: llm.model, generateStructured: (req) => (llmTasks.push(req.task), llm.generateStructured(req)) };
      return { ...b, tts, llm: counting, verifierLlm: counting };
    });
    const job = await runner.createJob();
    const failed = await runner.run(job.id);
    expect(failed).toMatchObject({ state: 'FAILED', failedStage: 'SYNTHESIZING_VOICE', errorKind: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(fs.existsSync(path.join(failed.workDir, 'error.json'))).toBe(true);
    const before = llmTasks.length;

    flaky = false;
    const resumed = await runner.resume(job.id);
    expect(resumed.state).toBe('AWAITING_FINAL_APPROVAL');
    expect(ttsCalls).toBe(2);
    // Upstream LLM stages (discovery, research, story, script) are not regenerated after resume.
    const afterResume = llmTasks.slice(before);
    expect(afterResume.filter((t) => ['discovery', 'scoring', 'research_extraction', 'claim_entailment', 'story', 'script'].includes(t))).toEqual([]);
    expect(afterResume).toContain('content_review');
    expect((await repo.requireJob(job.id)).attempts).toBe(1);
  }, 600_000);

  it('resume refuses jobs that failed while publishing (uncertain upload outcome)', async () => {
    const { repo, runner } = await setup();
    const job = await runner.createJob();
    await repo.updateJobState(job.id, 'CREATED', { state: 'FAILED', failedStage: 'PUBLISHING', errorKind: 'TIMEOUT', retryable: true });
    await expect(runner.resume(job.id)).rejects.toThrow(/Reconcile manually/);
  });

  it('a job locked by another live process cannot be run concurrently', async () => {
    const { repo, runner } = await setup();
    const job = await runner.createJob();
    expect(await repo.acquireJobLock(job.id, 60, 'other-host:1234')).toBe(true);
    await expect(runner.run(job.id)).rejects.toThrow(/locked by other-host:1234/);
  });

  it('concurrent state updates are rejected (compare-and-set)', async () => {
    const { repo, runner } = await setup();
    const job = await runner.createJob();
    await repo.updateJobState(job.id, 'CREATED', { state: 'SELECTING_TOPIC' });
    await expect(repo.updateJobState(job.id, 'CREATED', { state: 'SELECTING_TOPIC' })).rejects.toThrow(/Concurrent modification/);
  });
});
