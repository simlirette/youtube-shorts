/**
 * Real-provider acceptance campaign (incurs API cost; never uploads to YouTube).
 *
 *   pnpm acceptance:campaign --jobs 10
 *   pnpm acceptance:campaign --jobs 10 --stop-at SYNTHESIZING_VOICE   (partial: topic → research → script)
 *
 * Runs N complete live jobs in an isolated database/output directory with the unattended policy
 * (APPROVAL_IDEA=auto, APPROVAL_SCRIPT=auto, APPROVAL_FINAL=auto_after_qa) and PUBLISH_TARGET forced
 * to local_export. A job that fails with a retryable error is resumed once; the first-pass outcome is
 * recorded separately so retries never hide failures. Writes one JSON report per job plus summary.json
 * and summary.md under output/acceptance/campaign-<timestamp>/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ShortsRepository, createDatabase, loadConfig } from '@shorts/core';
import { PipelineRunner } from '@shorts/pipeline';
import type { JobState } from '@shorts/schemas';

const argJobs = process.argv.indexOf('--jobs');
const JOBS = Number(argJobs > 0 ? process.argv[argJobs + 1] : process.env.CAMPAIGN_JOBS ?? 10);
const argStop = process.argv.indexOf('--stop-at');
const STOP_AT = argStop > 0 ? (process.argv[argStop + 1] as JobState) : undefined;

const base = loadConfig();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(base.outputDir, 'acceptance', `campaign-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });
const cfg = {
  ...base,
  PIPELINE_MODE: 'live' as const,
  APPROVAL_IDEA: 'auto' as const,
  APPROVAL_SCRIPT: 'auto' as const,
  APPROVAL_FINAL: 'auto_after_qa' as const,
  PUBLISH_TARGET: 'local_export' as const,
  USE_SQLITE_FALLBACK: true,
  outputDir: outDir,
  sqlitePath: path.join(outDir, 'campaign.sqlite'),
};

const TRACKED = ['audio.speechStart', 'audio.speechContinuity', 'audio.pace', 'audio.musicBed', 'audio.voiceDominant', 'video.fullBleed', 'video.upscale', 'titleCard.layout', 'script.editor'];

type Outcome = 'PUBLISHED_UNATTENDED' | 'HUMAN_REVIEW' | 'REACHED_STOP' | 'FAILED' | 'OTHER';
interface JobMetrics {
  n: number;
  jobId: string;
  topic: string | null;
  firstPass: { state: string; failedStage: string | null; errorKind: string | null; error: string | null };
  resumed: boolean;
  final: { state: string; failedStage: string | null; errorKind: string | null; error: string | null };
  outcome: Outcome;
  seconds: number;
  costUsd: number;
  words: number | null;
  narrationSeconds: number | null;
  videoSeconds: number | null;
  verifiedClaims: number | null;
  sourceTiers: string[];
  qa: { overall: string; publishEligible: boolean; requiresHumanReview: boolean; reviewReasons: string[]; blocking: string[] } | null;
  visual: Array<{ scene: number; decision: string | null; semantic: string | null; framing: string | null }>;
  variant: Record<string, unknown> | null;
  editor: Array<{ revision: number; total: number; hook: number; payoff: number; passed: boolean }>;
  wordsPerSecond: number | null;
  /** Status of the format-specific media checks (pace, continuity, framing, title card, music). */
  checks: Record<string, string>;
}

function outcomeOf(state: string): Outcome {
  if (state === 'PUBLISHED') return 'PUBLISHED_UNATTENDED';
  if (state === 'AWAITING_FINAL_APPROVAL') return 'HUMAN_REVIEW';
  if (state === 'FAILED') return 'FAILED';
  if (STOP_AT && state === STOP_AT) return 'REACHED_STOP';
  return 'OTHER';
}

