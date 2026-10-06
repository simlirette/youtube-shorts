import { randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  ApprovalEvent,
  ApprovalEventSchema,
  ApprovalStage,
  Job,
  JobArtifacts,
  JobSchema,
  JobState,
  PublishJob,
  PublishJobSchema,
  TopicCandidate,
  TopicCandidateSchema,
  TopicScore,
  TopicScoreSchema,
  TopicStatus,
} from '@shorts/schemas';
import type { z } from 'zod';
import { IDatabase, getDatabase } from './db.js';
import { InternalError, ValidationError } from '../errors.js';

export type ArtifactKind =
  | 'research'
  | 'story'
  | 'script'
  | 'script_attempt'
  | 'narration'
  | 'timeline'
  | 'asset'
  | 'render'
  | 'qa';

export interface ProviderRunRecord {
  jobId?: string;
  provider: string;
  operation: string;
  status: 'OK' | 'ERROR';
  attempts: number;
  durationMs: number;
  costUsd: number;
  units?: Record<string, number>;
  error?: string;
}

const now = () => new Date().toISOString();

export class ShortsRepository {
  readonly db: IDatabase;

  constructor(db?: IDatabase) {
    this.db = db ?? getDatabase();
  }

  async init(): Promise<void> {
    await this.db.initSchema();
  }

  // ---------------------------------------------------------------------------
  // Topics
  // ---------------------------------------------------------------------------

  async saveTopic(topic: TopicCandidate): Promise<void> {
    const t = TopicCandidateSchema.parse(topic);
    await this.db.execute(
      `INSERT INTO topics (id, title, premise, pillar, status, dedupe_key, doc, discovered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, premise = excluded.premise, pillar = excluded.pillar,
         status = excluded.status, dedupe_key = excluded.dedupe_key, doc = excluded.doc, updated_at = excluded.updated_at`,
      [t.id, t.title, t.premise, t.pillar, t.status, t.dedupeKey ?? '', JSON.stringify(t), t.discoveredAt, now()]
    );
  }

  async getTopic(id: string): Promise<TopicCandidate | null> {
    const rows = await this.db.query<{ doc: string; status: string }>(`SELECT doc, status FROM topics WHERE id = ?`, [id]);
    if (!rows[0]) return null;
    return TopicCandidateSchema.parse({ ...JSON.parse(rows[0].doc), status: rows[0].status });
  }

  async listTopics(status?: TopicStatus, limit = 500): Promise<TopicCandidate[]> {
    const rows = status
      ? await this.db.query<{ doc: string; status: string }>(`SELECT doc, status FROM topics WHERE status = ? ORDER BY discovered_at DESC LIMIT ?`, [status, limit])
      : await this.db.query<{ doc: string; status: string }>(`SELECT doc, status FROM topics ORDER BY discovered_at DESC LIMIT ?`, [limit]);
    return rows.map((r) => TopicCandidateSchema.parse({ ...JSON.parse(r.doc), status: r.status }));
  }

  async updateTopicStatus(id: string, status: TopicStatus): Promise<void> {
    const topic = await this.getTopic(id);
    if (!topic) throw new InternalError(`Topic ${id} not found`);
    await this.saveTopic({ ...topic, status });
  }

  /** Atomically moves a topic from one of `from` into `to`. Returns false if someone else got it. */
  async claimTopicStatus(id: string, from: TopicStatus[], to: TopicStatus): Promise<boolean> {
    const placeholders = from.map(() => '?').join(', ');
    const res = await this.db.execute(`UPDATE topics SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`, [
      to,
      now(),
      id,
      ...from,
    ]);
    if (res.changes === 1) {
      const topic = await this.getTopic(id);
      if (topic) await this.saveTopic({ ...topic, status: to });
    }
    return res.changes === 1;
  }

  async saveTopicScore(score: TopicScore): Promise<void> {
    const s = TopicScoreSchema.parse(score);
    await this.db.execute(
      `INSERT INTO topic_scores (id, topic_id, overall_score, pass_gate, doc, scored_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET overall_score = excluded.overall_score, pass_gate = excluded.pass_gate, doc = excluded.doc`,
      [s.id, s.topicId, s.overallScore, s.passGate ? 1 : 0, JSON.stringify(s), s.scoredAt]
    );
  }

