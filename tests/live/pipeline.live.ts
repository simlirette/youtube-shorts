/**
 * REAL-PROVIDER END-TO-END ACCEPTANCE (incurs API cost). Run with: pnpm test:live
 * Runs LIVE_ACCEPTANCE_JOBS (default 2) complete jobs with OpenAI, Tavily, ElevenLabs and Pixabay,
 * stopping at the manual final-approval gate (nothing is published).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShortsRepository, createDatabase, loadConfig, runFfmpeg, summarizeMedia } from '@shorts/core';
import { PipelineRunner } from '@shorts/pipeline';
import { QAResultSchema, RenderJobSchema } from '@shorts/schemas';

const base = loadConfig();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(base.outputDir, 'acceptance', stamp);
const cfg = {
  ...base,
  PIPELINE_MODE: 'live' as const,
  APPROVAL_IDEA: 'auto' as const,
  APPROVAL_SCRIPT: 'auto' as const,
  APPROVAL_FINAL: 'manual' as const,
  outputDir: outDir,
  sqlitePath: path.join(outDir, 'acceptance.sqlite'),
};
const JOBS = Number(process.env.LIVE_ACCEPTANCE_JOBS ?? 2);

describe('live pipeline acceptance', () => {
  for (let i = 1; i <= JOBS; i++) {
    it(`job ${i}: real providers → validated Short awaiting final approval`, async () => {
      fs.mkdirSync(outDir, { recursive: true });
      const repo = new ShortsRepository(createDatabase(cfg));
      await repo.init();
      const runner = new PipelineRunner(cfg, repo, { mode: 'live' });
      const job = await runner.createJob();
      const settled = await runner.run(job.id);
      const report = await runner.report(job.id);
      fs.writeFileSync(path.join(outDir, `job-${i}-report.json`), JSON.stringify(report, null, 2));
      expect(settled.state, `job failed: ${settled.failedStage} ${settled.errorMessage}`).toBe('AWAITING_FINAL_APPROVAL');

      const qa = await repo.requireArtifact(settled.artifacts.qaId, 'qa', QAResultSchema);
      const render = await repo.requireArtifact(settled.artifacts.renderId, 'render', RenderJobSchema);
      expect(qa.publishEligible).toBe(true);
      const s = await summarizeMedia(render.videoPath);
      expect(s.video).toMatchObject({ codec: 'h264', width: 1080, height: 1920 });
      expect(Math.round(s.video!.fps)).toBe(30);
      expect(s.audio).toMatchObject({ codec: 'aac', channels: 2, sampleRate: 48000 });
      expect(s.durationSeconds).toBeGreaterThanOrEqual(cfg.SHORT_MIN_SECONDS);
      expect(s.durationSeconds).toBeLessThanOrEqual(cfg.SHORT_MAX_SECONDS);

      // Representative frames for visual inspection.
      const frames = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.floor(f * s.durationSeconds * 30));
      await runFfmpeg([
        '-y', '-i', render.videoPath,
        '-vf', `select='${frames.map((f) => `eq(n\\,${f})`).join('+')}',scale=270:480,tile=5x1`,
        '-frames:v', '1', '-fps_mode', 'vfr', path.join(outDir, `job-${i}-frames.png`),
      ]);
    });
  }
});
