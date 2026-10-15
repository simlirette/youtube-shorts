import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { ApprovalStageSchema, CONTENT_PILLARS, ContentPillar, Job, JobStateSchema, PipelineMode } from '@shorts/schemas';
import {
  AppConfig,
  PipelineError,
  ShortsRepository,
  ValidationError,
  configForMode,
  createDatabase,
  getConfig,
  logger,
  repoRoot,
  runProcess,
  upsertEnvVar,
  UsageBudget,
} from '@shorts/core';
import { YouTubeAnalyticsClient, findClaudeCli, freeTierUsageFile, missingLiveCredentials, runLoopbackAuth, subscriptionOnlyEnv } from '@shorts/providers';
import { PipelineRunner } from '@shorts/pipeline';
import { findBlender, loadMusicLibrary } from '@shorts/rendering';

const program = new Command();
program.name('shorts').description('YouTube Shorts production engine').version('0.2.0');

const modeOption = () => new Option('--mode <mode>', 'execution mode (required unless PIPELINE_MODE is set)').choices(['mock', 'live']);

function resolveMode(cfg: AppConfig, flag?: string): PipelineMode {
  const mode = (flag ?? cfg.PIPELINE_MODE) as PipelineMode | undefined;
  if (!mode) throw new ValidationError('Choose an execution mode explicitly: --mode mock|live (or set PIPELINE_MODE)');
  return mode;
}

function banner(mode: PipelineMode): void {
  const line =
    mode === 'live'
      ? 'MODE: LIVE — real providers (OpenAI/Tavily/ElevenLabs/stock media), real API cost'
      : 'MODE: MOCK — deterministic local providers, no external calls';
  process.stderr.write(`\n=== ${line} ===\n\n`);
}

async function openRepo(cfg: AppConfig): Promise<ShortsRepository> {
  const repo = new ShortsRepository(createDatabase(cfg));
  await repo.init();
  return repo;
}

async function setup(modeFlag?: string): Promise<{ cfg: AppConfig; repo: ShortsRepository; runner: PipelineRunner }> {
  const base = getConfig();
  const mode = resolveMode(base, modeFlag);
  const cfg = configForMode(base, mode);
  banner(mode);
  const repo = new ShortsRepository(createDatabase(cfg));
  await repo.init();
  const runner = new PipelineRunner(cfg, repo, { mode });
  return { cfg, repo, runner };
}

async function resolveJobId(repo: ShortsRepository, idOrPrefix: string): Promise<string> {
  const job = (await repo.getJob(idOrPrefix)) ?? (await repo.findJobByPrefix(idOrPrefix));
  if (!job) throw new ValidationError(`No job matches "${idOrPrefix}"`);
  return job.id;
}

function printJob(job: Job): void {
  const status = job.state === 'FAILED' ? `FAILED at ${job.failedStage} (${job.errorKind}${job.retryable ? ', retryable' : ''}): ${job.errorMessage}` : job.state;
  console.log(`Job ${job.id} [${job.mode}] → ${status}`);
  console.log(`  work dir: ${job.workDir}`);
  if (job.state === 'AWAITING_IDEA_APPROVAL') console.log(`  next: shorts approve ${job.id.slice(0, 8)} IDEA   (or --reject)`);
  if (job.state === 'AWAITING_SCRIPT_APPROVAL') console.log(`  next: review ${job.workDir}/script/script.json, then shorts approve ${job.id.slice(0, 8)} SCRIPT`);
  if (job.state === 'AWAITING_FINAL_APPROVAL') console.log(`  next: watch ${job.workDir}/final/short.mp4, then shorts approve ${job.id.slice(0, 8)} FINAL_VIDEO`);
  if (job.state === 'READY_TO_PUBLISH') console.log(`  next: shorts publish ${job.id.slice(0, 8)}`);
  if (job.state === 'FAILED' && job.failedStage !== 'PUBLISHING') console.log(`  resume: shorts resume ${job.id.slice(0, 8)}`);
}

function exitFor(job: Job): number {
  return job.state === 'FAILED' ? 2 : 0;
}

