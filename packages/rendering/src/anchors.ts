import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigurationError, InternalError, logger, runProcess } from '@shorts/core';
import { MECHANISM_SCRIPT, type MechanismPlan } from './mechanism-video.js';
import type { AnchorTracks } from './overlays.js';

export interface ProbeOptions {
  blenderPath: string;
  /** The plan whose Blender spec is probed (its labels are ignored: the probe draws none). */
  plan: MechanismPlan;
  /** Part names (as registered by the kit) whose screen position is wanted. */
  parts: string[];
  /** The video's own kit.py, when it brings a new subject. */
  kitFile?: string;
  /** base/<version>/blender_entry.py (frozen) and base/<version>/probe_kit.py. */
  entryScript: string;
  probeKit: string;
  cacheDir: string;
  stepFrames?: number;
}

/**
 * Where each part appears on screen over time, measured by running the frozen Blender script itself (same camera,
 * same animation) through the frozen wrapper. Results are cached by content, so a re-run costs nothing.
 */
export async function probeAnchors(o: ProbeOptions): Promise<AnchorTracks> {
  for (const f of [o.entryScript, o.probeKit, MECHANISM_SCRIPT, ...(o.kitFile ? [o.kitFile] : [])]) {
    if (!fs.existsSync(f)) throw new ConfigurationError(`probe needs ${f}`);
  }
  if (o.parts.length === 0) return {};
  const spec = { ...o.plan.blender, labels: [] as unknown[] };
  const key = createHash('sha256')
    .update(JSON.stringify({ spec, parts: [...o.parts].sort(), step: o.stepFrames ?? 2 }))
    .update(fs.readFileSync(MECHANISM_SCRIPT))
    .update(fs.readFileSync(o.entryScript))
    .update(fs.readFileSync(o.probeKit))
    .update(o.kitFile ? fs.readFileSync(o.kitFile) : '')
    .digest('hex')
    .slice(0, 24);
  fs.mkdirSync(o.cacheDir, { recursive: true });
  const cached = path.join(o.cacheDir, `probe_${key}.json`);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, 'utf-8')) as AnchorTracks;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-probe-'));
  try {
    const out = path.join(work, 'anchors.json');
    const specFile = path.join(work, 'spec.json');
    fs.writeFileSync(
      specFile,
      JSON.stringify({ ...spec, outDir: path.join(work, 'frames'), probe: true, probe_parts: o.parts, probe_out: out, probe_step_frames: o.stepFrames ?? 2, kit_file: o.probeKit, ...(o.kitFile ? { inner_kit_file: o.kitFile } : {}) })
    );
    const started = Date.now();
    const res = await runProcess(o.blenderPath, ['-b', '--factory-startup', '-P', o.entryScript, '--', specFile], { timeoutMs: 20 * 60_000, description: `probe part positions (${o.plan.blender.kit})` });
    if (!/PROBE_OK/.test(res.stdout) || !fs.existsSync(out)) {
      throw new InternalError(`part-position probe failed (exit ${res.code}): ${(res.stderr || res.stdout).split(/\r?\n/).filter(Boolean).slice(-5).join(' | ')}`);
    }
    fs.copyFileSync(out, cached);
    logger.info(`Probed ${o.parts.length} part positions in ${((Date.now() - started) / 1000).toFixed(0)} s`, { stage: 'MEDIA' });
    return JSON.parse(fs.readFileSync(cached, 'utf-8')) as AnchorTracks;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
