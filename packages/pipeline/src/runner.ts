import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ApprovalDecision,
  ApprovalStage,
  AssetDescriptor,
  AssetDescriptorSchema,
  ContentPillar,
  Job,
  JobArtifacts,
  JobState,
  QAResult,
  QAResultSchema,
  RenderJobSchema,
  ResearchPacketSchema,
  ProductionVariant,
  ProductionVariantSchema,
  ScriptReview,
  ScriptReviewSchema,
  ShortFormat,
  ShortScript,
  ShortScriptSchema,
  StoryOutlineSchema,
  Timeline,
  TimelineSchema,
  TopicCandidate,
  VoiceNarrationSchema,
} from '@shorts/schemas';
import {
  AppConfig,
  InternalError,
  JobStateMachine,
  Logger,
  PipelineError,
  PublishError,
  QAFailedError,
  STAGE_ORDER,
  ShortsRepository,
  TERMINAL_STATES,
  AWAITING_STATES,
  ValidationError,
  cacheDir,
  jobDir,
  logger as rootLogger,
  resolveFromRoot,
  sha256File,
  toPipelineError,
} from '@shorts/core';
import { ProviderBundle, ProviderCallReport, YouTubeAnalyticsClient, createProviders, type OwnerVideoMetrics } from '@shorts/providers';
import {
  ContentQA,
  DiscoveryAgent,
  DiscoveryResult,
  FORMATS,
  GapDiscoveryAgent,
  GapDiscoveryResult,
  ResearchAgent,
  chooseFormat,
  gapTopicScore,
  parseGapSeeds,
  rulesFor,
  visualPreflight,
  ScoringAgent,
  ScriptEditor,
  ScriptRules,
  ScriptwriterAgent,
  revisionNotes,
  StoryEditorAgent,
  VisualDirectorAgent,
  analyzePerformance,
  experimentReport,
  renderPerformanceReport,
  type ExperimentReport,
  type PerformanceReport,
  type PerformanceRow,
  VoiceAgent,
} from '@shorts/agents';
import type { GraphicRenderer, SceneVisualBrief, SemanticVerdict } from '@shorts/agents';
import { nextPublishSlot } from './schedule.js';
import { assignVariant, baseVariant, parseExperiment } from './variant.js';
import {
  CAPTION_LAYOUT,
  CaptionLayout,
  LoadedTrack,
  VideoRenderer,
  bedGainDb,
  buildTimeline,
  evaluateMedia,
  framingOf,
  loadMusicLibrary,
  selectTrack,
  BlenderGraphicRenderer,
  MockGraphicRenderer,
  findBlender,
} from '@shorts/rendering';
import { z } from 'zod';
import { assertPublishable, buildMetadata } from './publish-gate.js';

export interface RunOptions {
  pillar?: ContentPillar;
  /** Return (without failing) as soon as the job reaches this state; used for partial acceptance runs. */
  stopAt?: JobState;
}

export interface CreateJobOptions {
  /** Produce a specific catalog topic instead of selecting one. */
  topicId?: string;
}

const TAIL_SECONDS = 0.6;