program
  .command('run')
  .alias('pipeline')
  .description('Create a production job and advance it as far as the approval policy allows')
  .addOption(modeOption())
  .addOption(new Option('--pillar <pillar>', 'content pillar').choices(CONTENT_PILLARS))
  .option('--topic <topicId>', 'produce a specific catalog topic')
  .action(async (o) => {
    const { runner } = await setup(o.mode);
    const job = await runner.createJob({ topicId: o.topic });
    const done = await runner.run(job.id, { pillar: o.pillar as ContentPillar | undefined });
    printJob(done);
    process.exitCode = exitFor(done);
  });

program
  .command('resume <jobId>')
  .description('Resume a failed or interrupted job (completed stages are not repeated)')
  .addOption(modeOption())
  .addOption(new Option('--from <stage>', 'restart from an earlier stage').choices(JobStateSchema.options))
  .option('--steal-lock', 'take over a job locked by a process that is no longer running', false)
  .action(async (id, o) => {
    const { repo, runner } = await setup(o.mode);
    const done = await runner.resume(await resolveJobId(repo, id), { fromStage: o.from, stealLock: o.stealLock });
    printJob(done);
    process.exitCode = exitFor(done);
  });

program
  .command('approve <jobId> <stage>')
  .description('Record a human decision for IDEA | SCRIPT | FINAL_VIDEO')
  .addOption(modeOption())
  .option('--reject', 'reject instead of approve', false)
  .option('--revise', 'SCRIPT: rewrite the script; FINAL_VIDEO: re-source footage (notes "scenes: 2,4" limits it), no new voice cost', false)
  .option('--notes <notes>', 'director notes')
  .option('--continue', 'continue running the job after approval', false)
  .action(async (id, stage, o) => {
    const { repo, runner } = await setup(o.mode);
    const jobId = await resolveJobId(repo, id);
    const st = ApprovalStageSchema.parse(String(stage).toUpperCase());
    const decision = o.reject ? 'REJECTED' : o.revise ? 'REVISIONS_REQUESTED' : 'APPROVED';
    let job = await runner.approve(jobId, st, decision, o.notes);
    if (o.continue && job.state !== 'READY_TO_PUBLISH') job = await runner.run(jobId);
    printJob(job);
  });

program
  .command('publish <jobId>')
  .description('Publish an approved job (all publication gates are re-checked)')
  .addOption(modeOption())
  .option('--retry', 'retry a publication that failed before any upload started (never retries uncertain uploads)')
  .action(async (id, o) => {
    const { repo, runner } = await setup(o.mode);
    const jobId = await resolveJobId(repo, id);
    if (o.retry) {
      const done = await runner.retryPublish(jobId);
      printJob(done);
      process.exitCode = exitFor(done);
      return;
    }
    const job = await repo.requireJob(jobId);
    if (job.state !== 'READY_TO_PUBLISH') throw new ValidationError(`Job is ${job.state}; only READY_TO_PUBLISH jobs can be published`);
    const done = await runner.run(jobId);
    printJob(done);
    process.exitCode = exitFor(done);
  });

program
  .command('jobs')
  .description('List jobs')
  .addOption(modeOption())
  .addOption(new Option('--state <state>').choices(JobStateSchema.options))
  .action(async (o) => {
    const repo = await openRepo(configForMode(getConfig(), resolveMode(getConfig(), o.mode)));
    for (const j of await repo.listJobs(o.state)) {
      console.log(`${j.id.slice(0, 8)}  ${j.mode.padEnd(4)}  ${j.state.padEnd(24)}  ${j.updatedAt}${j.state === 'FAILED' ? `  ${j.failedStage}: ${j.errorKind}` : ''}`);
    }
  });

program
  .command('job <jobId>')
  .description('Show a detailed job report (JSON)')
  .addOption(modeOption())
  .action(async (id, o) => {
    const mode = resolveMode(getConfig(), o.mode);
    const cfg = configForMode(getConfig(), mode);
    const repo = await openRepo(cfg);
    const jobId = await resolveJobId(repo, id);
    const runner = new PipelineRunner(cfg, repo, { mode });
    console.log(JSON.stringify(await runner.report(jobId), null, 2));
  });

