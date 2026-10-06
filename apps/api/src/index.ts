import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { ApprovalDecisionSchema, ApprovalStageSchema, ContentPillarSchema, JobStateSchema, PipelineMode } from '@shorts/schemas';
import { ConfigurationError, PipelineError, ShortsRepository, configForMode, createDatabase, getConfig, logger } from '@shorts/core';
import { PipelineRunner } from '@shorts/pipeline';

const baseCfg = getConfig();
if (!baseCfg.API_TOKEN || baseCfg.API_TOKEN.length < 16) {
  throw new ConfigurationError('API_TOKEN (>= 16 characters) is required to start the API server');
}
const mode = baseCfg.PIPELINE_MODE as PipelineMode | undefined;
if (!mode) throw new ConfigurationError('PIPELINE_MODE must be set to mock or live for the API server');
const cfg = configForMode(baseCfg, mode);

const repo = new ShortsRepository(createDatabase(cfg));
await repo.init();
const runner = new PipelineRunner(cfg, repo, { mode });

// Serial in-process work queue: long-running pipeline work never runs inside a request.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = (label: string, fn: () => Promise<unknown>) => {
  queue = queue.then(fn).catch((e) => logger.error(`background task ${label} failed`, e));
};

const app = express();
app.disable('x-powered-by');
if (cfg.API_CORS_ORIGIN) app.use(cors({ origin: cfg.API_CORS_ORIGIN }));
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', mode, time: new Date().toISOString() }));

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(cfg.API_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((err) => {
    const status = err instanceof z.ZodError ? 400 : err instanceof PipelineError && ['VALIDATION', 'CONFIGURATION'].includes(err.kind) ? 400 : 500;
    res.status(status).json({ error: err instanceof z.ZodError ? err.issues : (err as Error).message });
  });
};

app.get('/api/topics', wrap(async (_req, res) => res.json({ topics: await repo.listTopics() })));

app.post('/api/topics/discover', wrap(async (req, res) => {
  const body = z.object({ pillar: ContentPillarSchema.optional(), count: z.number().int().min(1).max(10).default(3) }).parse(req.body ?? {});
  enqueue('discover', () => runner.discover(body.pillar, body.count));
  res.status(202).json({ accepted: true });
}));

app.get('/api/jobs', wrap(async (req, res) => {
  const state = req.query.state ? JobStateSchema.parse(req.query.state) : undefined;
  res.json({ jobs: await repo.listJobs(state) });
}));

app.get('/api/jobs/:id', wrap(async (req, res) => {
  if (!(await repo.getJob(String(req.params.id)))) return res.status(404).json({ error: 'job not found' });
  res.json(await runner.report(String(req.params.id)));
}));

app.post('/api/jobs', wrap(async (req, res) => {
  const body = z.object({ pillar: ContentPillarSchema.optional(), topicId: z.string().uuid().optional() }).parse(req.body ?? {});
  const job = await runner.createJob({ topicId: body.topicId });
  enqueue(`run ${job.id}`, () => runner.run(job.id, { pillar: body.pillar }));
  res.status(202).json({ jobId: job.id, mode });
}));

app.post('/api/jobs/:id/resume', wrap(async (req, res) => {
  const body = z.object({ fromStage: JobStateSchema.optional() }).parse(req.body ?? {});
  await repo.requireJob(String(req.params.id));
  enqueue(`resume ${String(req.params.id)}`, () => runner.resume(String(req.params.id), { fromStage: body.fromStage }));
  res.status(202).json({ accepted: true });
}));

app.post('/api/jobs/:id/approve', wrap(async (req, res) => {
  const body = z.object({ stage: ApprovalStageSchema, decision: ApprovalDecisionSchema, notes: z.string().max(2000).optional() }).parse(req.body ?? {});
  const job = await runner.approve(String(req.params.id), body.stage, body.decision, body.notes);
  if (!['READY_TO_PUBLISH', 'REJECTED'].includes(job.state)) enqueue(`continue ${job.id}`, () => runner.run(job.id));
  res.json({ job });
}));

app.post('/api/jobs/:id/publish', wrap(async (req, res) => {
  const job = await repo.requireJob(String(req.params.id));
  if (job.state !== 'READY_TO_PUBLISH') return res.status(409).json({ error: `job is ${job.state}` });
  enqueue(`publish ${job.id}`, () => runner.run(job.id));
  res.status(202).json({ accepted: true });
}));

export const server = app.listen(cfg.PORT, cfg.API_HOST, () => {
  logger.info(`Shorts API listening on http://${cfg.API_HOST}:${cfg.PORT} (mode ${mode})`, { stage: 'API' });
});