/** Artifact keys produced at or after each stage (cleared when resuming from that stage). */
const STAGE_ARTIFACTS: Partial<Record<JobState, Array<keyof JobArtifacts>>> = {
  RESEARCHING: ['researchId'],
  SCRIPTING: ['storyId', 'scriptId'],
  SYNTHESIZING_VOICE: ['narrationId'],
  BUILDING_TIMELINE: ['timelinePath', 'captionsPath'],
  SOURCING_MEDIA: ['assetIds'],
  RENDERING: ['renderId'],
  QA: ['qaId'],
};

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export class PipelineRunner {
  readonly providers: ProviderBundle;
  private currentJobId: string | undefined;
  private readonly owner = `${os.hostname()}:${process.pid}`;
  private readonly log: Logger;
  private readonly layout: CaptionLayout;

  constructor(
    private readonly cfg: AppConfig,
    private readonly repo: ShortsRepository,
    providers?: ProviderBundle | { mode: 'mock' | 'live' }
  ) {
    const observer = (r: ProviderCallReport) => {
      this.repo
        .recordProviderRun({ ...r, jobId: this.currentJobId })
        .catch((e) => rootLogger.warn(`provider_runs write failed: ${(e as Error).message}`));
    };
    this.providers = providers && 'llm' in providers ? providers : createProviders(cfg, providers?.mode ?? this.requireMode(), { observer });
    this.log = rootLogger.child({});
    this.layout = { ...CAPTION_LAYOUT, fontName: cfg.CAPTION_FONT_NAME };
  }

  private requireMode(): 'mock' | 'live' {
    if (!this.cfg.PIPELINE_MODE) throw new ValidationError('Pipeline mode must be chosen explicitly (PIPELINE_MODE or --mode mock|live)');
    return this.cfg.PIPELINE_MODE;
  }

  get mode() {
    return this.providers.mode;
  }

  private graphics: GraphicRenderer | null | undefined;
  /** Local graphics renderer: Blender in live mode (when installed), a test pattern in mock mode. */
  private graphicRenderer(): GraphicRenderer | undefined {
    if (this.graphics === undefined) this.graphics = this.createGraphicRenderer();
    return this.graphics ?? undefined;
  }

  private createGraphicRenderer(): GraphicRenderer | null {
    if (!this.cfg.GRAPHICS_ENABLED) return null;
    if (this.providers.mode === 'mock') return new MockGraphicRenderer();
    const bin = findBlender(this.cfg.BLENDER_PATH || undefined);
    if (!bin) {
      this.log.warn('GRAPHICS_ENABLED but Blender was not found (set BLENDER_PATH); clauses stock cannot show use stock fallbacks and human review', { stage: 'MEDIA' });
      return null;
    }
    return new BlenderGraphicRenderer({ blenderPath: bin, fontFile: this.cfg.captionFontFile, cacheDir: path.join(cacheDir(this.cfg.outputDir, 'media'), 'graphics') });
  }

  /** Script contract for a format under a variant; STORY keeps the configured, voice-derived bounds. */
  private rules(format: ShortFormat = 'STORY', variant?: ProductionVariant): ScriptRules {
    if (format === 'STORY') {
      return { minWords: this.cfg.SCRIPT_MIN_WORDS, maxWords: this.cfg.SCRIPT_MAX_WORDS, hookMaxWords: this.cfg.SCRIPT_HOOK_MAX_WORDS, sceneCount: 5, minClaimRefs: 3 };
    }
    return rulesFor(format, this.cfg.SCRIPT_MAX_WORDS, { hookType: variant?.hookType, durationBand: variant?.durationBand });
  }

  /**
   * The job's frozen production variant. Jobs created before variants existed get one snapshot of
   * the current configuration, recorded as a legacy backfill, and keep it from then on.
   */
  private async variantOf(job: Job): Promise<{ job: Job; variant: ProductionVariant }> {
    if (job.artifacts.variant) return { job, variant: ProductionVariantSchema.parse(job.artifacts.variant) };
    const variant = ProductionVariantSchema.parse(baseVariant(this.cfg, 'legacy backfill (job predates production variants)'));
    const artifacts = { ...job.artifacts, variant };
    await this.repo.updateJobArtifacts(job.id, artifacts);
    this.log.warn('Job had no production variant; recorded a snapshot of the current configuration', { jobId: job.id });
    return { job: { ...job, artifacts }, variant };
  }

  /** Per-format nudges from measured performance (empty until enough Shorts have aged). */
  private async formatWeights(): Promise<Partial<Record<ShortFormat, number>>> {
    const rows = await this.performanceRows();
    return rows.length ? analyzePerformance(rows).formatWeights : {};
  }

  // ===========================================================================
  // Analytics
  // ===========================================================================

  /**
   * Pulls fresh metrics for every Short published to YouTube: owner metrics (engaged views,
   * retention) when OAuth is configured, otherwise public counters via yt-dlp.
   */
  async syncAnalytics(): Promise<{ measured: number; source: string; channel?: string }> {
    const pubs = (await this.repo.listPublished('youtube')).filter((p) => p.externalId);
    if (pubs.length === 0) return { measured: 0, source: 'none' };
    const now = new Date();
    const ids = pubs.map((p) => p.externalId!);
    let rows: Array<Omit<Partial<OwnerVideoMetrics>, 'videoId' | 'views'> & { videoId: string; views: number }>;
    let source: 'analytics_api' | 'data_api' | 'public';
    let channel: string | undefined;
    if (this.cfg.YOUTUBE_CLIENT_ID && this.cfg.YOUTUBE_CLIENT_SECRET && this.cfg.YOUTUBE_REFRESH_TOKEN) {
      const client = new YouTubeAnalyticsClient({ clientId: this.cfg.YOUTUBE_CLIENT_ID, clientSecret: this.cfg.YOUTUBE_CLIENT_SECRET }, this.cfg.YOUTUBE_REFRESH_TOKEN);
      channel = (await client.channel()).title;
      const start = pubs.map((p) => (p.publishedAt ?? p.startedAt).slice(0, 10)).sort()[0];
      const res = await client.videoMetrics(ids, start, now.toISOString().slice(0, 10));
      rows = res;
      source = res[0]?.source ?? 'analytics_api';
    } else {
      rows = (await this.providers.signals.videoStats(ids)).map((s) => ({ videoId: s.id, views: s.views ?? 0, likes: s.likes ?? undefined, comments: s.comments ?? undefined }));
      source = 'public';
    }
    let measured = 0;
    for (const pub of pubs) {
      const r = rows.find((x) => x.videoId === pub.externalId);
      if (!r) continue;
      const released = new Date(pub.scheduledFor && new Date(pub.scheduledFor) < now ? pub.scheduledFor : pub.publishedAt ?? pub.startedAt);
      await this.repo.saveVideoMetrics({
        id: randomUUID(),
        publishId: pub.id,
        jobId: pub.jobId,
        youtubeVideoId: pub.externalId!,
        source,
        capturedAt: now.toISOString(),
        ageHours: Math.max(0, (now.getTime() - released.getTime()) / 3600_000),
        views: Math.round(r.views),
        engagedViews: typeof r.engagedViews === 'number' ? Math.round(r.engagedViews) : undefined,
        likes: typeof r.likes === 'number' ? Math.round(r.likes) : undefined,
        comments: typeof r.comments === 'number' ? Math.round(r.comments) : undefined,
        shares: typeof r.shares === 'number' ? Math.round(r.shares) : undefined,
        subscribersGained: typeof r.subscribersGained === 'number' ? Math.round(r.subscribersGained) : undefined,
        averageViewDurationSeconds: typeof r.averageViewDurationSeconds === 'number' ? r.averageViewDurationSeconds : undefined,
        averageViewPercentage: typeof r.averageViewPercentage === 'number' ? r.averageViewPercentage : undefined,
      });
      measured++;
    }
    return { measured, source, channel };
  }

  /** Latest metrics joined with how each Short was made (format, topic cluster, length, release hour). */
  async performanceRows(): Promise<PerformanceRow[]> {
    const metrics = await this.repo.latestVideoMetrics();
    const rows: PerformanceRow[] = [];
    for (const m of metrics) {
      const job = await this.repo.getJob(m.jobId);
      if (!job?.artifacts.scriptId) continue;
      const script = await this.repo.getArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema);
      const narration = job.artifacts.narrationId ? await this.repo.getArtifact(job.artifacts.narrationId, 'narration', VoiceNarrationSchema) : null;
      const topic = job.artifacts.topicId ? await this.repo.getTopic(job.artifacts.topicId) : null;
      const pub = await this.repo.getPublishForJob(job.id);
      if (!script) continue;
      const released = pub?.scheduledFor ?? pub?.publishedAt;
      const hour = released
        ? Number(new Intl.DateTimeFormat('en-US', { timeZone: this.cfg.PUBLISH_TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date(released)))
        : null;
      rows.push({
        videoId: m.youtubeVideoId,
        title: script.title,
        format: script.format,
        cluster: topic?.gap?.cluster ?? topic?.tags.find((t) => t.startsWith('cluster:'))?.slice(8) ?? topic?.pillar ?? 'unknown',
        pillar: topic?.pillar ?? 'unknown',
        words: script.totalWords,
        durationSeconds: narration?.durationSeconds ?? script.targetDurationSeconds,
        hookWords: script.hookText.split(/\s+/).length,
        gapScore: topic?.gap?.score ?? null,
        publishHour: hour,
        ageHours: m.ageHours,
        views: m.views,
        engagedViews: m.engagedViews,
        averageViewPercentage: m.averageViewPercentage,
        likes: m.likes,
        subscribersGained: m.subscribersGained,
        ...(job.artifacts.variant
          ? {
              hookType: job.artifacts.variant.hookType,
              durationBand: job.artifacts.variant.durationBand,
              titleCard: job.artifacts.variant.titleCard,
              music: job.artifacts.variant.music,
              captionStyle: job.artifacts.variant.captionStyle,
              voiceSpeed: job.artifacts.variant.voiceSpeed,
              experimentId: job.artifacts.variant.experimentId,
              experimentFactor: job.artifacts.variant.factor,
              arm: job.artifacts.variant.arm,
            }
          : {}),
        musicTrackId: job.artifacts.renderId ? ((await this.repo.getArtifact(job.artifacts.renderId, 'render', RenderJobSchema))?.music?.trackId ?? null) : null,
        editorTotal: job.artifacts.scriptReviewId ? ((await this.repo.getArtifact(job.artifacts.scriptReviewId, 'script_review', ScriptReviewSchema))?.total ?? null) : null,
      });
    }
    return rows;
  }

  /** Everything a reviewer needs to decide on a waiting job, including the voice credits a script will cost. */
  async reviewDigest(jobId: string): Promise<{
    topic: string;
    gap: TopicCandidate['gap'];
    script: ShortScript | null;
    voiceCredits: number | null;
    sources: string[];
    video: string | null;
    reviewReasons: string[];
    variant: ProductionVariant | null;
    editor: ScriptReview | null;
  }> {
    const job = await this.repo.requireJob(jobId);
    const topic = job.artifacts.topicId ? await this.repo.getTopic(job.artifacts.topicId) : null;
    const script = job.artifacts.scriptId ? await this.repo.getArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema) : null;
    const text = script ? script.scenes.map((s) => s.narration).join(' ') : '';
    const qa = job.artifacts.qaId ? await this.repo.getArtifact(job.artifacts.qaId, 'qa', QAResultSchema) : null;
    const render = job.artifacts.renderId ? await this.repo.getArtifact(job.artifacts.renderId, 'render', RenderJobSchema) : null;
    return {
      topic: topic?.title ?? '(no topic yet)',
      gap: topic?.gap,
      script,
      voiceCredits: script ? (this.providers.tts.creditsFor?.(text) ?? text.length) : null,
      sources: script ? [...script.description.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]) : [],
      video: render?.videoPath ?? null,
      reviewReasons: qa?.reviewReasons ?? [],
      variant: job.artifacts.variant ?? null,
      editor: job.artifacts.scriptReviewId ? await this.repo.getArtifact(job.artifacts.scriptReviewId, 'script_review', ScriptReviewSchema) : null,
    };
  }

  /** Screening report for one experiment (sample sizes and uncertainty; never declares a winner). */
  async experimentReport(experimentId: string): Promise<ExperimentReport> {
    return experimentReport(await this.performanceRows(), experimentId);
  }

  /** Writes the performance report (markdown) and returns it with the structured analysis. */
  async analyticsReport(): Promise<{ report: PerformanceReport; markdown: string; path: string }> {
    const report = analyzePerformance(await this.performanceRows());
    const markdown = renderPerformanceReport(report);
    const out = path.join(this.cfg.outputDir, 'reports', `performance-${new Date().toISOString().slice(0, 10)}.md`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, markdown);
    return { report, markdown, path: out };
  }

  /** Uploads to the configured target in the last 24 h (any outcome) against MAX_UPLOADS_PER_DAY. */
  private async uploadCapReached(): Promise<boolean> {
    if (this.providers.publisher.target !== 'youtube') return false;
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    return (await this.repo.countPublishesSince(since, 'youtube')) >= this.cfg.MAX_UPLOADS_PER_DAY;
  }

  private enabledFormats(): ShortFormat[] {
    return this.cfg.SHORT_FORMATS.split(',').map((f) => f.trim()).filter(Boolean) as ShortFormat[];
  }

  // ===========================================================================
  // Job lifecycle API
  // ===========================================================================

  async createJob(opts: CreateJobOptions = {}): Promise<Job> {
    const id = randomUUID();
    const nowIso = new Date().toISOString();
    const artifacts: JobArtifacts = {};
    if (opts.topicId) {
      const topic = await this.repo.getTopic(opts.topicId);
      if (!topic) throw new ValidationError(`Topic ${opts.topicId} not found`);
      if (!(await this.repo.claimTopicStatus(topic.id, ['DISCOVERED', 'SCORED'], 'IN_PRODUCTION'))) {
        throw new ValidationError(`Topic "${topic.title}" is ${topic.status}; only DISCOVERED or SCORED topics can be produced`);
      }
      artifacts.topicId = topic.id;
    }
    // Production choices are frozen now: resumes and retries never re-read them from configuration.
    const exp = parseExperiment(this.cfg.EXPERIMENT);
    artifacts.variant = assignVariant(this.cfg, exp ? await this.repo.countJobsInExperiment(exp.id) : 0);
    const job = await this.repo.createJob({
      id,
      mode: this.mode,
      state: 'CREATED',
      artifacts,
      workDir: jobDir(this.cfg.outputDir, id),
      attempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    this.log.info(`Created ${this.mode.toUpperCase()} job`, { jobId: id, stage: 'CREATED' });
    return job;
  }

  /** Advances the job until it completes, waits for a human, or fails. */
  async run(jobId: string, opts: RunOptions = {}, lockOpts: { stealLock?: boolean } = {}): Promise<Job> {
    const ttl = lockOpts.stealLock ? 0 : this.cfg.JOB_LOCK_TTL_MINUTES;
    if (!(await this.repo.acquireJobLock(jobId, ttl, this.owner))) {
      const j = await this.repo.requireJob(jobId);
      throw new ValidationError(`Job ${jobId} is locked by ${j.lockedBy} since ${j.lockedAt}; use --steal-lock only if that process is dead`);
    }
    this.currentJobId = jobId;
    try {
      for (let guard = 0; guard < 40; guard++) {
        const job = await this.repo.requireJob(jobId);
        if (job.mode !== this.mode) throw new ValidationError(`Job ${jobId} was created in ${job.mode} mode; refusing to run it in ${this.mode} mode`);
        if (job.state === 'FAILED' || TERMINAL_STATES.includes(job.state) || AWAITING_STATES.includes(job.state)) return job;
        if (opts.stopAt && job.state === opts.stopAt) return job;
        if (job.state === 'READY_TO_PUBLISH' && (await this.uploadCapReached())) {
          this.log.warn(`Daily upload cap (MAX_UPLOADS_PER_DAY=${this.cfg.MAX_UPLOADS_PER_DAY}) reached; job stays READY_TO_PUBLISH`, { jobId, stage: job.state });
          return job;
        }
        await this.step(job, opts);
      }
      throw new InternalError(`Job ${jobId} did not settle after 40 steps`);
    } finally {
      this.currentJobId = undefined;
      await this.repo.releaseJobLock(jobId, this.owner);
    }
  }

  /** Re-enter a FAILED job at its failed stage (or an earlier work stage), clearing later artifacts. */
  async resume(jobId: string, opts: RunOptions & { fromStage?: JobState; stealLock?: boolean } = {}): Promise<Job> {
    let job = await this.repo.requireJob(jobId);
    if (job.state === 'FAILED') {
      const target = opts.fromStage ?? job.failedStage;
      if (!target || !JobStateMachine.canResume(job.failedStage, target)) {
        throw new ValidationError(
          job.failedStage === 'PUBLISHING'
            ? 'Job failed while publishing; the upload outcome is uncertain. Reconcile manually before any retry.'
            : `Cannot resume job from ${target} (failed at ${job.failedStage})`
        );
      }
      const artifacts = { ...job.artifacts };
      const fromIdx = STAGE_ORDER.indexOf(target);
      for (const [stage, keys] of Object.entries(STAGE_ARTIFACTS) as Array<[JobState, Array<keyof JobArtifacts>]>) {
        if (STAGE_ORDER.indexOf(stage) >= fromIdx) for (const k of keys) delete artifacts[k];
      }
      job = await this.repo.updateJobState(jobId, 'FAILED', {
        state: target,
        artifacts,
        failedStage: null,
        errorKind: null,
        errorMessage: null,
        retryable: null,
        incrementAttempts: true,
        message: `resumed from ${target}`,
      });
      this.log.info(`Resuming job at ${target}`, { jobId, stage: target });
    } else if (!STAGE_ORDER.includes(job.state) || AWAITING_STATES.includes(job.state) || TERMINAL_STATES.includes(job.state)) {
      throw new ValidationError(`Job is ${job.state}; nothing to resume`);
    }
    // Work states (e.g. interrupted mid-stage) simply continue; completed stages are skipped.
    return this.run(jobId, opts, { stealLock: opts.stealLock });
  }

  async approve(jobId: string, stage: ApprovalStage, decision: ApprovalDecision, notes?: string): Promise<Job> {
    const job = await this.repo.requireJob(jobId);
    const expected: Record<ApprovalStage, JobState> = { IDEA: 'AWAITING_IDEA_APPROVAL', SCRIPT: 'AWAITING_SCRIPT_APPROVAL', FINAL_VIDEO: 'AWAITING_FINAL_APPROVAL' };
    if (job.state !== expected[stage]) throw new ValidationError(`Job is ${job.state}; a ${stage} decision requires ${expected[stage]}`);
    if (decision === 'REVISIONS_REQUESTED' && stage === 'IDEA') throw new ValidationError('Revisions can be requested for SCRIPT or FINAL_VIDEO (footage), not IDEA');
    const targetId = stage === 'IDEA' ? job.artifacts.topicId : stage === 'SCRIPT' ? job.artifacts.scriptId : job.artifacts.renderId;
    if (!targetId) throw new InternalError(`Job has no target for ${stage} approval`);
    if (stage === 'FINAL_VIDEO' && decision === 'APPROVED') {
      const qa = await this.repo.requireArtifact(job.artifacts.qaId, 'qa', QAResultSchema);
      if (!qa.publishEligible) throw new ValidationError('Cannot approve: QA is not publish-eligible', qa.blockingReasons);
    }
    await this.repo.saveApproval({ id: randomUUID(), jobId, stage, targetId, decision, decidedBy: 'human', directorNotes: notes, decidedAt: new Date().toISOString() });

    if (decision === 'REJECTED') {
      if (job.artifacts.topicId) await this.repo.updateTopicStatus(job.artifacts.topicId, 'REJECTED');
      return this.transition(job, 'REJECTED', undefined, `${stage} rejected by human${notes ? `: ${notes}` : ''}`);
    }
    if (decision === 'REVISIONS_REQUESTED' && stage === 'FINAL_VIDEO') {
      // Footage rework: drop the rejected clips (listed scenes, or all), keep narration and timeline.
      const scenes = (notes?.match(/scenes?\s*:?\s*([\d,\s]+)/i)?.[1] ?? '')
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number);
      const assets = await this.loadAssets(job);
      const rejected = assets.filter((a) => scenes.length === 0 || scenes.includes(a.sceneNumber)).map((a) => `${a.provider}:${a.providerAssetId}`);
      const artifacts = { ...job.artifacts, excludedMediaKeys: [...new Set([...(job.artifacts.excludedMediaKeys ?? []), ...rejected])] };
      delete artifacts.assetIds;
      delete artifacts.renderId;
      delete artifacts.qaId;
      return this.transition(job, 'SOURCING_MEDIA', artifacts, `footage rework requested (${rejected.length} clip(s) excluded)${notes ? `: ${notes}` : ''}`);
    }
    if (decision === 'REVISIONS_REQUESTED') {
      const artifacts = { ...job.artifacts };
      delete artifacts.storyId;
      delete artifacts.scriptId;
      return this.transition(job, 'SCRIPTING', artifacts, `script revisions requested: ${notes ?? ''}`);
    }
    const next: Record<ApprovalStage, JobState> = { IDEA: 'RESEARCHING', SCRIPT: 'SYNTHESIZING_VOICE', FINAL_VIDEO: 'READY_TO_PUBLISH' };
    return this.transition(job, next[stage], undefined, `${stage} approved by human`);
  }

  async discover(pillar: ContentPillar | undefined, count: number): Promise<DiscoveryResult> {
    return new DiscoveryAgent(this.providers.llm, this.repo, { recentTopicLimit: this.cfg.DISCOVERY_RECENT_TOPICS }).discoverTopics(pillar, count);
  }

  /** Measured-demand discovery: real viewer questions with long-form demand and no good Short. */
  async discoverGaps(overrides: Partial<{ maxProbes: number; seeds: string }> = {}): Promise<GapDiscoveryResult> {
    return new GapDiscoveryAgent(this.providers.signals, this.providers.verifierLlm, this.repo, {
      seeds: parseGapSeeds(overrides.seeds ?? this.cfg.GAP_SEEDS),
      minScore: this.cfg.GAP_MIN_SCORE,
      maxProbes: overrides.maxProbes ?? this.cfg.GAP_MAX_PROBES,
      delayMs: this.mode === 'live' ? 100 : 0,
    }).discover();
  }

  // ===========================================================================
  // State machine plumbing
  // ===========================================================================

  private async transition(job: Job, to: JobState, artifacts?: JobArtifacts, message?: string): Promise<Job> {
    JobStateMachine.assertTransition(job.state, to);
    return this.repo.updateJobState(job.id, job.state, {
      state: to,
      artifacts: artifacts ?? job.artifacts,
      failedStage: null,
      errorKind: null,
      errorMessage: null,
      retryable: null,
      message,
    });
  }

  private async fail(stale: Job, err: unknown): Promise<void> {
    // A stage may already have advanced the job (READY_TO_PUBLISH → PUBLISHING before the upload);
    // record the failure against the state the job is actually in, or it would stay stuck there.
    const job = await this.repo.requireJob(stale.id);
    if (job.state === 'FAILED' || TERMINAL_STATES.includes(job.state)) {
      this.log.error(`Error after job reached ${job.state}: ${(err as Error).message}`, undefined, { jobId: job.id });
      return;
    }
    const pe = toPipelineError(err);
    const violations = err instanceof ValidationError ? err.violations : err instanceof QAFailedError ? err.blockingReasons : [];
    writeJson(path.join(job.workDir, 'error.json'), {
      stage: job.state,
      kind: pe.kind,
      retryable: pe.retryable,
      message: pe.message,
      violations,
      at: new Date().toISOString(),
    });
    this.log.error(`Stage ${job.state} failed (${pe.kind}${pe.retryable ? ', retryable' : ''}): ${pe.message}`, undefined, { jobId: job.id, stage: job.state });
    await this.repo.updateJobState(job.id, job.state, {
      state: 'FAILED',
      failedStage: job.state,
      errorKind: pe.kind,
      errorMessage: pe.message.slice(0, 4000),
      retryable: pe.retryable,
      message: `${job.state} failed: ${pe.kind}`,
    });
  }

  private async step(job: Job, opts: RunOptions): Promise<void> {
    const started = Date.now();
    const stageLog = this.log.child({ jobId: job.id, stage: job.state });
    stageLog.info(`Stage ${job.state} started`);
    try {
      const after = await this.executeStage(job, opts);
      stageLog.info(`Stage ${job.state} -> ${after.state} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (err) {
      await this.fail(job, err);
    }
  }

  private async executeStage(job: Job, opts: RunOptions): Promise<Job> {
    switch (job.state) {
      case 'CREATED':
        return this.transition(job, 'SELECTING_TOPIC');
      case 'SELECTING_TOPIC':
        return this.stageSelectTopic(job, opts);
      case 'RESEARCHING':
        return this.stageResearch(job);
      case 'SCRIPTING':
        return this.stageScript(job);
      case 'SYNTHESIZING_VOICE':
        return this.stageVoice(job);
      case 'BUILDING_TIMELINE':
        return this.stageTimeline(job);
      case 'SOURCING_MEDIA':
        return this.stageMedia(job);
      case 'RENDERING':
        return this.stageRender(job);
      case 'QA':
        return this.stageQA(job);
      case 'READY_TO_PUBLISH':
        return this.stagePublish(job);
      case 'PUBLISHING':
        throw new ValidationError('Job is in PUBLISHING (interrupted upload?). The outcome is uncertain; reconcile manually.');
      default:
        throw new InternalError(`No executor for state ${job.state}`);
    }
  }

  // ===========================================================================
  // Stages
  // ===========================================================================

  private async loadTopic(job: Job): Promise<TopicCandidate> {
    const topic = job.artifacts.topicId ? await this.repo.getTopic(job.artifacts.topicId) : null;
    if (!topic) throw new InternalError('Job has no topic');
    return topic;
  }

  private async stageSelectTopic(job: Job, opts: RunOptions): Promise<Job> {
    const scorer = new ScoringAgent(this.providers.llm, { minScore: this.cfg.TOPIC_MIN_SCORE });
    let artifacts = { ...job.artifacts };

    const scoreAndGate = async (topic: TopicCandidate): Promise<boolean> => {
      let score = await this.repo.getLatestTopicScore(topic.id);
      if (!score) {
        // Gap topics are scored from measured evidence; only brainstormed topics need a model score.
        score = topic.gap ? gapTopicScore(topic, this.cfg.GAP_MIN_SCORE) : await scorer.scoreTopic(topic);
        await this.repo.saveTopicScore(score);
      }
      artifacts.scoreId = score.id;
      if (!score.passGate) {
        this.log.info(`Topic "${topic.title}" failed the score gate: ${score.gateReasons.join('; ')}`, { jobId: job.id, stage: 'SELECTING_TOPIC' });
      }
      return score.passGate;
    };

    if (artifacts.topicId) {
      const topic = await this.loadTopic(job);
      if (!(await scoreAndGate(topic))) {
        await this.repo.updateTopicStatus(topic.id, 'REJECTED');
        throw new ValidationError(`Requested topic "${topic.title}" did not pass the score gate`);
      }
    } else {
      let chosen: TopicCandidate | null = null;
      for (let round = 0; round < 3 && !chosen; round++) {
        // Highest measured gap first; brainstormed topics after.
        const pool = [...(await this.repo.listTopics('DISCOVERED')), ...(await this.repo.listTopics('SCORED'))]
          .filter((t) => !opts.pillar || t.pillar === opts.pillar)
          .sort((a, b) => (b.gap?.score ?? -1) - (a.gap?.score ?? -1));
        for (const topic of pool) {
          const passes = await scoreAndGate(topic);
          if (!passes) {
            await this.repo.updateTopicStatus(topic.id, 'REJECTED');
            continue;
          }
          if (topic.status === 'DISCOVERED') await this.repo.updateTopicStatus(topic.id, 'SCORED');
          if (await this.repo.claimTopicStatus(topic.id, ['SCORED'], 'IN_PRODUCTION')) {
            chosen = topic;
            break;
          }
        }
        if (!chosen) {
          let found = 0;
          if (this.cfg.DISCOVERY_MODE === 'gap') {
            const gaps = await this.discoverGaps();
            found = gaps.topics.length;
            if (found === 0) this.log.warn(`Gap discovery found no question above GAP_MIN_SCORE=${this.cfg.GAP_MIN_SCORE}; falling back to model discovery`, { jobId: job.id, stage: 'SELECTING_TOPIC' });
          }
          if (found === 0) {
            const res = await this.discover(opts.pillar, 5);
            if (res.shortfall > 0) this.log.warn(`Discovery returned ${res.topics.length}/${res.requested} novel topics`, { jobId: job.id, stage: 'SELECTING_TOPIC', rejected: res.rejected });
          }
        }
      }
      if (!chosen) throw new ValidationError('No topic passed the score gate after 3 discovery rounds');
      artifacts.topicId = chosen.id;
      artifacts = { ...artifacts };
      job = await this.updateArtifacts(job, artifacts);
    }
    await this.repo.updateJobArtifacts(job.id, artifacts);
    job = { ...job, artifacts };
    const topic = await this.loadTopic(job);
    writeJson(path.join(job.workDir, 'research', 'topic.json'), topic);

    if (this.cfg.APPROVAL_IDEA === 'auto') {
      await this.recordPolicyApproval(job, 'IDEA', topic.id, 'topic passed deterministic score gate');
      return this.transition(job, 'RESEARCHING', artifacts, 'idea auto-approved by policy (score gate passed)');
    }
    return this.transition(job, 'AWAITING_IDEA_APPROVAL', artifacts);
  }

  private async updateArtifacts(job: Job, artifacts: JobArtifacts): Promise<Job> {
    await this.repo.updateJobArtifacts(job.id, artifacts);
    return { ...job, artifacts };
  }

  private async recordPolicyApproval(job: Job, stage: ApprovalStage, targetId: string, why: string): Promise<void> {
    const policy = stage === 'IDEA' ? this.cfg.APPROVAL_IDEA : stage === 'SCRIPT' ? this.cfg.APPROVAL_SCRIPT : this.cfg.APPROVAL_FINAL;
    await this.repo.saveApproval({
      id: randomUUID(),
      jobId: job.id,
      stage,
      targetId,
      decision: 'APPROVED',
      decidedBy: `policy:${policy}`,
      directorNotes: why,
      decidedAt: new Date().toISOString(),
    });
  }

  private async stageResearch(job: Job): Promise<Job> {
    if (job.artifacts.researchId && (await this.repo.getArtifact(job.artifacts.researchId, 'research', ResearchPacketSchema))) {
      return this.transition(job, 'SCRIPTING');
    }
    const topic = await this.loadTopic(job);
    const agent = new ResearchAgent(this.providers.llm, this.providers.verifierLlm, this.providers.search, this.providers.retriever, {
      minVerifiedClaims: this.cfg.MIN_VERIFIED_CLAIMS,
    });
    const { packet, sourceTexts, rejectedSources } = await agent.conductResearch(topic);
    await this.repo.saveArtifact(job.id, 'research', packet);
    writeJson(path.join(job.workDir, 'research', 'research.json'), packet);
    writeJson(path.join(job.workDir, 'research', 'rejected-sources.json'), rejectedSources);
    for (const [id, text] of Object.entries(sourceTexts)) {
      fs.mkdirSync(path.join(job.workDir, 'research', 'sources'), { recursive: true });
      fs.writeFileSync(path.join(job.workDir, 'research', 'sources', `${id}.txt`), text);
    }
    await this.repo.saveTopic({ ...topic, sourceUrls: packet.sources.map((s) => s.url) });
    return this.transition(job, 'SCRIPTING', { ...job.artifacts, researchId: packet.id }, `${packet.verifiedClaimCount}/${packet.claims.length} claims verified`);
  }

  private async previousScripts(jobId: string): Promise<ShortScript[]> {
    const all = await this.repo.listArtifacts('script', ShortScriptSchema, { limit: 200 });
    const mine = new Set((await this.repo.listArtifacts('script', ShortScriptSchema, { jobId })).map((s) => s.id));
    return all.filter((s) => !mine.has(s.id));
  }

  private async stageScript(job: Job): Promise<Job> {
    const next: JobState = this.cfg.APPROVAL_SCRIPT === 'auto' ? 'SYNTHESIZING_VOICE' : 'AWAITING_SCRIPT_APPROVAL';
    if (job.artifacts.scriptId && (await this.repo.getArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema))) {
      if (next === 'SYNTHESIZING_VOICE') await this.recordPolicyApproval(job, 'SCRIPT', job.artifacts.scriptId, 'script passed deterministic validation');
      return this.transition(job, next);
    }
    const topic = await this.loadTopic(job);
    const research = await this.repo.requireArtifact(job.artifacts.researchId, 'research', ResearchPacketSchema);
    const revision = await this.repo.getLatestApproval(job.id, 'SCRIPT');
    const notes = revision?.decision === 'REVISIONS_REQUESTED' ? revision.directorNotes : undefined;
    const v = await this.variantOf(job);
    job = v.job;
    const variant = v.variant;

    const story = await new StoryEditorAgent(this.providers.llm).developStory(topic, research, notes);
    await this.repo.saveArtifact(job.id, 'story', story);
    const previous = await this.previousScripts(job.id);
    const format: ShortFormat =
      variant.format !== 'auto'
        ? variant.format
        : chooseFormat(
            topic,
            [...previous].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => ({ format: s.format })),
            this.enabledFormats(),
            await this.formatWeights()
          );
    const preflight = (items: Array<{ label: string; visualSubject: string; assetKeywords: string[]; visualExclusions: string[] }>) =>
      visualPreflight(this.providers.assets, items, {
        minRelevance: this.cfg.MEDIA_MIN_RELEVANCE,
        maxDownloadBytes: this.cfg.MAX_DOWNLOAD_BYTES,
        // A beat is one 2-3.5 s shot; a scene-level subject has to cover several.
        minCandidates: FORMATS[format].beats ? this.cfg.MEDIA_PREFLIGHT_MIN_BEAT_CANDIDATES : this.cfg.MEDIA_PREFLIGHT_MIN_CANDIDATES,
      });
    const writer = new ScriptwriterAgent(
      this.providers.llm,
      {
        graphicsMaxShare: FORMATS[format].beats && this.graphicRenderer() ? this.cfg.GRAPHICS_MAX_SHARE : 0,
        rules: this.rules(format, variant),
        maxAttempts: this.cfg.SCRIPT_MAX_ATTEMPTS,
        format: FORMATS[format],
        topic,
        hookType: variant.hookType,
        titleCard: variant.titleCard && FORMATS[format].beats,
        visualPreflight: preflight,
      },
      this.providers.verifierLlm
    );
    const ctx = { previousTitles: previous.map((s) => s.title), previousHooks: previous.map((s) => s.hookText) };
    // Writer → editor → bounded revisions. The editor is a separate stage; revisions go back through
    // the writer and all of its validators (contract, footage preflight, fact review).
    let script = await writer.writeScript(story, research, { ...ctx, directorNotes: notes });
    let review: ScriptReview | null = null;
    if (this.cfg.EDITOR_ENABLED) {
      const editor = new ScriptEditor(this.providers.verifierLlm, { minTotal: this.cfg.EDITOR_MIN_TOTAL, minHook: this.cfg.EDITOR_MIN_HOOK, minPayoff: this.cfg.EDITOR_MIN_PAYOFF });
      const facts = research.claims.filter((c) => c.verificationStatus === 'VERIFIED').map((c) => c.text);
      for (let rev = 0; ; rev++) {
        review = await editor.review(script, facts, rev);
        await this.repo.saveArtifact(job.id, 'script_review', review);
        writeJson(path.join(job.workDir, 'script', `review-${rev}.json`), review);
        if (review.passed) break;
        if (rev >= this.cfg.EDITOR_MAX_REVISIONS) {
          throw new ValidationError(
            `Script editor did not approve the script after ${rev} revision(s): ${review.total}/20 (hook ${review.scores.hook}, payoff ${review.scores.payoff})`,
            review.notes
          );
        }
        script = await writer.writeScript(story, research, { ...ctx, directorNotes: [notes, revisionNotes(script, review)].filter(Boolean).join('\n\n') });
      }
    }
    await this.repo.saveArtifact(job.id, 'script', script);
    writeJson(path.join(job.workDir, 'script', 'story.json'), story);
    writeJson(path.join(job.workDir, 'script', 'script.json'), script);
    const artifacts = { ...job.artifacts, storyId: story.id, scriptId: script.id, ...(review ? { scriptReviewId: review.id } : {}) };
    if (next === 'SYNTHESIZING_VOICE') await this.recordPolicyApproval(job, 'SCRIPT', script.id, 'script passed deterministic validation');
    return this.transition(
      job,
      next,
      artifacts,
      `${script.format} script ${script.totalWords} words (attempt ${script.generationAttempts})${review ? `, editor ${review.total}/20 after ${review.revision} revision(s)` : ''}`
    );
  }

  private async stageVoice(job: Job): Promise<Job> {
    if (job.artifacts.narrationId) {
      const n = await this.repo.getArtifact(job.artifacts.narrationId, 'narration', VoiceNarrationSchema);
      if (n && fs.existsSync(n.audioPath) && (await sha256File(n.audioPath)) === n.sha256) return this.transition(job, 'BUILDING_TIMELINE');
    }
    const script = await this.repo.requireArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema);
    const { variant } = await this.variantOf(job);
    const narration = await new VoiceAgent(this.providers.tts, {
      // Only a non-default speed is sent (and keyed in the cache); the default keeps existing cache entries valid.
      speed: variant.voiceSpeed !== this.cfg.ELEVENLABS_SPEED ? variant.voiceSpeed : undefined,
      continuity: {
        leadSeconds: 0.08,
        gapTargetSeconds: this.cfg.NARRATION_GAP_TARGET_SECONDS,
        tailSeconds: 0.4,
        speechStartMax: this.cfg.SPEECH_START_MAX_SECONDS,
        maxGap: this.cfg.MAX_SPEECH_GAP_SECONDS,
      },
      targetLufs: this.cfg.LOUDNESS_TARGET_LUFS,
      toleranceLu: this.cfg.LOUDNESS_TOLERANCE_LU,
      minSeconds: this.cfg.SHORT_MIN_SECONDS,
      maxSeconds: this.cfg.SHORT_MAX_SECONDS,
      tailSeconds: TAIL_SECONDS,
      ttsCacheDir: cacheDir(this.cfg.outputDir, 'tts'),
      creditPreflight: this.cfg.ELEVENLABS_CREDIT_PREFLIGHT,
    }).generateVoiceover(script, path.join(job.workDir, 'audio'));
    await this.repo.saveArtifact(job.id, 'narration', narration);
    writeJson(path.join(job.workDir, 'audio', 'narration.json'), narration);
    return this.transition(job, 'BUILDING_TIMELINE', { ...job.artifacts, narrationId: narration.id }, `narration ${narration.durationSeconds.toFixed(2)}s`);
  }

  private async loadTimeline(job: Job): Promise<Timeline> {
    if (!job.artifacts.timelinePath || !fs.existsSync(job.artifacts.timelinePath)) throw new InternalError('timeline artifact missing');
    return TimelineSchema.parse(JSON.parse(fs.readFileSync(job.artifacts.timelinePath, 'utf-8')));
  }

  private async stageTimeline(job: Job): Promise<Job> {
    if (job.artifacts.timelinePath && fs.existsSync(job.artifacts.timelinePath)) return this.transition(job, 'SOURCING_MEDIA');
    const script = await this.repo.requireArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema);
    const narration = await this.repo.requireArtifact(job.artifacts.narrationId, 'narration', VoiceNarrationSchema);
    const timeline = buildTimeline(script, narration, {
      fps: 30,
      tailSeconds: TAIL_SECONDS,
      layout: this.layout,
      minShotSeconds: this.cfg.MIN_SHOT_SECONDS,
      maxShotSeconds: this.cfg.MAX_SHOT_SECONDS,
    });
    const timelinePath = path.join(job.workDir, 'captions', 'timeline.json');
    writeJson(timelinePath, timeline);
    return this.transition(job, 'SOURCING_MEDIA', { ...job.artifacts, timelinePath }, `${timeline.scenes.length} scenes, ${timeline.captions.length} caption cues, ${timeline.totalDurationSeconds.toFixed(2)}s`);
  }

  private async loadAssets(job: Job): Promise<AssetDescriptor[]> {
    const ids = job.artifacts.assetIds ?? [];
    return Promise.all(ids.map((id) => this.repo.requireArtifact(id, 'asset', AssetDescriptorSchema)));
  }

  private async stageMedia(job: Job): Promise<Job> {
    const script = await this.repo.requireArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema);
    const timelineForCount = await this.loadTimeline(job);
    if (job.artifacts.assetIds?.length === timelineForCount.shots.length) {
      const assets = await this.loadAssets(job);
      if (assets.every((a) => fs.existsSync(a.localPath))) return this.transition(job, 'RENDERING');
    }
    const timeline = await this.loadTimeline(job);
    const llm = this.providers.llm;
    const refiner = async (scene: { narration: string; visualObjective: string; failedKeywords: string[] }) => {
      const res = await llm.generateStructured({
        task: 'media_keywords',
        system: 'You pick search terms for generic stock-footage libraries (Pixabay-style tags).',
        prompt: `No usable stock footage was found for these keywords: ${scene.failedKeywords.join(', ')}.
Scene narration: ${JSON.stringify(scene.narration)}
What the viewer should see: ${JSON.stringify(scene.visualObjective)}

Suggest 4 simpler alternatives that a general stock library is likely to have and that still fit the scene visually: common nouns or noun pairs (1-2 words), no names, places, dates or numbers. Put the most fitting first.`,
        schemaHint: '{"keywords":["string"]}',
        schema: z.object({ keywords: z.array(z.string().min(2)).min(2).max(6) }),
        validate: (v) => (v.keywords.some((k) => /\d/.test(k) || k.split(/\s+/).length > 3) ? ['keywords must be 1-3 words without numbers'] : []),
        temperature: 0.3,
        maxTokens: 200,
      });
      return res.content.keywords;
    };
    const verifier = this.providers.verifierLlm;
    const judge = async (scene: SceneVisualBrief, candidates: Array<{ key: string; mediaType: string; tags: string[]; description: string }>) => {
      const ids = candidates.map((_, i) => `M${i + 1}`);
      const res = await verifier.generateStructured({
        task: 'media_fit',
        system: 'You are a documentary picture editor choosing stock footage. Judge only from the tags provided.',
        prompt: `Scene narration: ${JSON.stringify(scene.narration)}
Viewer should see: ${JSON.stringify(scene.visualSubject)} — ${JSON.stringify(scene.visualObjective)}
Must not show: ${scene.visualExclusions.length ? scene.visualExclusions.join(', ') : '(none specified)'}

Stock candidates (tags describe their content):
${candidates.map((c, i) => `[${ids[i]}] ${c.mediaType.toLowerCase()}: ${c.tags.join(', ')}`).join('\n')}

Mark a candidate "fit" only if its content would look appropriate to a viewer while hearing this narration — generic b-roll is fine, but reject anything whose subject contradicts, trivialises or is unrelated to the scene (e.g. a wedding over a disease, a cartoon over a tragedy).`,
        schemaHint: `{"fit":["M1"],"unfit":["M2"]} — every id from ${ids[0]} to ${ids[ids.length - 1]} must appear in exactly one of the two lists`,
        schema: z.object({ fit: z.array(z.string()), unfit: z.array(z.string()) }),
        validate: (v) => {
          const seen = new Set([...v.fit, ...v.unfit]);
          const missing = ids.filter((i) => !seen.has(i));
          const both = v.fit.filter((i) => v.unfit.includes(i));
          return [...(missing.length ? [`ids missing from both lists: ${missing.join(', ')}`] : []), ...(both.length ? [`ids in both lists: ${both.join(', ')}`] : [])];
        },
        temperature: 0,
        maxTokens: 800,
      });
      return new Set(res.content.fit.map((id) => candidates[ids.indexOf(id)]?.key).filter((k): k is string => Boolean(k)));
    };
    // Vision check on real frames, only for candidates that passed every cheaper filter.
    const vision = async (scene: SceneVisualBrief, sheet: Buffer): Promise<SemanticVerdict> => {
      const res = await verifier.generateStructured({
        task: 'media_vision',
        system: 'You are a documentary picture editor reviewing stock footage frames. Judge only what is visible in the image.',
        prompt: `The image shows sampled frames from one stock clip (left to right = start to end).

Scene narration: ${JSON.stringify(scene.narration)}
Required subject on screen: ${JSON.stringify(scene.visualSubject)}
Must not show: ${scene.visualExclusions.length ? scene.visualExclusions.join(', ') : '(none specified)'}

verdict:
- ACCEPT: the frames clearly show the required subject (or obviously suitable b-roll for it) and nothing inappropriate.
- REJECT: wrong subject, an excluded subject, visible watermarks/logos/text overlays, cartoons/illustrations for a factual scene, green-screen or production plates, broken or blank frames.
- UNSURE: plausible but you cannot tell whether it matches.`,
        schemaHint: '{"verdict":"ACCEPT|REJECT|UNSURE","showsSubject":true,"issues":["string"],"reason":"string"}',
        schema: z.object({ verdict: z.enum(['ACCEPT', 'REJECT', 'UNSURE']), showsSubject: z.boolean(), issues: z.array(z.string()).default([]), reason: z.string().default('') }),
        images: [{ mimeType: 'image/jpeg', data: sheet }],
        temperature: 0,
        maxTokens: 300,
      });
      return { ...res.content, model: res.model };
    };
    const agent = new VisualDirectorAgent(
      this.providers.assets,
      {
        mediaCacheDir: cacheDir(this.cfg.outputDir, 'media'),
        minRelevance: this.cfg.MEDIA_MIN_RELEVANCE,
        maxDownloadBytes: this.cfg.MAX_DOWNLOAD_BYTES,
        excludeMediaKeys: job.artifacts.excludedMediaKeys,
        maxUpscale: this.cfg.MAX_UPSCALE,
        graphics: this.graphicRenderer(),
      },
      refiner,
      judge,
      vision
    );
    const { assets, shots } = await agent.collectAssets(script, timeline, path.join(job.workDir, 'media'), async (a) => this.repo.saveArtifact(job.id, 'asset', a));
    if (shots.length !== timeline.shots.length) {
      // Some shots were merged for lack of distinct media: the timeline is the single source of truth, so persist it.
      writeJson(job.artifacts.timelinePath!, TimelineSchema.parse({ ...timeline, shots }));
    }
    writeJson(path.join(job.workDir, 'media', 'assets.json'), assets);
    return this.transition(job, 'RENDERING', { ...job.artifacts, assetIds: assets.map((a) => a.id) }, `${assets.length} assets validated`);
  }

  private async stageRender(job: Job): Promise<Job> {
    if (job.artifacts.renderId) {
      const r = await this.repo.getArtifact(job.artifacts.renderId, 'render', RenderJobSchema);
      if (r && fs.existsSync(r.videoPath) && r.sha256 && (await sha256File(r.videoPath)) === r.sha256) return this.transition(job, 'QA');
    }
    const script = await this.repo.requireArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema);
    const narration = await this.repo.requireArtifact(job.artifacts.narrationId, 'narration', VoiceNarrationSchema);
    const timeline = await this.loadTimeline(job);
    const assets = await this.loadAssets(job);
    const renderDir = path.join(job.workDir, 'render');
    fs.rmSync(renderDir, { recursive: true, force: true });
    const { variant } = await this.variantOf(job);
    // Music: only an approved, evidenced track from the local library; otherwise narration only (recorded).
    let music: { track: LoadedTrack; gainDb: number; bedLu: number } | null = null;
    let musicDisabledReason: string | undefined;
    if (!variant.music) musicDisabledReason = 'music off for this variant';
    else {
      const lib = await loadMusicLibrary(resolveFromRoot(this.cfg.MUSIC_LIBRARY));
      const track = selectTrack(lib.tracks, job.id);
      if (track) music = { track, gainDb: bedGainDb(narration.integratedLufs, track.integratedLufs, this.cfg.MUSIC_BED_LU), bedLu: this.cfg.MUSIC_BED_LU };
      else musicDisabledReason = `no approved music track (${lib.problems.slice(0, 3).join('; ') || 'library empty'})`;
      if (musicDisabledReason) this.log.warn(`Music bed disabled: ${musicDisabledReason}`, { jobId: job.id, stage: 'RENDERING' });
    }
    const { render } = await new VideoRenderer().render({
      script,
      timeline,
      narration,
      assets,
      renderDir,
      fontFile: this.cfg.captionFontFile,
      layout: this.layout,
      captionStyle: variant.captionStyle,
      titleCard: variant.titleCard ? script.titleCard ?? null : null,
      music,
      musicDisabledReason,
    });
    await this.repo.saveArtifact(job.id, 'render', render);
    return this.transition(job, 'QA', { ...job.artifacts, renderId: render.id, captionsPath: render.captionsPath }, `rendered ${render.durationSeconds.toFixed(2)}s`);
  }

  private async stageQA(job: Job): Promise<Job> {
    const topic = await this.loadTopic(job);
    const research = await this.repo.requireArtifact(job.artifacts.researchId, 'research', ResearchPacketSchema);
    const script = await this.repo.requireArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema);
    const narration = await this.repo.requireArtifact(job.artifacts.narrationId, 'narration', VoiceNarrationSchema);
    const render = await this.repo.requireArtifact(job.artifacts.renderId, 'render', RenderJobSchema);
    const timeline = await this.loadTimeline(job);
    const assets = await this.loadAssets(job);
    const renderDir = path.dirname(render.videoPath);

    const media = await evaluateMedia({
      videoPath: render.videoPath,
      uncaptionedPath: path.join(renderDir, 'video_uncaptioned.mp4'),
      narration,
      timeline,
      renderDir,
      layout: this.layout,
      limits: {
        minSeconds: this.cfg.SHORT_MIN_SECONDS,
        maxSeconds: this.cfg.SHORT_MAX_SECONDS,
        targetLufs: this.cfg.LOUDNESS_TARGET_LUFS,
        toleranceLu: this.cfg.LOUDNESS_TOLERANCE_LU,
        truePeakMax: -1,
        // Continuity/pace checks apply to narrations produced with the continuity stage.
        ...(narration.processing
          ? { speechStartMax: this.cfg.SPEECH_START_MAX_SECONDS, maxSpeechGap: this.cfg.MAX_SPEECH_GAP_SECONDS, paceMin: this.cfg.PACE_MIN_WPS, paceMax: this.cfg.PACE_MAX_WPS }
          : {}),
        fullBleedMinRatio: this.cfg.FULL_BLEED_MIN_RATIO,
        maxUpscale: this.cfg.MAX_UPSCALE,
      },
      framing: assets.map((a) => {
        const f = framingOf(a);
        return { label: `${a.sceneNumber}.${a.shotIndex}`, mode: f.mode, upscale: f.upscale, reason: f.reason };
      }),
      music: { requested: (await this.variantOf(job)).variant.music, trackId: render.music?.trackId ?? null, disabledReason: render.musicDisabledReason, gainDb: render.music?.gainDb, trackLufs: render.music?.trackLufs },
    });
    const previous = await this.previousScripts(job.id);
    const content = await new ContentQA(this.providers.verifierLlm).evaluate({
      script,
      research,
      assets,
      metadata: buildMetadata(script, topic, this.cfg),
      rules: this.rules(script.format, (await this.variantOf(job)).variant),
      scriptReview: job.artifacts.scriptReviewId ? await this.repo.getArtifact(job.artifacts.scriptReviewId, 'script_review', ScriptReviewSchema) : null,
      minVerifiedClaims: this.cfg.MIN_VERIFIED_CLAIMS,
      minRelevance: this.cfg.MEDIA_MIN_RELEVANCE,
      previousTitles: previous.map((s) => s.title),
      previousHooks: previous.map((s) => s.hookText),
      shots: timeline.shots,
    });
    const blockingReasons = [...media.blockingReasons.map((r) => `media.${r}`), ...content.blockingReasons.map((r) => `content.${r}`)];
    const overallStatus = media.overallStatus === 'FAIL' || content.overallStatus === 'FAIL' ? 'FAIL' : media.overallStatus === 'WARN' || content.overallStatus === 'WARN' ? 'WARN' : 'PASS';
    const qa: QAResult = QAResultSchema.parse({
      id: randomUUID(),
      jobId: job.id,
      renderId: render.id,
      scriptId: script.id,
      videoSha256: await sha256File(render.videoPath),
      media,
      content,
      overallStatus,
      publishEligible: media.publishEligible && content.publishEligible,
      blockingReasons,
      requiresHumanReview: media.requiresHumanReview || content.requiresHumanReview,
      reviewReasons: [...media.reviewReasons.map((r) => `media.${r}`), ...content.reviewReasons.map((r) => `content.${r}`)],
      evaluatedAt: new Date().toISOString(),
    });
    await this.repo.saveArtifact(job.id, 'qa', qa);
    writeJson(path.join(job.workDir, 'qa', 'qa.json'), qa);
    const artifacts = { ...job.artifacts, qaId: qa.id };
    await this.repo.updateJobArtifacts(job.id, artifacts);
    job = { ...job, artifacts };

    if (!qa.publishEligible) throw new QAFailedError(`QA ${qa.overallStatus}: not publish-eligible`, blockingReasons);

    const finalDir = path.join(job.workDir, 'final');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.copyFileSync(render.videoPath, path.join(finalDir, 'short.mp4'));
    if (this.cfg.APPROVAL_FINAL === 'auto_after_qa' && !qa.requiresHumanReview) {
      await this.recordPolicyApproval(job, 'FINAL_VIDEO', render.id, `QA ${qa.overallStatus}, publish-eligible, no review flags`);
      return this.transition(job, 'READY_TO_PUBLISH', artifacts, 'final video auto-approved after objective QA');
    }
    if (qa.requiresHumanReview) this.log.warn(`Human review required before publication: ${qa.reviewReasons.join(' | ')}`, { jobId: job.id, stage: 'QA' });
    return this.transition(job, 'AWAITING_FINAL_APPROVAL', artifacts, qa.requiresHumanReview ? `QA ${qa.overallStatus}; human review required` : `QA ${qa.overallStatus}`);
  }

  private async stagePublish(job: Job): Promise<Job> {
    const topic = await this.loadTopic(job);
    const script = await this.repo.requireArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema);
    const existing = await this.repo.getPublishForJob(job.id);
    if (existing?.status === 'PUBLISHED') {
      // Upload completed but state was not recorded (crash): finish bookkeeping without re-uploading.
      const publishing = await this.transition(job, 'PUBLISHING', { ...job.artifacts, publishId: existing.id }, 'reconciling completed publication');
      return this.transition(publishing, 'PUBLISHED');
    }
    if (existing) throw new ValidationError(`A ${existing.status} publication record already exists for this job; reconcile manually`);

    const gate = await assertPublishable(job, this.repo, this.cfg, script, topic);
    const { render } = gate;
    let metadata = gate.metadata;
    const sha = await sha256File(render.videoPath);
    const dupe = await this.repo.findPublishByVideo(sha, this.providers.publisher.target);
    if (dupe) throw new ValidationError(`This exact video was already published by job ${dupe.jobId}`);

    // Scheduled public release: only an audited API project can make uploads public (else locked private).
    let scheduledFor: string | undefined;
    if (this.providers.publisher.target === 'youtube' && this.cfg.YOUTUBE_PROJECT_AUDITED && this.cfg.YOUTUBE_DEFAULT_PRIVACY === 'public') {
      const taken = (await this.repo.listPublished('youtube')).filter((p) => p.scheduledFor).map((p) => new Date(p.scheduledFor!));
      scheduledFor = nextPublishSlot(new Date(), this.cfg.PUBLISH_SLOTS.split(','), this.cfg.PUBLISH_TIMEZONE, taken).toISOString();
      metadata = { ...metadata, publishAt: scheduledFor };
    }

    const publishId = randomUUID();
    const startedAt = new Date().toISOString();
    const record = { id: publishId, jobId: job.id, renderId: render.id, target: this.providers.publisher.target, status: 'PUBLISHING' as const, videoSha256: sha, metadata, startedAt, uploadAttempted: true, scheduledFor };
    await this.repo.insertPublish(record);
    let publishing = await this.transition(job, 'PUBLISHING', { ...job.artifacts, publishId }, `publishing to ${this.providers.publisher.name}`);
    try {
      const result = await this.providers.publisher.publish({ jobId: job.id, videoPath: render.videoPath, metadata });
      await this.repo.updatePublish({ ...record, status: 'PUBLISHED', externalId: result.externalId, url: result.url, publishedAt: new Date().toISOString() });
      await this.repo.updateTopicStatus(topic.id, 'USED');
      publishing = await this.transition(publishing, 'PUBLISHED', undefined, `published: ${result.url}`);
      return publishing;
    } catch (err) {
      // Unknown failure modes are treated as "upload may have happened" (no automatic retry).
      const uploadAttempted = !(err instanceof PublishError && !err.uploadStarted);
      await this.repo.updatePublish({ ...record, status: 'FAILED', uploadAttempted, error: (err as Error).message.slice(0, 2000) });
      throw err instanceof PipelineError ? err : toPipelineError(err);
    }
  }

  /**
   * Retry a failed publication only when it is provably safe: the failure happened before any video
   * bytes could reach the target (uploadAttempted=false). Everything else requires manual reconciliation.
   */
  async retryPublish(jobId: string): Promise<Job> {
    const job = await this.repo.requireJob(jobId);
    const pub = await this.repo.getPublishForJob(jobId);
    if (job.state !== 'FAILED' || job.failedStage !== 'PUBLISHING') throw new ValidationError(`Job is ${job.state}; only jobs that failed while publishing can retry publication`);
    if (!pub || pub.status !== 'FAILED') throw new ValidationError('No failed publication record for this job');
    if (pub.uploadAttempted) throw new ValidationError('The upload may have reached the target; check the channel and reconcile manually instead of retrying');
    // Atomic: either the failed record is cleared AND the job re-armed, or neither (CAS on FAILED).
    await this.repo.db.transaction(async () => {
      await this.repo.deletePublish(pub.id);
      await this.repo.updateJobState(jobId, 'FAILED', {
        state: 'READY_TO_PUBLISH',
        failedStage: null,
        errorKind: null,
        errorMessage: null,
        retryable: null,
        incrementAttempts: true,
        message: `publication retry; previous attempt failed before upload: ${(pub.error ?? 'unknown error').slice(0, 300)}`,
      });
    });
    return this.run(jobId);
  }

  // ===========================================================================
  // Reporting
  // ===========================================================================

  async report(jobId: string): Promise<Record<string, unknown>> {
    const job = await this.repo.requireJob(jobId);
    const a = job.artifacts;
    const topic = a.topicId ? await this.repo.getTopic(a.topicId) : null;
    const research = a.researchId ? await this.repo.getArtifact(a.researchId, 'research', ResearchPacketSchema) : null;
    const script = a.scriptId ? await this.repo.getArtifact(a.scriptId, 'script', ShortScriptSchema) : null;
    const narration = a.narrationId ? await this.repo.getArtifact(a.narrationId, 'narration', VoiceNarrationSchema) : null;
    const render = a.renderId ? await this.repo.getArtifact(a.renderId, 'render', RenderJobSchema) : null;
    const qa = a.qaId ? await this.repo.getArtifact(a.qaId, 'qa', QAResultSchema) : null;
    const assets = a.assetIds ? await this.loadAssets(job).catch(() => []) : [];
    const publish = await this.repo.getPublishForJob(job.id);
    const runs = await this.repo.providerRunSummary(job.id);
    // Every editor pass (including rejected drafts) is kept on disk next to the script.
    const scriptDir = path.join(job.workDir, 'script');
    const editorReviews = fs.existsSync(scriptDir)
      ? fs
          .readdirSync(scriptDir)
          .filter((f) => /^review-\d+\.json$/.test(f))
          .map((f) => ScriptReviewSchema.safeParse(JSON.parse(fs.readFileSync(path.join(scriptDir, f), 'utf-8'))))
          .filter((r) => r.success)
          .map((r) => r.data!)
          .sort((x, y) => x.revision - y.revision)
          .map((r) => ({ revision: r.revision, scores: r.scores, total: r.total, passed: r.passed, notes: r.notes }))
      : [];
    return {
      job: { id: job.id, mode: job.mode, state: job.state, failedStage: job.failedStage, errorKind: job.errorKind, errorMessage: job.errorMessage, retryable: job.retryable, attempts: job.attempts, workDir: job.workDir },
      topic: topic && { title: topic.title, pillar: topic.pillar },
      research: research && {
        sources: research.sources.length,
        claims: research.claims.length,
        verifiedClaims: research.verifiedClaimCount,
        sourceTiers: research.sources.map((s) => `${s.credibility?.tier ?? 'UNASSESSED'} ${s.publisher}`),
        unverified: research.claims.filter((c) => c.verificationStatus !== 'VERIFIED').map((c) => ({ text: c.text, reason: c.verificationReason })),
      },
      variant: a.variant ?? null,
      script: script && {
        title: script.title,
        format: script.format,
        words: script.totalWords,
        scenes: script.scenes.length,
        beats: script.scenes.reduce((n, s) => n + (s.beats?.length ?? 0), 0),
        attempts: script.generationAttempts,
        hookType: script.hookType ?? null,
        hook: script.hookText,
        titleCard: script.titleCard ?? null,
      },
      editorReviews,
      narration: narration && {
        durationSeconds: narration.durationSeconds,
        words: narration.wordTimestamps.length,
        wordsPerSecond: narration.wordTimestamps.length ? Math.round((narration.wordTimestamps.length / narration.wordTimestamps[narration.wordTimestamps.length - 1].end) * 100) / 100 : null,
        speechStart: narration.wordTimestamps[0]?.start ?? null,
        lufs: narration.integratedLufs,
        truePeak: narration.truePeakDb,
        processing: narration.processing ?? null,
      },
      media: assets.map((x) => ({ scene: x.sceneNumber, provider: x.provider, id: x.providerAssetId, type: x.assetType, size: `${x.width}x${x.height}`, score: x.ranking.score, relevance: x.ranking.relevance, matched: x.ranking.matchedTerms, framing: x.framing ?? null, visual: x.visualValidation && { decision: x.visualValidation.decision, defects: x.visualValidation.defects, semantic: x.visualValidation.semantic?.verdict ?? null, reason: x.visualValidation.semantic?.reason } })),
      render: render && { path: render.videoPath, durationSeconds: render.durationSeconds, sha256: render.sha256, music: render.music ?? null, musicDisabledReason: render.musicDisabledReason ?? null, titleCard: render.titleCard ?? null, captionStyle: render.captionStyle ?? null },
      qa: qa && { overall: qa.overallStatus, publishEligible: qa.publishEligible, blocking: qa.blockingReasons, requiresHumanReview: qa.requiresHumanReview, reviewReasons: qa.reviewReasons, checks: [...qa.media.checks, ...qa.content.checks].map((c) => `${c.status} ${c.id}: ${c.message}`) },
      publish,
      providerCalls: runs,
      estimatedCostUsd: Math.round(runs.reduce((s, r) => s + r.costUsd, 0) * 10000) / 10000,
      events: await this.repo.listJobEvents(job.id),
    };
  }
}
