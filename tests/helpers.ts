import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppConfig, ShortsRepository, createDatabase, loadConfig } from '@shorts/core';

/** Isolated config: temp output dir, in-memory DB, never reads .env, never live. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-test-'));
  return loadConfig({
    PIPELINE_MODE: 'mock',
    OUTPUT_DIR: out,
    SQLITE_DB_PATH: ':memory:',
    USE_SQLITE_FALLBACK: 'true',
    SCRIPT_MIN_WORDS: '40',
    SCRIPT_MAX_WORDS: '60',
    SHORT_MIN_SECONDS: '10',
    SHORT_MAX_SECONDS: '60',
    LOG_LEVEL: 'warn',
    ...overrides,
  });
}

export async function memoryRepo(cfg: AppConfig): Promise<ShortsRepository> {
  const repo = new ShortsRepository(createDatabase(cfg, true));
  await repo.init();
  return repo;
}

/** Minimal Response factory for injected fetch implementations. */
export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const uuid = () => randomUUID();
export const nowIso = () => new Date().toISOString();