  async getLatestTopicScore(topicId: string): Promise<TopicScore | null> {
    const rows = await this.db.query<{ doc: string }>(`SELECT doc FROM topic_scores WHERE topic_id = ? ORDER BY scored_at DESC LIMIT 1`, [topicId]);
    return rows[0] ? TopicScoreSchema.parse(JSON.parse(rows[0].doc)) : null;
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  private rowToJob(r: Record<string, unknown>): Job {
    return JobSchema.parse({
      id: r.id,
      mode: r.mode,
      state: r.state,
      failedStage: r.failed_stage ?? undefined,
      errorKind: r.error_kind ?? undefined,
      errorMessage: r.error_message ?? undefined,
      retryable: r.retryable === null || r.retryable === undefined ? undefined : Boolean(r.retryable),
      artifacts: JSON.parse(String(r.artifacts)),
      workDir: r.work_dir,
      attempts: Number(r.attempts),
      lockedBy: r.locked_by ?? undefined,
      lockedAt: r.locked_at ?? undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  async createJob(job: Job): Promise<Job> {
    const j = JobSchema.parse(job);
    await this.db.execute(
      `INSERT INTO jobs (id, mode, state, topic_id, failed_stage, error_kind, error_message, retryable, artifacts, work_dir, attempts, locked_by, locked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
      [j.id, j.mode, j.state, j.artifacts.topicId ?? null, JSON.stringify(j.artifacts), j.workDir, j.attempts, j.createdAt, j.updatedAt]
    );
    await this.addJobEvent(j.id, null, j.state, 'job created');
    return j;
  }

  async getJob(id: string): Promise<Job | null> {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM jobs WHERE id = ?`, [id]);
    return rows[0] ? this.rowToJob(rows[0]) : null;
  }

  async requireJob(id: string): Promise<Job> {
    const j = await this.getJob(id);
    if (!j) throw new ValidationError(`Job ${id} not found`);
    return j;
  }

  async findJobByPrefix(prefix: string): Promise<Job | null> {
    const rows = await this.db.query<Record<string, unknown>>(`SELECT * FROM jobs WHERE id LIKE ? ORDER BY created_at DESC`, [`${prefix}%`]);
    if (rows.length > 1) throw new ValidationError(`Job id prefix "${prefix}" is ambiguous (${rows.length} matches)`);
    return rows[0] ? this.rowToJob(rows[0]) : null;
  }

  async listJobs(state?: JobState, limit = 100): Promise<Job[]> {
    const rows = state
      ? await this.db.query<Record<string, unknown>>(`SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?`, [state, limit])
      : await this.db.query<Record<string, unknown>>(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map((r) => this.rowToJob(r));
  }

  async countJobsCreatedSince(isoTime: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ?`, [isoTime]);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Compare-and-set state update: only succeeds if the job is still in `expectedState`.
   * Prevents two processes from advancing the same job.
   */
  async updateJobState(
    id: string,
    expectedState: JobState,
    patch: {
      state: JobState;
      artifacts?: JobArtifacts;
      failedStage?: JobState | null;
      errorKind?: string | null;
      errorMessage?: string | null;
      retryable?: boolean | null;
      incrementAttempts?: boolean;
      message?: string;
    }
  ): Promise<Job> {
    const current = await this.requireJob(id);
    const artifacts = patch.artifacts ?? current.artifacts;
    const res = await this.db.execute(
      `UPDATE jobs SET state = ?, topic_id = ?, artifacts = ?, failed_stage = ?, error_kind = ?, error_message = ?, retryable = ?,
         attempts = attempts + ?, updated_at = ? WHERE id = ? AND state = ?`,
      [
        patch.state,
        artifacts.topicId ?? null,
        JSON.stringify(artifacts),
        patch.failedStage === undefined ? current.failedStage ?? null : patch.failedStage,
        patch.errorKind === undefined ? current.errorKind ?? null : patch.errorKind,
        patch.errorMessage === undefined ? current.errorMessage ?? null : patch.errorMessage,
        patch.retryable === undefined ? (current.retryable === undefined ? null : current.retryable ? 1 : 0) : patch.retryable === null ? null : patch.retryable ? 1 : 0,
        patch.incrementAttempts ? 1 : 0,
        now(),
        id,
        expectedState,
      ]
    );
    if (res.changes !== 1) {
      const latest = await this.requireJob(id);
      throw new InternalError(`Concurrent modification: job ${id} expected state ${expectedState} but is ${latest.state}`);
    }
    await this.addJobEvent(id, expectedState, patch.state, patch.message);
    return this.requireJob(id);
  }

  async updateJobArtifacts(id: string, artifacts: JobArtifacts): Promise<void> {
    await this.db.execute(`UPDATE jobs SET artifacts = ?, topic_id = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(artifacts),
      artifacts.topicId ?? null,
      now(),
      id,
    ]);
  }

  /** Acquire an exclusive execution lease. Returns false if another live process holds it. */
  async acquireJobLock(id: string, ttlMinutes: number, owner = `${os.hostname()}:${process.pid}`): Promise<boolean> {
    const staleBefore = new Date(Date.now() - ttlMinutes * 60_000).toISOString();
    const res = await this.db.execute(
      `UPDATE jobs SET locked_by = ?, locked_at = ? WHERE id = ? AND (locked_by IS NULL OR locked_at < ? OR locked_by = ?)`,
      [owner, now(), id, staleBefore, owner]
    );
    return res.changes === 1;
  }

  async releaseJobLock(id: string, owner = `${os.hostname()}:${process.pid}`): Promise<void> {
    await this.db.execute(`UPDATE jobs SET locked_by = NULL, locked_at = NULL WHERE id = ? AND locked_by = ?`, [id, owner]);
  }

  async addJobEvent(jobId: string, from: JobState | null, to: JobState, message?: string): Promise<void> {
    await this.db.execute(`INSERT INTO job_events (id, job_id, from_state, to_state, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      randomUUID(),
      jobId,
      from,
      to,
      message ?? null,
      now(),
    ]);
  }

  async listJobEvents(jobId: string): Promise<Array<{ from: string | null; to: string; message: string | null; at: string }>> {
    const rows = await this.db.query<{ from_state: string | null; to_state: string; message: string | null; created_at: string }>(
      `SELECT from_state, to_state, message, created_at FROM job_events WHERE job_id = ? ORDER BY created_at ASC`,
      [jobId]
    );
    return rows.map((r) => ({ from: r.from_state, to: r.to_state, message: r.message, at: r.created_at }));
  }

  // ---------------------------------------------------------------------------
  // Artifacts (immutable JSON documents validated on read)
  // ---------------------------------------------------------------------------

  async saveArtifact<T extends { id: string }>(jobId: string, kind: ArtifactKind, doc: T): Promise<void> {
    await this.db.execute(
      `INSERT INTO artifacts (id, job_id, kind, doc, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET doc = excluded.doc`,
      [doc.id, jobId, kind, JSON.stringify(doc), now()]
    );
  }

  async getArtifact<S extends z.ZodTypeAny>(id: string, kind: ArtifactKind, schema: S): Promise<z.infer<S> | null> {
    const rows = await this.db.query<{ doc: string }>(`SELECT doc FROM artifacts WHERE id = ? AND kind = ?`, [id, kind]);
    return rows[0] ? schema.parse(JSON.parse(rows[0].doc)) : null;
  }

  async requireArtifact<S extends z.ZodTypeAny>(id: string | undefined, kind: ArtifactKind, schema: S): Promise<z.infer<S>> {
    if (!id) throw new InternalError(`Missing ${kind} artifact reference`);
    const a = await this.getArtifact(id, kind, schema);
    if (!a) throw new InternalError(`${kind} artifact ${id} not found`);
    return a;
  }

  async listArtifacts<S extends z.ZodTypeAny>(kind: ArtifactKind, schema: S, opts: { jobId?: string; limit?: number } = {}): Promise<z.infer<S>[]> {
    const rows = opts.jobId
      ? await this.db.query<{ doc: string }>(`SELECT doc FROM artifacts WHERE kind = ? AND job_id = ? ORDER BY created_at DESC LIMIT ?`, [kind, opts.jobId, opts.limit ?? 1000])
      : await this.db.query<{ doc: string }>(`SELECT doc FROM artifacts WHERE kind = ? ORDER BY created_at DESC LIMIT ?`, [kind, opts.limit ?? 1000]);
    return rows.map((r) => schema.parse(JSON.parse(r.doc)));
  }

  // ---------------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------------

  async saveApproval(approval: ApprovalEvent): Promise<void> {
    const a = ApprovalEventSchema.parse(approval);
    await this.db.execute(
      `INSERT INTO approvals (id, job_id, stage, target_id, decision, decided_by, notes, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.id, a.jobId, a.stage, a.targetId, a.decision, a.decidedBy, a.directorNotes ?? null, a.decidedAt]
    );
  }

  async getLatestApproval(jobId: string, stage: ApprovalStage): Promise<ApprovalEvent | null> {
    const rows = await this.db.query<Record<string, string>>(
      `SELECT * FROM approvals WHERE job_id = ? AND stage = ? ORDER BY decided_at DESC LIMIT 1`,
      [jobId, stage]
    );
    const r = rows[0];
    if (!r) return null;
    return ApprovalEventSchema.parse({
      id: r.id,
      jobId: r.job_id,
      stage: r.stage,
      targetId: r.target_id,
      decision: r.decision,
      decidedBy: r.decided_by,
      directorNotes: r.notes ?? undefined,
      decidedAt: r.decided_at,
    });
  }

  // ---------------------------------------------------------------------------
  // Publishing (unique indexes make duplicates impossible at the storage layer)
  // ---------------------------------------------------------------------------

  async insertPublish(p: PublishJob): Promise<void> {
    const v = PublishJobSchema.parse(p);
    await this.db.execute(
      `INSERT INTO publishes (id, job_id, render_id, target, status, video_sha256, external_id, url, doc, started_at, published_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [v.id, v.jobId, v.renderId, v.target, v.status, v.videoSha256, v.externalId ?? null, v.url ?? null, JSON.stringify(v), v.startedAt, v.publishedAt ?? null, v.error ?? null]
    );
  }

  async updatePublish(p: PublishJob): Promise<void> {
    const v = PublishJobSchema.parse(p);
    await this.db.execute(
      `UPDATE publishes SET status = ?, external_id = ?, url = ?, doc = ?, published_at = ?, error = ? WHERE id = ?`,
      [v.status, v.externalId ?? null, v.url ?? null, JSON.stringify(v), v.publishedAt ?? null, v.error ?? null, v.id]
    );
  }

  async getPublishForJob(jobId: string): Promise<PublishJob | null> {
    const rows = await this.db.query<{ doc: string }>(`SELECT doc FROM publishes WHERE job_id = ?`, [jobId]);
    return rows[0] ? PublishJobSchema.parse(JSON.parse(rows[0].doc)) : null;
  }

  async findPublishByVideo(sha256: string, target: string): Promise<PublishJob | null> {
    const rows = await this.db.query<{ doc: string }>(`SELECT doc FROM publishes WHERE video_sha256 = ? AND target = ?`, [sha256, target]);
    return rows[0] ? PublishJobSchema.parse(JSON.parse(rows[0].doc)) : null;
  }

  // ---------------------------------------------------------------------------
  // Provider run ledger (cost + reliability observability)
  // ---------------------------------------------------------------------------

  async recordProviderRun(r: ProviderRunRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO provider_runs (id, job_id, provider, operation, status, attempts, duration_ms, cost_usd, units, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), r.jobId ?? null, r.provider, r.operation, r.status, r.attempts, Math.round(r.durationMs), r.costUsd, r.units ? JSON.stringify(r.units) : null, r.error ?? null, now()]
    );
  }

  async providerRunSummary(jobId: string): Promise<Array<{ provider: string; operation: string; calls: number; costUsd: number; errors: number }>> {
    const rows = await this.db.query<{ provider: string; operation: string; calls: number; cost: number; errors: number }>(
      `SELECT provider, operation, COUNT(*) AS calls, SUM(cost_usd) AS cost, SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS errors
       FROM provider_runs WHERE job_id = ? GROUP BY provider, operation ORDER BY provider, operation`,
      [jobId]
    );
    return rows.map((r) => ({ provider: r.provider, operation: r.operation, calls: Number(r.calls), costUsd: Number(r.cost ?? 0), errors: Number(r.errors) }));
  }
}