program
  .command('discover')
  .description('Discover and store novel topic candidates')
  .addOption(modeOption())
  .addOption(new Option('--pillar <pillar>').choices(CONTENT_PILLARS))
  .option('--count <n>', 'number of topics', '3')
  .action(async (o) => {
    const { runner } = await setup(o.mode);
    const res = await runner.discover(o.pillar, Number(o.count));
    console.log(`Requested ${res.requested}, stored ${res.topics.length}${res.shortfall ? ` (SHORTFALL ${res.shortfall})` : ''}`);
    for (const t of res.topics) console.log(`  + [${t.id.slice(0, 8)}] ${t.title} (${t.pillar})`);
    for (const r of res.rejected) console.log(`  - ${r.title}: ${r.reason}`);
  });

program
  .command('doctor')
  .description('Check configuration, tools, fonts and credentials without calling paid APIs')
  .addOption(modeOption())
  .action(async (o) => {
    const mode = resolveMode(getConfig(), o.mode);
    const cfg = configForMode(getConfig(), mode);
    const problems: string[] = [];
    for (const [bin, label] of [[cfg.FFMPEG_PATH, 'ffmpeg'], [cfg.FFPROBE_PATH, 'ffprobe']] as const) {
      try {
        const r = await runProcess(bin, ['-version'], { timeoutMs: 10_000 });
        console.log(`✓ ${label}: ${r.stdout.split('\n')[0]}`);
      } catch {
        problems.push(`${label} not runnable (${bin})`);
      }
    }
    if (fs.existsSync(cfg.captionFontFile)) console.log(`✓ caption font: ${cfg.captionFontFile}`);
    else problems.push(`caption font missing: ${cfg.captionFontFile}`);
    if (mode === 'live') {
      const missing = missingLiveCredentials(cfg);
      if (missing.length) problems.push(`missing live credentials: ${missing.join(', ')}`);
      else console.log(`✓ live credentials present for LLM=${cfg.LLM_PROVIDER}, search=${cfg.SEARCH_PROVIDER}, tts=${cfg.TTS_PROVIDER}, assets=${cfg.ASSET_PROVIDER}, publish=${cfg.PUBLISH_TARGET}`);
    }
    console.log(`✓ approval policy: idea=${cfg.APPROVAL_IDEA}, script=${cfg.APPROVAL_SCRIPT}, final=${cfg.APPROVAL_FINAL}`);
    // Cost profile: which paid services this configuration can bill, and the free-tier budgets left.
    const usageFile = freeTierUsageFile(cfg);
    if (cfg.LLM_PROVIDER === 'claude_code') {
      const bin = findClaudeCli(cfg.CLAUDE_CODE_PATH || undefined);
      if (bin) {
        // Only the login type and plan are read; the account e-mail and organisation are not printed.
        let auth: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
        try {
          auth = JSON.parse((await runProcess(bin, ['auth', 'status', '--json'], { timeoutMs: 30_000, env: subscriptionOnlyEnv() })).stdout);
        } catch {
          /* reported below */
        }
        const models = `${cfg.CLAUDE_CODE_MODEL}${cfg.CLAUDE_CODE_VERIFIER_MODEL ? `, verifier ${cfg.CLAUDE_CODE_VERIFIER_MODEL}` : ''}`;
        if (auth.loggedIn && auth.authMethod === 'claude.ai') console.log(`✓ LLM: Claude Code on the claude.ai ${auth.subscriptionType ?? ''} plan (${models}), $0 per call; uses the plan's usage limits`);
        else problems.push(`Claude Code is not logged in with a claude.ai account (run "claude" and /login); API-key billing is never used`);
      }
    } else if (cfg.LLM_PROVIDER === 'gemini' && cfg.GEMINI_FREE_TIER) {
      const left = new UsageBudget({ file: usageFile, provider: 'gemini', limit: cfg.GEMINI_FREE_RPD, period: 'day', timeZone: 'America/Los_Angeles', unit: 'requests' }).remaining();
      console.log(`✓ LLM: Gemini free tier (${cfg.GEMINI_MODEL}), $0; ${left}/${cfg.GEMINI_FREE_RPD} requests left today (Pacific), ${cfg.GEMINI_FREE_RPM}/min`);
      if (!/flash/.test(cfg.GEMINI_MODEL)) console.log(`  ! ${cfg.GEMINI_MODEL} is not a Flash model: free-tier quotas for Pro models are far smaller (use GEMINI_MODEL=gemini-3.8-flash)`);
    } else console.log(`! LLM: ${cfg.LLM_PROVIDER} ${cfg.LLM_PROVIDER === 'gemini' ? cfg.GEMINI_MODEL : cfg.OPENAI_MODEL} is billed per token (set LLM_PROVIDER=claude_code, or gemini with GEMINI_FREE_TIER=true, for $0)`);
    if (cfg.LLM_FALLBACK_PROVIDER !== 'none') {
      const free = cfg.LLM_FALLBACK_PROVIDER === 'gemini' && cfg.GEMINI_FREE_TIER;
      console.log(`${free ? '✓' : '!'} LLM fallback when ${cfg.LLM_PROVIDER} is busy or out of allowance: ${cfg.LLM_FALLBACK_PROVIDER}${free ? ' free tier ($0)' : ' (billed per token)'}`);
    }
    if (cfg.TAVILY_MONTHLY_CREDITS > 0) {
      const left = new UsageBudget({ file: usageFile, provider: 'tavily', limit: cfg.TAVILY_MONTHLY_CREDITS, period: 'month', timeZone: 'UTC', unit: 'credits' }).remaining();
      console.log(`✓ search: Tavily free plan, ${cfg.TAVILY_SEARCH_DEPTH} depth; ${left}/${cfg.TAVILY_MONTHLY_CREDITS} credits left this month`);
    } else console.log(`! search: Tavily without a monthly cap (TAVILY_MONTHLY_CREDITS=0) may exceed the free plan`);
    if (cfg.GRAPHICS_ENABLED) {
      const bin = findBlender(cfg.BLENDER_PATH || undefined);
      console.log(bin ? `✓ graphics: Blender at ${bin}` : '! graphics: Blender not found (install it or set BLENDER_PATH); graphic beats fall back to stock');
    }
    if (cfg.MUSIC_ENABLED) {
      // Music is optional: a missing or empty library is reported, not treated as a failure.
      const lib = await loadMusicLibrary(path.resolve(repoRoot(), cfg.MUSIC_LIBRARY));
      console.log(`${lib.tracks.length ? '✓' : '!'} music: ${lib.tracks.length} approved track(s)${lib.tracks.length ? '' : ' — renders will record music as disabled'}`);
      for (const p of lib.problems) console.log(`  ! ${p}`);
    } else console.log('✓ music: disabled (MUSIC_ENABLED=false)');
    await openRepo(cfg);
    console.log(`✓ database ready (${cfg.USE_SQLITE_FALLBACK ? cfg.sqlitePath : 'postgres'})`);
    if (problems.length) {
      for (const p of problems) console.log(`✗ ${p}`);
      process.exitCode = 1;
    }
  });

