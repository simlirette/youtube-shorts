import fs from 'node:fs';
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
  runProcess,
} from '@shorts/core';
import { missingLiveCredentials } from '@shorts/providers';
import { PipelineRunner } from '@shorts/pipeline';

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
  .option('--revise', 'request script revisions (SCRIPT only)', false)
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
  .action(async (id, o) => {
    const { repo, runner } = await setup(o.mode);
    const jobId = await resolveJobId(repo, id);
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

program.parseAsync(process.argv).catch((err) => {
  const msg = err instanceof PipelineError ? `${err.kind}: ${err.message}` : (err as Error).message;
  logger.error(msg);
  if (err instanceof ValidationError && err.violations.length) for (const v of err.violations) process.stderr.write(`  - ${v}\n`);
  process.exitCode = 1;
});
