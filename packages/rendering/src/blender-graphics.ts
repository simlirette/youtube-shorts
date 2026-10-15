import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConfigurationError, InternalError, logger, repoRoot, runFfmpeg, runProcess } from '@shorts/core';
import type { GraphicSpec } from '@shorts/schemas';

/**
 * Mock mode stand-in: a moving test pattern of the right size and length (no Blender needed).
 * Never used in live mode.
 */
export class MockGraphicRenderer {
  readonly version = 'mock-graphic';
  async render(_spec: GraphicSpec, seconds: number, outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', `testsrc2=size=1080x1920:rate=30:duration=${seconds.toFixed(2)}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outPath], {
      description: 'mock graphic',
    });
  }
}

/** The Blender template script (packages/rendering/blender/graphic.py). */
export const GRAPHIC_SCRIPT = path.join(repoRoot(), 'packages', 'rendering', 'blender', 'graphic.py');

/**
 * Locates Blender: the configured path (or a name on PATH) first, then the standard install
 * locations (newest version first). Returns null when none is found.
 */
export function findBlender(configured?: string): string | null {
  if (configured && configured !== 'blender') return fs.existsSync(configured) ? configured : null;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
      const dir = path.join(base, 'Blender Foundation');
      if (!fs.existsSync(dir)) continue;
      const versions = fs.readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) candidates.push(path.join(dir, v, 'blender.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Blender.app/Contents/MacOS/Blender');
  } else {
    candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) candidates.push(path.join(dir, process.platform === 'win32' ? 'blender.exe' : 'blender'));
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export interface BlenderGraphicOptions {
  blenderPath: string;
  fontFile: string;
  /** Rendered graphics are cached here by content hash (same spec + length = same file). */
  cacheDir: string;
  timeoutMs?: number;
  theme?: Record<string, string>;
}

/**
 * Renders the motion-graphics templates with headless Blender (Eevee) to PNG frames and encodes
 * them to H.264 1080x1920 30 fps. Free and local; about 0.5 s per frame on a laptop GPU, so every
 * result is cached.
 */
export class BlenderGraphicRenderer {
  readonly version: string;

  constructor(private readonly o: BlenderGraphicOptions) {
    if (!fs.existsSync(o.blenderPath)) throw new ConfigurationError(`Blender not found at ${o.blenderPath} (set BLENDER_PATH or install Blender)`);
    if (!fs.existsSync(GRAPHIC_SCRIPT)) throw new ConfigurationError(`graphic template script missing: ${GRAPHIC_SCRIPT}`);
    // A change to the templates invalidates the cache.
    this.version = `blender-graphic:${createHash('sha256').update(fs.readFileSync(GRAPHIC_SCRIPT)).digest('hex').slice(0, 10)}`;
  }

  cacheKey(spec: GraphicSpec, seconds: number): string {
    return createHash('sha256')
      .update(JSON.stringify({ spec, seconds: Math.round(seconds * 100) / 100, v: this.version, theme: this.o.theme ?? null }))
      .digest('hex')
      .slice(0, 24);
  }

  async render(spec: GraphicSpec, seconds: number, outPath: string): Promise<void> {
    fs.mkdirSync(this.o.cacheDir, { recursive: true });
    const cached = path.join(this.o.cacheDir, `${this.cacheKey(spec, seconds)}.mp4`);
    if (!fs.existsSync(cached)) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-graphic-'));
      try {
        const frames = path.join(work, 'frames');
        const { template, ...params } = spec;
        const specFile = path.join(work, 'spec.json');
        fs.writeFileSync(specFile, JSON.stringify({ template, [template]: params, seconds, fps: 30, width: 1080, height: 1920, font: this.o.fontFile, outDir: frames, theme: this.o.theme ?? {} }));
        const started = Date.now();
        const res = await runProcess(this.o.blenderPath, ['-b', '--factory-startup', '-P', GRAPHIC_SCRIPT, '--', specFile], {
          timeoutMs: this.o.timeoutMs ?? 600_000,
          description: `blender ${template} graphic`,
        });
        if (res.code !== 0 || !/GRAPHIC_OK/.test(res.stdout)) {
          throw new InternalError(`Blender failed to render the ${template} graphic (exit ${res.code}): ${(res.stderr || res.stdout).split(/\r?\n/).filter(Boolean).slice(-6).join(' | ')}`);
        }
        const tmpMp4 = path.join(work, 'out.mp4');
        await runFfmpeg(['-y', '-framerate', '30', '-i', path.join(frames, '%04d.png'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmpMp4], {
          description: 'encode graphic',
        });
        fs.renameSync(tmpMp4, cached);
        logger.info(`Rendered ${template} graphic (${seconds.toFixed(2)} s) with Blender in ${((Date.now() - started) / 1000).toFixed(0)} s`, { stage: 'MEDIA' });
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(cached, outPath);
  }
}