program
  .command('schedule')
  .description('Unattended loop: resume retryable failures, then start new jobs up to a daily cap')
  .addOption(modeOption())
  .option('--interval-minutes <n>', 'minutes between ticks', '60')
  .option('--max-per-day <n>', 'maximum new jobs per rolling 24h', '1')
  .option('--max-attempts <n>', 'maximum automatic resumes per job', '3')
  .addOption(new Option('--pillar <pillar>').choices(CONTENT_PILLARS))
  .option('--once', 'run a single tick and exit', false)
  .action(async (o) => {
    const { repo, runner } = await setup(o.mode);
    const tick = async () => {
      for (const j of await repo.listJobs('FAILED', 50)) {
        if (j.mode !== runner.mode || !j.retryable || j.attempts >= Number(o.maxAttempts) || j.failedStage === 'PUBLISHING') continue;
        logger.info(`schedule: resuming retryable job ${j.id}`, { jobId: j.id });
        printJob(await runner.resume(j.id, { pillar: o.pillar }).catch((e) => { logger.error('resume failed', e); return j; }));
      }
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      if ((await repo.countJobsCreatedSince(since)) < Number(o.maxPerDay)) {
        const job = await runner.createJob();
        printJob(await runner.run(job.id, { pillar: o.pillar }));
      } else {
        logger.info('schedule: daily job cap reached');
      }
    };
    await tick();
    if (o.once) return;
    const ms = Number(o.intervalMinutes) * 60_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, ms));
      await tick().catch((e) => logger.error('schedule tick failed', e));
    }
  });

