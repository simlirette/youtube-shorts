/**
 * PostgreSQL mode. The connection-failure test always runs; the rest need a real server:
 *   TEST_DATABASE_URL=<postgres connection url> pnpm test
 * Each run uses its own schema, so the suite never touches existing data.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseUnavailableError, PostgresDatabase, ProviderUnavailableError, ShortsRepository } from '@shorts/core';
import { createProviders, type ProviderBundle } from '@shorts/providers';
import { PipelineRunner } from '@shorts/pipeline';
import type { Job, TopicCandidate } from '@shorts/schemas';
import { testConfig } from './helpers.js';

describe('PostgreSQL unavailable', () => {
  it('fails with a clear, retryable DatabaseUnavailableError instead of hanging or crashing', async () => {
    const db = new PostgresDatabase(['postgres:/', '127.0.0.1:1', 'none'].join('/'), { connectTimeoutMs: 2000 });
    const err = await new ShortsRepository(db).init().catch((e) => e);
    expect(err).toBeInstanceOf(DatabaseUnavailableError);
    expect(err.retryable).toBe(true);
    expect(String(err.message)).toMatch(/cannot reach PostgreSQL/);
    await db.close();
  });
});

const URL_ = process.env.TEST_DATABASE_URL;
const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const urlFor = (u: string, sch: string) => `${u}${u.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${sch}`)}`;
// The end-to-end job gets its own schema so fixture topics from other tests are not candidates.

describe.skipIf(!URL_)('PostgreSQL mode (real server)', () => {
  let admin: PostgresDatabase;
  const dbs: PostgresDatabase[] = [];
  const open = (sch = schema) => {
    const d = new PostgresDatabase(urlFor(URL_!, sch));
    dbs.push(d);
    return d;
  };

  beforeAll(async () => {
    admin = new PostgresDatabase(URL_!);
    await admin.execute(`CREATE SCHEMA ${schema}`);
    await admin.execute(`CREATE SCHEMA ${schema}_e2e`);
  });
  afterAll(async () => {
    for (const d of dbs) await d.close().catch(() => undefined);
    await admin.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.execute(`DROP SCHEMA IF EXISTS ${schema}_e2e CASCADE`);
    await admin.close();
  });

  const topic = (): TopicCandidate => ({
    id: randomUUID(), title: `Topic ${randomUUID().slice(0, 6)}`, premise: 'A premise long enough.', pillar: 'ENGINEERING',
    sourceUrls: [], tags: [], status: 'SCORED', discoveredAt: new Date().toISOString(),
  });
  const job = (topicId: string): Job => ({
    id: randomUUID(), mode: 'mock', state: 'SELECTING_TOPIC', artifacts: { topicId }, workDir: '/tmp/x', attempts: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  it('schema creation is idempotent and safe when several processes start at once', async () => {
    await Promise.all([0, 1, 2, 3].map(() => new ShortsRepository(open()).init()));
    await new ShortsRepository(open()).init();
    const rows = await admin.query(`SELECT value FROM ${schema}.schema_meta WHERE key = 'version'`);
    expect(rows).toEqual([{ value: '3' }]);
  });

  it('transactions are real: a failure rolls back every statement', async () => {
    const repo = new ShortsRepository(open());
    const t = topic();
    await repo.saveTopic(t);
    const j = job(t.id);
    await expect(
      repo.db.transaction(async () => {
        await repo.createJob(j);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(await repo.getJob(j.id)).toBeNull();
    expect(await repo.listJobEvents(j.id)).toEqual([]);
  });

  it('compare-and-set: of two concurrent state updates exactly one wins', async () => {
    const repo = new ShortsRepository(open());
    const other = new ShortsRepository(open());
    const t = topic();
    await repo.saveTopic(t);
    const j = await repo.createJob(job(t.id));
    const results = await Promise.allSettled([
      repo.updateJobState(j.id, 'SELECTING_TOPIC', { state: 'RESEARCHING' }),
      other.updateJobState(j.id, 'SELECTING_TOPIC', { state: 'FAILED' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await repo.listJobEvents(j.id)).length).toBe(2); // created + the single winning transition
  });

  it('job leases are exclusive across processes and expire', async () => {
    const repo = new ShortsRepository(open());
    const t = topic();
    await repo.saveTopic(t);
    const j = await repo.createJob(job(t.id));
    expect(await repo.acquireJobLock(j.id, 60, 'host-a:1')).toBe(true);
    expect(await new ShortsRepository(open()).acquireJobLock(j.id, 60, 'host-b:2')).toBe(false);
    expect(await repo.acquireJobLock(j.id, 0, 'host-b:2')).toBe(true); // stale lease (ttl 0) can be taken over
  });

  it('duplicates are impossible at the storage layer (one job per topic, one publication per job/video)', async () => {
    const repo = new ShortsRepository(open());
    const t = topic();
    await repo.saveTopic(t);
    const j = await repo.createJob(job(t.id));
    await expect(repo.createJob(job(t.id))).rejects.toThrow(/duplicate key|unique/i);
    const pub = { id: randomUUID(), jobId: j.id, renderId: randomUUID(), target: 'mock' as const, status: 'PUBLISHING' as const, videoSha256: 'f'.repeat(64), metadata: { title: 'A valid title', description: 'd', tags: [], privacyStatus: 'private' as const, categoryId: '27', containsSyntheticMedia: true, defaultLanguage: 'en' }, startedAt: new Date().toISOString(), uploadAttempted: true };
    await repo.insertPublish(pub);
    await expect(repo.insertPublish({ ...pub, id: randomUUID() })).rejects.toThrow(/duplicate key|unique/i);
    // Topic claim is atomic: only one of two concurrent claimers gets it.
    const claims = await Promise.all([repo.claimTopicStatus(t.id, ['SCORED'], 'IN_PRODUCTION'), new ShortsRepository(open()).claimTopicStatus(t.id, ['SCORED'], 'IN_PRODUCTION')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('runs, interrupts, resumes and publishes a full mock job on PostgreSQL', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'auto' });
    const repo = new ShortsRepository(open(`${schema}_e2e`));
    await repo.init();
    const bundle = createProviders(cfg, 'mock');
    // Interrupt: the TTS provider fails once (retryable outage), the job fails at SYNTHESIZING_VOICE.
    let failTts = true;
    const tts = bundle.tts;
    const flaky: ProviderBundle = {
      ...bundle,
      tts: {
        name: tts.name,
        voiceId: tts.voiceId,
        modelId: tts.modelId,
        settingsKey: tts.settingsKey,
        synthesize: async (req) => {
          if (failTts) {
            failTts = false;
            throw new ProviderUnavailableError('mock-tts', 'simulated outage');
          }
          return tts.synthesize(req);
        },
      },
    };
    const runner = new PipelineRunner(cfg, repo, flaky);
    const created = await runner.createJob();
    const failed = await runner.run(created.id);
    expect(failed.state).toBe('FAILED');
    expect(failed.failedStage).toBe('SYNTHESIZING_VOICE');
    // A different process (new connection pool) resumes it.
    const runner2 = new PipelineRunner(cfg, new ShortsRepository(open(`${schema}_e2e`)), flaky);
    const waiting = await runner2.resume(created.id);
    expect(waiting.state).toBe('AWAITING_FINAL_APPROVAL');
    await runner2.approve(created.id, 'FINAL_VIDEO', 'APPROVED');
    expect((await runner2.run(created.id)).state).toBe('PUBLISHED');
    expect((await runner2.run(created.id)).state).toBe('PUBLISHED');
    const events = await repo.listJobEvents(created.id);
    expect(events.filter((e) => e.to === 'PUBLISHED')).toHaveLength(1);
  }, 900_000);
});
