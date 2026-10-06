import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null = null;

/** Repository root (directory containing pnpm-workspace.yaml), independent of process.cwd(). */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}

export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(repoRoot(), p);
}

/** Make an arbitrary string safe as a single path segment. */
export function sanitizeSegment(name: string, maxLength = 80): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : '_';
}

/** Join path segments under `base`, refusing any result that escapes it. */
export function safeJoin(base: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, ...segments);
  const rel = path.relative(resolvedBase, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${segments.join('/')}`);
  }
  return target;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const JOB_SUBDIRS = ['research', 'script', 'audio', 'captions', 'media', 'render', 'qa', 'final'] as const;
export type JobSubdir = (typeof JOB_SUBDIRS)[number];

export function jobDir(outputDir: string, jobId: string, sub?: JobSubdir): string {
  const base = safeJoin(outputDir, 'jobs', sanitizeSegment(jobId));
  return ensureDir(sub ? safeJoin(base, sub) : base);
}

export function cacheDir(outputDir: string, kind: 'search' | 'media' | 'tts'): string {
  return ensureDir(safeJoin(outputDir, 'cache', kind));
}