// =============================================================================
// Growth workflow: gap discovery, review, daily loop, YouTube connection, analytics
// =============================================================================

const fmtViews = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

program
  .command('gaps')
  .description('Find viewer questions with proven long-form demand and no good Short (free: autocomplete + YouTube search)')
  .addOption(modeOption())
  .option('--probes <n>', 'questions to measure against YouTube search')
  .option('--seeds <spec>', 'override GAP_SEEDS ("cluster:seed|cluster:seed")')
  .option('--show-dropped', 'list questions dropped by filters/triage', false)
  .action(async (o) => {
    const { runner } = await setup(o.mode);
    const res = await runner.discoverGaps({ maxProbes: o.probes ? Number(o.probes) : undefined, seeds: o.seeds });
    console.log(`${res.suggestionsSeen} autocomplete suggestions → ${res.probes.length} probed → ${res.topics.length} new topic(s)\n`);
    console.log('score  long-form  best Short  Shorts≥10k  outcome          question');
    for (const p of [...res.probes].sort((a, b) => (b.evidence?.score ?? -1) - (a.evidence?.score ?? -1))) {
      const e = p.evidence;
      console.log(
        `${String(e?.score ?? '—').padStart(5)}  ${fmtViews(e?.longformTopViews ?? 0).padStart(9)}  ${fmtViews(e?.bestShortViews ?? 0).padStart(10)}  ${String(e?.shortsAbove10k ?? '—').padStart(10)}  ${p.outcome.padEnd(15)}  ${p.question}`
      );
    }
    if (o.showDropped) for (const d of res.dropped) console.log(`  - ${d.question}: ${d.reason}`);
  });

program
  .command('review')
  .description('Show everything waiting for a human decision (scripts before voice credits are spent, finished videos)')
  .addOption(modeOption())
  .action(async (o) => {
    const { repo, runner } = await setup(o.mode);
    const waiting = [...(await repo.listJobs('AWAITING_SCRIPT_APPROVAL', 50)), ...(await repo.listJobs('AWAITING_IDEA_APPROVAL', 50)), ...(await repo.listJobs('AWAITING_FINAL_APPROVAL', 50))];
    if (waiting.length === 0) return console.log('Nothing is waiting for review.');
    for (const job of waiting) {
      const d = await runner.reviewDigest(job.id);
      console.log(`\n${'='.repeat(78)}\n${job.state}  job ${job.id.slice(0, 8)}  ${d.topic}`);
      if (d.gap) console.log(`gap ${d.gap.score}: long-form ${fmtViews(d.gap.longformTopViews)} views, best Short ${fmtViews(d.gap.bestShortViews)}, cluster ${d.gap.cluster}`);
      if (d.variant) {
        const v = d.variant;
        console.log(`variant: hook ${v.hookType}, ${v.durationBand}, title card ${v.titleCard ? 'on' : 'off'}, music ${v.music ? 'on' : 'off'}, captions ${v.captionStyle}, speed ${v.voiceSpeed}${v.experimentId ? `  [experiment ${v.experimentId}: ${v.factor}=${v.arm}]` : ''}`);
      }
      if (d.editor) console.log(`editor: ${d.editor.total}/20 (hook ${d.editor.scores.hook}, specificity ${d.editor.scores.specificity}, flow ${d.editor.scores.causalFlow}, payoff ${d.editor.scores.payoff}) after ${d.editor.revision} revision(s)`);
      if (d.script) {
        console.log(`format ${d.script.format}${d.script.titleCard ? `, title card "${d.script.titleCard}"` : ''}, ${d.script.totalWords} words, ~${d.voiceCredits} voice credits`);
        console.log(`title: ${d.script.title}`);
        d.script.scenes.forEach((s) => console.log(`  ${s.sceneNumber}. ${s.narration}\n     [visual: ${s.visualSubject}]`));
        console.log(`sources:\n${d.sources.map((u) => `  ${u}`).join('\n') || '  (none citable)'}`);
      }
      if (d.video) console.log(`video: ${d.video}`);
      if (d.reviewReasons.length) console.log(`REVIEW REQUIRED:\n${d.reviewReasons.map((r) => `  ! ${r}`).join('\n')}`);
      const stage = job.state === 'AWAITING_SCRIPT_APPROVAL' ? 'SCRIPT' : job.state === 'AWAITING_IDEA_APPROVAL' ? 'IDEA' : 'FINAL_VIDEO';
      console.log(`→ shorts approve ${job.id.slice(0, 8)} ${stage}${stage === 'SCRIPT' ? '   |  --revise --notes "..."' : ''}   |  --reject`);
    }
  });

