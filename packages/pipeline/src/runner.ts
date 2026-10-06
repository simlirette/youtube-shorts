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
  QAFailedError,
  STAGE_ORDER,
  ShortsRepository,
  TERMINAL_STATES,
  AWAITING_STATES,
  ValidationError,
  cacheDir,
  jobDir,
  logger as rootLogger,
  sha256File,
  toPipelineError,
} from '@shorts/core';
import { ProviderBundle, ProviderCallReport, createProviders } from '@shorts/providers';
import {
  ContentQA,
  DiscoveryAgent,
  DiscoveryResult,
  ResearchAgent,
  ScoringAgent,
  ScriptRules,
  ScriptwriterAgent,
  StoryEditorAgent,
  VisualDirectorAgent,
  VoiceAgent,
} from '@shorts/agents';
import { CAPTION_LAYOUT, CaptionLayout, VideoRenderer, buildTimeline, evaluateMedia } from '@shorts/rendering';
import { z } from 'zod';
import { assertPublishable, buildMetadata } from './publish-gate.js';

export interface RunOptions {
  pillar?: ContentPillar;
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

  private rules(): ScriptRules {
    return { minWords: this.cfg.SCRIPT_MIN_WORDS, maxWords: this.cfg.SCRIPT_MAX_WORDS, hookMaxWords: this.cfg.SCRIPT_HOOK_MAX_WORDS, sceneCount: 5, minClaimRefs: 3 };
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
    if (decision === 'REVISIONS_REQUESTED' && stage !== 'SCRIPT') throw new ValidationError('Revisions can only be requested for SCRIPT');
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

  private async fail(job: Job, err: unknown): Promise<void> {
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
        score = await scorer.scoreTopic(topic);
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
        const pool = [...(await this.repo.listTopics('DISCOVERED')), ...(await this.repo.listTopics('SCORED'))].filter(
          (t) => !opts.pillar || t.pillar === opts.pillar
        );
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
          const res = await this.discover(opts.pillar, 5);
          if (res.shortfall > 0) this.log.warn(`Discovery returned ${res.topics.length}/${res.requested} novel topics`, { jobId: job.id, stage: 'SELECTING_TOPIC', rejected: res.rejected });
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
    const { packet, sourceTexts } = await agent.conductResearch(topic);
    await this.repo.saveArtifact(job.id, 'research', packet);
    writeJson(path.join(job.workDir, 'research', 'research.json'), packet);
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

    const story = await new StoryEditorAgent(this.providers.llm).developStory(topic, research, notes);
    await this.repo.saveArtifact(job.id, 'story', story);
    const previous = await this.previousScripts(job.id);
    const script = await new ScriptwriterAgent(this.providers.llm, { rules: this.rules(), maxAttempts: this.cfg.SCRIPT_MAX_ATTEMPTS }, this.providers.verifierLlm).writeScript(story, research, {
      previousTitles: previous.map((s) => s.title),
      previousHooks: previous.map((s) => s.hookText),
      directorNotes: notes,
    });
    await this.repo.saveArtifact(job.id, 'script', script);
    writeJson(path.join(job.workDir, 'script', 'story.json'), story);
    writeJson(path.join(job.workDir, 'script', 'script.json'), script);
    const artifacts = { ...job.artifacts, storyId: story.id, scriptId: script.id };
    if (next === 'SYNTHESIZING_VOICE') await this.recordPolicyApproval(job, 'SCRIPT', script.id, 'script passed deterministic validation');
    return this.transition(job, next, artifacts, `script ${script.totalWords} words (attempt ${script.generationAttempts})`);
  }

  private async stageVoice(job: Job): Promise<Job> {
    if (job.artifacts.narrationId) {
      const n = await this.repo.getArtifact(job.artifacts.narrationId, 'narration', VoiceNarrationSchema);
      if (n && fs.existsSync(n.audioPath) && (await sha256File(n.audioPath)) === n.sha256) return this.transition(job, 'BUILDING_TIMELINE');
    }
    const script = await this.repo.requireArtifact(job.artifacts.scriptId, 'script', ShortScriptSchema);
    const narration = await new VoiceAgent(this.providers.tts, {
      targetLufs: this.cfg.LOUDNESS_TARGET_LUFS,
      toleranceLu: this.cfg.LOUDNESS_TOLERANCE_LU,
      minSeconds: this.cfg.SHORT_MIN_SECONDS,
      maxSeconds: this.cfg.SHORT_MAX_SECONDS,
      tailSeconds: TAIL_SECONDS,
      ttsCacheDir: cacheDir(this.cfg.outputDir, 'tts'),
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
    const timeline = buildTimeline(script, narration, { fps: 30, tailSeconds: TAIL_SECONDS, layout: this.layout });
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
    const judge = async (scene: { narration: string; visualObjective: string }, candidates: Array<{ key: string; mediaType: string; tags: string[]; description: string }>) => {
      const ids = candidates.map((_, i) => `M${i + 1}`);
      const res = await verifier.generateStructured({
        task: 'media_fit',
        system: 'You are a documentary picture editor choosing stock footage. Judge only from the tags provided.',
        prompt: `Scene narration: ${JSON.stringify(scene.narration)}
Viewer should see: ${JSON.stringify(scene.visualObjective)}

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
    const agent = new VisualDirectorAgent(
      this.providers.assets,
      { mediaCacheDir: cacheDir(this.cfg.outputDir, 'media'), minRelevance: this.cfg.MEDIA_MIN_RELEVANCE, maxDownloadBytes: this.cfg.MAX_DOWNLOAD_BYTES },
      refiner,
      judge
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
    const { render } = await new VideoRenderer().render({ script, timeline, narration, assets, renderDir, fontFile: this.cfg.captionFontFile, layout: this.layout });
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
      limits: { minSeconds: this.cfg.SHORT_MIN_SECONDS, maxSeconds: this.cfg.SHORT_MAX_SECONDS, targetLufs: this.cfg.LOUDNESS_TARGET_LUFS, toleranceLu: this.cfg.LOUDNESS_TOLERANCE_LU },
    });
    const previous = await this.previousScripts(job.id);
    const content = await new ContentQA(this.providers.verifierLlm).evaluate({
      script,
      research,
      assets,
      metadata: buildMetadata(script, topic, this.cfg),
      rules: this.rules(),
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
    if (this.cfg.APPROVAL_FINAL === 'auto_after_qa') {
      await this.recordPolicyApproval(job, 'FINAL_VIDEO', render.id, `QA ${qa.overallStatus}, publish-eligible`);
      return this.transition(job, 'READY_TO_PUBLISH', artifacts, 'final video auto-approved after objective QA');
    }
    return this.transition(job, 'AWAITING_FINAL_APPROVAL', artifacts, `QA ${qa.overallStatus}`);
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

    const { render, metadata } = await assertPublishable(job, this.repo, this.cfg, script, topic);
    const sha = await sha256File(render.videoPath);
    const dupe = await this.repo.findPublishByVideo(sha, this.providers.publisher.target);
    if (dupe) throw new ValidationError(`This exact video was already published by job ${dupe.jobId}`);

    const publishId = randomUUID();
    const startedAt = new Date().toISOString();
    const record = { id: publishId, jobId: job.id, renderId: render.id, target: this.providers.publisher.target, status: 'PUBLISHING' as const, videoSha256: sha, metadata, startedAt };
    await this.repo.insertPublish(record);
    let publishing = await this.transition(job, 'PUBLISHING', { ...job.artifacts, publishId }, `publishing to ${this.providers.publisher.name}`);
    try {
      const result = await this.providers.publisher.publish({ jobId: job.id, videoPath: render.videoPath, metadata });
      await this.repo.updatePublish({ ...record, status: 'PUBLISHED', externalId: result.externalId, url: result.url, publishedAt: new Date().toISOString() });
      await this.repo.updateTopicStatus(topic.id, 'USED');
      publishing = await this.transition(publishing, 'PUBLISHED', undefined, `published: ${result.url}`);
      return publishing;
    } catch (err) {
      await this.repo.updatePublish({ ...record, status: 'FAILED', error: (err as Error).message.slice(0, 2000) });
      throw err instanceof PipelineError ? err : toPipelineError(err);
    }
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
    return {
      job: { id: job.id, mode: job.mode, state: job.state, failedStage: job.failedStage, errorKind: job.errorKind, errorMessage: job.errorMessage, retryable: job.retryable, attempts: job.attempts, workDir: job.workDir },
      topic: topic && { title: topic.title, pillar: topic.pillar },
      research: research && {
        sources: research.sources.length,
        claims: research.claims.length,
        verifiedClaims: research.verifiedClaimCount,
        unverified: research.claims.filter((c) => c.verificationStatus !== 'VERIFIED').map((c) => ({ text: c.text, reason: c.verificationReason })),
      },
      script: script && { title: script.title, words: script.totalWords, scenes: script.scenes.length, attempts: script.generationAttempts, hook: script.hookText },
      narration: narration && { durationSeconds: narration.durationSeconds, words: narration.wordTimestamps.length, lufs: narration.integratedLufs, truePeak: narration.truePeakDb },
      media: assets.map((x) => ({ scene: x.sceneNumber, provider: x.provider, id: x.providerAssetId, type: x.assetType, size: `${x.width}x${x.height}`, score: x.ranking.score, relevance: x.ranking.relevance, matched: x.ranking.matchedTerms })),
      render: render && { path: render.videoPath, durationSeconds: render.durationSeconds, sha256: render.sha256 },
      qa: qa && { overall: qa.overallStatus, publishEligible: qa.publishEligible, blocking: qa.blockingReasons, checks: [...qa.media.checks, ...qa.content.checks].map((c) => `${c.status} ${c.id}: ${c.message}`) },
      publish,
      providerCalls: runs,
      estimatedCostUsd: Math.round(runs.reduce((s, r) => s + r.costUsd, 0) * 10000) / 10000,
      events: await this.repo.listJobEvents(job.id),
    };
  }
}