async function main() {
  const repo = new ShortsRepository(createDatabase(cfg));
  await repo.init();
  const runner = new PipelineRunner(cfg, repo, { mode: 'live' });
  const all: JobMetrics[] = [];

  for (let n = 1; n <= JOBS; n++) {
    const t0 = Date.now();
    let jobId = '';
    let first: JobMetrics['firstPass'] = { state: 'NOT_CREATED', failedStage: null, errorKind: null, error: null };
    let resumed = false;
    try {
      const job = await runner.createJob();
      jobId = job.id;
      let settled = await runner.run(job.id, { stopAt: STOP_AT });
      first = { state: settled.state, failedStage: settled.failedStage ?? null, errorKind: settled.errorKind ?? null, error: settled.errorMessage ?? null };
      if (settled.state === 'FAILED' && settled.retryable && settled.failedStage !== 'PUBLISHING') {
        resumed = true;
        settled = await runner.resume(job.id, { stopAt: STOP_AT });
      }
    } catch (e) {
      first = { ...first, state: first.state === 'NOT_CREATED' ? 'CRASHED' : first.state, error: (e as Error).message };
    }
    const report = jobId ? ((await runner.report(jobId)) as any) : null;
    if (report) fs.writeFileSync(path.join(outDir, `job-${String(n).padStart(2, '0')}.json`), JSON.stringify(report, null, 2));
    const j = report?.job;
    const m: JobMetrics = {
      n,
      jobId,
      topic: report?.topic?.title ?? null,
      firstPass: first,
      resumed,
      final: j ? { state: j.state, failedStage: j.failedStage ?? null, errorKind: j.errorKind ?? null, error: j.errorMessage ?? null } : first,
      outcome: outcomeOf(j?.state ?? first.state),
      seconds: Math.round((Date.now() - t0) / 1000),
      costUsd: report?.estimatedCostUsd ?? 0,
      words: report?.script?.words ?? null,
      narrationSeconds: report?.narration?.durationSeconds ?? null,
      videoSeconds: report?.render?.durationSeconds ?? null,
      verifiedClaims: report?.research?.verifiedClaims ?? null,
      sourceTiers: report?.research?.sourceTiers ?? [],
      qa: report?.qa
        ? { overall: report.qa.overall, publishEligible: report.qa.publishEligible, requiresHumanReview: report.qa.requiresHumanReview, reviewReasons: report.qa.reviewReasons, blocking: report.qa.blocking }
        : null,
      visual: (report?.media ?? []).map((x: any) => ({ scene: x.scene, decision: x.visual?.decision ?? null, semantic: x.visual?.semantic ?? null, framing: x.framing?.mode ?? null })),
      variant: report?.variant ?? null,
      editor: (report?.editorReviews ?? []).map((r: any) => ({ revision: r.revision, total: r.total, hook: r.scores.hook, payoff: r.scores.payoff, passed: r.passed })),
      wordsPerSecond: report?.narration?.wordsPerSecond ?? null,
      checks: Object.fromEntries(
        (report?.qa?.checks ?? [])
          .map((c: string) => c.match(/^(\w+) ([\w.]+):/))
          .filter((x: RegExpMatchArray | null) => x && TRACKED.includes(x[2]))
          .map((x: RegExpMatchArray) => [x[2], x[1]])
      ),
    };
    all.push(m);
    console.log(`[campaign] job ${n}/${JOBS}: first=${m.firstPass.state}${m.firstPass.failedStage ? `@${m.firstPass.failedStage}` : ''} final=${m.final.state} outcome=${m.outcome} ${m.seconds}s $${m.costUsd}`);
    fs.writeFileSync(path.join(outDir, 'jobs.json'), JSON.stringify(all, null, 2));
    // Account-level failures repeat for every later job: stop instead of spending on doomed jobs.
    const fatal = ['QUOTA_EXCEEDED', 'AUTHENTICATION', 'CONFIGURATION'];
    if (fatal.includes(m.final.errorKind ?? '') || fatal.includes(m.firstPass.errorKind ?? '')) {
      console.log(`[campaign] stopping early: ${m.final.errorKind ?? m.firstPass.errorKind} — ${m.final.error ?? m.firstPass.error}`);
      break;
    }
  }

  const count = (f: (m: JobMetrics) => boolean) => all.filter(f).length;
  const rate = (k: number) => Math.round((k / all.length) * 1000) / 10;
  const byStage = (sel: (m: JobMetrics) => string | null) =>
    all.reduce<Record<string, number>>((acc, m) => {
      const s = sel(m);
      if (s) acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
  const okStates = ['PUBLISHED', 'AWAITING_FINAL_APPROVAL', ...(STOP_AT ? [STOP_AT] : [])];
  const firstPassOk = count((m) => okStates.includes(m.firstPass.state));
  const costs = all.map((m) => m.costUsd).filter((c) => c > 0);
  const summary = {
    campaign: path.basename(outDir),
    jobs: all.length,
    stop_at: STOP_AT ?? null,
    policy: { APPROVAL_IDEA: cfg.APPROVAL_IDEA, APPROVAL_SCRIPT: cfg.APPROVAL_SCRIPT, APPROVAL_FINAL: cfg.APPROVAL_FINAL, PUBLISH_TARGET: cfg.PUBLISH_TARGET },
    first_pass_success_rate: rate(firstPassOk),
    first_pass_unattended_publish_rate: rate(count((m) => m.firstPass.state === 'PUBLISHED')),
    final_success_rate_after_one_resume: rate(count((m) => okStates.includes(m.final.state))),
    outcomes: {
      published_unattended: count((m) => m.outcome === 'PUBLISHED_UNATTENDED'),
      human_review: count((m) => m.outcome === 'HUMAN_REVIEW'),
      reached_stop: count((m) => m.outcome === 'REACHED_STOP'),
      failed: count((m) => m.outcome === 'FAILED'),
      other: count((m) => m.outcome === 'OTHER'),
    },
    failure_rate_by_stage_first_pass: byStage((m) => (m.firstPass.state === 'FAILED' ? m.firstPass.failedStage : m.firstPass.state === 'CRASHED' ? 'CRASH' : null)),
    failure_rate_by_stage_final: byStage((m) => (m.final.state === 'FAILED' ? m.final.failedStage : null)),
    review_reasons: all.flatMap((m) => m.qa?.reviewReasons ?? []),
    cost_usd: { total: Math.round(costs.reduce((a, b) => a + b, 0) * 1000) / 1000, mean_per_job: costs.length ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 1000) / 1000 : 0 },
    mean_seconds_per_job: Math.round(all.reduce((a, m) => a + m.seconds, 0) / all.length),
    words: all.map((m) => m.words),
    words_per_second: all.map((m) => m.wordsPerSecond),
    editor: {
      scripts_reviewed: count((m) => m.editor.length > 0),
      first_draft_pass_rate: rate(count((m) => m.editor[0]?.passed === true)),
      approved: count((m) => m.editor.some((r) => r.passed)),
      mean_revisions_when_approved: (() => {
        const ok = all.filter((m) => m.editor.some((r) => r.passed));
        return ok.length ? Math.round((ok.reduce((a, m) => a + m.editor.findIndex((r) => r.passed), 0) / ok.length) * 100) / 100 : null;
      })(),
      totals: all.map((m) => m.editor.map((r) => r.total)),
    },
    visual: {
      shots: all.reduce((a, m) => a + m.visual.length, 0),
      accepted: all.reduce((a, m) => a + m.visual.filter((v) => v.decision === 'ACCEPTED').length, 0),
      framing: all.flatMap((m) => m.visual.map((v) => v.framing ?? 'legacy')).reduce<Record<string, number>>((acc, f) => ((acc[f] = (acc[f] ?? 0) + 1), acc), {}),
    },
    checks: Object.fromEntries(TRACKED.map((id) => [id, all.map((m) => m.checks[id] ?? '-').join(' ')])),
    cost_per_accepted_short_usd: (() => {
      const accepted = count((m) => ['PUBLISHED', 'AWAITING_FINAL_APPROVAL'].includes(m.final.state));
      const total = costs.reduce((a, b) => a + b, 0);
      return accepted ? Math.round((total / accepted) * 1000) / 1000 : null;
    })(),
    narration_seconds: all.map((m) => m.narrationSeconds),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const md = [
    `# Acceptance campaign ${summary.campaign}`,
    '',
    `Jobs: ${summary.jobs} · first-pass success ${summary.first_pass_success_rate}% · unattended publish (first pass) ${summary.first_pass_unattended_publish_rate}% · after one resume ${summary.final_success_rate_after_one_resume}%`,
    `Cost: total $${summary.cost_usd.total}, mean $${summary.cost_usd.mean_per_job}/job · mean ${summary.mean_seconds_per_job}s/job`,
    '',
    '| # | topic | first pass | resumed | final | outcome | words | narration s | cost $ | review reasons / error |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...all.map(
      (m) =>
        `| ${m.n} | ${(m.topic ?? '').replace(/\|/g, '/')} | ${m.firstPass.state}${m.firstPass.failedStage ? `@${m.firstPass.failedStage}` : ''} | ${m.resumed ? 'yes' : ''} | ${m.final.state} | ${m.outcome} | ${m.words ?? ''} | ${m.narrationSeconds?.toFixed(1) ?? ''} | ${m.costUsd} | ${((m.qa?.reviewReasons ?? []).join('; ') || m.final.error || m.firstPass.error || '').replace(/\|/g, '/').slice(0, 300)} |`
    ),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.md'), md);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[campaign] reports: ${outDir}`);
}

main().catch((e) => {
  console.error(`[campaign] aborted: ${(e as Error).message}`);
  process.exitCode = 1;
});