program
  .command('daily')
  .description('Daily loop: refill gap topics, continue approved jobs, start new jobs up to the review gates, publish within the upload cap, sync analytics')
  .addOption(modeOption())
  .option('--new <n>', 'new jobs to start', '3')
  .action(async (o) => {
    const { cfg, repo, runner } = await setup(o.mode);
    const wanted = Number(o.new);
    // 1. Topic pool (free signals; one triage call).
    const pool = (await repo.listTopics('SCORED')).filter((t) => t.gap);
    if (cfg.DISCOVERY_MODE === 'gap' && pool.length < wanted) {
      const res = await runner.discoverGaps();
      console.log(`topics: ${pool.length} in pool, discovered ${res.topics.length} more`);
    }
    // 2. Continue jobs a human has approved (or that were interrupted).
    const active = (await repo.listJobs(undefined, 200)).filter(
      (j) => j.mode === runner.mode && !['FAILED', 'PUBLISHED', 'REJECTED', 'CREATED', 'AWAITING_IDEA_APPROVAL', 'AWAITING_SCRIPT_APPROVAL', 'AWAITING_FINAL_APPROVAL'].includes(j.state)
    );
    for (const j of active) printJob(await runner.run(j.id).catch((e) => (logger.error(`job ${j.id} failed`, e), j)));
    // 3. New jobs run until their first human gate (scripts are reviewed before any voice credits).
    for (let i = 0; i < wanted; i++) {
      const job = await runner.createJob();
      printJob(await runner.run(job.id));
    }
    // 4. Analytics (free) when YouTube is connected.
    if (cfg.PUBLISH_TARGET === 'youtube') {
      const s = await runner.syncAnalytics().catch((e) => (logger.warn(`analytics sync failed: ${(e as Error).message}`), null));
      if (s) console.log(`analytics: ${s.measured} Short(s) measured via ${s.source}`);
    }
    console.log('\nnext: shorts review');
  });

const youtube = program.command('youtube').description('Connect and check the YouTube channel');

youtube
  .command('auth')
  .description('Authorize this app for your channel (opens a Google consent URL; stores the refresh token in .env, never prints it)')
  .action(async () => {
    const cfg = getConfig();
    const tokens = await runLoopbackAuth({ clientId: cfg.YOUTUBE_CLIENT_ID, clientSecret: cfg.YOUTUBE_CLIENT_SECRET }, (url) => {
      console.log('Open this URL in the browser signed in to the channel owner account, and grant access:\n');
      console.log(url + '\n');
      console.log('Waiting for Google to redirect back to this machine (5 minutes)...');
    });
    const envPath = path.join(repoRoot(), '.env');
    upsertEnvVar(envPath, 'YOUTUBE_REFRESH_TOKEN', tokens.refreshToken);
    console.log(`Refresh token saved to ${envPath} (YOUTUBE_REFRESH_TOKEN). Granted scopes: ${tokens.scope.split(' ').map((s) => s.split('/').pop()).join(', ')}`);
    console.log('Next: shorts youtube status, then set PUBLISH_TARGET=youtube');
  });

youtube
  .command('status')
  .description('Verify the YouTube connection and show the publishing constraints in effect')
  .addOption(modeOption())
  .action(async (o) => {
    const { cfg, repo } = await setup(o.mode ?? 'live');
    if (!cfg.YOUTUBE_CLIENT_ID || !cfg.YOUTUBE_CLIENT_SECRET || !cfg.YOUTUBE_REFRESH_TOKEN) {
      console.log('✗ not connected: set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET, then run: shorts youtube auth');
      process.exitCode = 1;
      return;
    }
    const client = new YouTubeAnalyticsClient({ clientId: cfg.YOUTUBE_CLIENT_ID, clientSecret: cfg.YOUTUBE_CLIENT_SECRET }, cfg.YOUTUBE_REFRESH_TOKEN);
    const ch = await client.channel();
    console.log(`✓ connected to "${ch.title}" (${ch.id}), ${ch.subscribers ?? 'hidden'} subscribers`);
    console.log(`  publish target: ${cfg.PUBLISH_TARGET}, privacy: ${cfg.YOUTUBE_DEFAULT_PRIVACY}, category ${cfg.YOUTUBE_CATEGORY_ID}, AI disclosure: ${cfg.YOUTUBE_CONTAINS_SYNTHETIC_MEDIA}`);
    console.log(
      cfg.YOUTUBE_PROJECT_AUDITED
        ? `  audited API project: scheduled public releases at ${cfg.PUBLISH_SLOTS} (${cfg.PUBLISH_TIMEZONE})`
        : '  API project NOT audited: YouTube locks API uploads to private. Publish them from YouTube Studio, or complete the YouTube API audit and set YOUTUBE_PROJECT_AUDITED=true.'
    );
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    console.log(`  uploads in last 24 h: ${await repo.countPublishesSince(since, 'youtube')}/${cfg.MAX_UPLOADS_PER_DAY}`);
  });

const analytics = program.command('analytics').description('Measure published Shorts and learn what works');

analytics
  .command('sync')
  .description('Pull current metrics for every published Short (owner metrics with OAuth, public counters otherwise)')
  .addOption(modeOption())
  .action(async (o) => {
    const { runner } = await setup(o.mode ?? 'live');
    const r = await runner.syncAnalytics();
    console.log(r.measured ? `measured ${r.measured} Short(s) via ${r.source}${r.channel ? ` for "${r.channel}"` : ''}` : 'no published YouTube Shorts yet');
  });

analytics
  .command('experiment <experimentId>')
  .description('Screening report for one experiment: per-arm sample sizes, medians and ranges (never declares a winner)')
  .addOption(modeOption())
  .action(async (id, o) => {
    const { runner } = await setup(o.mode ?? 'live');
    const r = await runner.experimentReport(id);
    console.log(`experiment ${r.experimentId}${r.factor ? ` (${r.factor})` : ''}: ${r.status}`);
    for (const a of r.arms) console.log(`  ${a.arm.padEnd(12)} n=${a.n}  median ${a.median} ${a.metric} (IQR ${a.q1}-${a.q3})  % viewed ${a.medianAvgViewPct ?? '—'}`);
    console.log(r.summary);
  });

analytics
  .command('report')
  .description('What performs: by format, topic cluster, length and release hour, with recommendations')
  .addOption(modeOption())
  .action(async (o) => {
    const { runner } = await setup(o.mode ?? 'live');
    const r = await runner.analyticsReport();
    console.log(r.markdown);
    console.log(`\nsaved: ${r.path}`);
  });


program.parseAsync(process.argv).catch((err) => {
  const msg = err instanceof PipelineError ? `${err.kind}: ${err.message}` : (err as Error).message;
  logger.error(msg);
  if (err instanceof ValidationError && err.violations.length) for (const v of err.violations) process.stderr.write(`  - ${v}\n`);
  process.exitCode = 1;
});
