import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';
import { repoRoot, resolveFromRoot } from './paths.js';
import { ConfigurationError } from './errors.js';

let dotenvLoaded = false;
function loadDotenvOnce(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  if (process.env.SHORTS_SKIP_DOTENV === '1') return;
  dotenv.config({ path: path.join(repoRoot(), '.env'), quiet: true } as dotenv.DotenvConfigOptions);
}

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));
const int = (def: number) => z.coerce.number().int().default(def);
const num = (def: number) => z.coerce.number().default(def);
const str = (def: string) => z.string().default(def);
const optStr = () => z.string().optional().transform((v) => (v && v.trim() ? v.trim() : ''));

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_FORMAT: z.enum(['text', 'json']).default('text'),

    // Execution mode is never defaulted: callers must choose mock or live explicitly.
    PIPELINE_MODE: z.enum(['mock', 'live']).optional(),

    // Provider selection (live mode)
    LLM_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
    SEARCH_PROVIDER: z.enum(['tavily']).default('tavily'),
    TTS_PROVIDER: z.enum(['elevenlabs']).default('elevenlabs'),
    ASSET_PROVIDER: z.enum(['pixabay', 'pexels']).default('pixabay'),
    PUBLISH_TARGET: z.enum(['local_export', 'youtube']).default('local_export'),

    // Credentials
    OPENAI_API_KEY: optStr(),
    OPENAI_MODEL: str('gpt-4o'),
    OPENAI_VERIFIER_MODEL: optStr(),
    GEMINI_API_KEY: optStr(),
    GEMINI_MODEL: str('gemini-2.5-flash'),
    TAVILY_API_KEY: optStr(),
    TAVILY_SEARCH_DEPTH: z.enum(['basic', 'advanced']).default('advanced'),
    ELEVENLABS_API_KEY: optStr(),
    ELEVENLABS_VOICE_ID: str('pNInz6obpgDQGcFmaJgB'),
    ELEVENLABS_MODEL_ID: str('eleven_multilingual_v2'),
    /** ElevenLabs voice speed (0.7-1.2). 1.1 keeps 100-130 words inside 60s for slower voices. */
    ELEVENLABS_SPEED: z.coerce.number().min(0.7).max(1.2).default(1.1),
    PIXABAY_API_KEY: optStr(),
    PEXELS_API_KEY: optStr(),
    YOUTUBE_CLIENT_ID: optStr(),
    YOUTUBE_CLIENT_SECRET: optStr(),
    YOUTUBE_REFRESH_TOKEN: optStr(),
    YOUTUBE_DEFAULT_PRIVACY: z.enum(['private', 'unlisted', 'public']).default('private'),

    // Content contract
    SCRIPT_MIN_WORDS: int(100),
    SCRIPT_MAX_WORDS: int(130),
    SCRIPT_HOOK_MAX_WORDS: int(7),
    SCRIPT_MAX_ATTEMPTS: int(4),
    SHORT_MIN_SECONDS: num(30),
    SHORT_MAX_SECONDS: num(60),
    MIN_VERIFIED_CLAIMS: int(3),
    /** Calibrated on the deterministic weighted score: 20 real topics scored 61.8-74.2; 70 passed 15%. */
    TOPIC_MIN_SCORE: num(65),
    DISCOVERY_RECENT_TOPICS: int(50),
    MEDIA_MIN_RELEVANCE: num(0.3),

    // Approval policy. Defaults are manual (fail closed).
    APPROVAL_IDEA: z.enum(['manual', 'auto']).default('manual'),
    APPROVAL_SCRIPT: z.enum(['manual', 'auto']).default('manual'),
    APPROVAL_FINAL: z.enum(['manual', 'auto_after_qa']).default('manual'),

    // Cost estimates (not billing truth; used for the provider_runs ledger)
    ELEVENLABS_USD_PER_1K_CHARS: num(0.22),
    TAVILY_USD_PER_CREDIT: num(0.008),

    // Audio
    LOUDNESS_TARGET_LUFS: num(-14),
    LOUDNESS_TOLERANCE_LU: num(2),

    // Captions
    CAPTION_FONT_FILE: str('./assets/fonts/Anton-Regular.ttf'),
    CAPTION_FONT_NAME: str('Anton'),

    // Timeouts / limits
    HTTP_TIMEOUT_MS: int(30_000),
    LLM_TIMEOUT_MS: int(120_000),
    TTS_TIMEOUT_MS: int(120_000),
    DOWNLOAD_TIMEOUT_MS: int(180_000),
    FFMPEG_TIMEOUT_MS: int(600_000),
    MAX_DOWNLOAD_BYTES: int(150 * 1024 * 1024),
    PROVIDER_MAX_ATTEMPTS: int(3),
    JOB_LOCK_TTL_MINUTES: int(60),

    // Storage
    OUTPUT_DIR: str('./output'),
    USE_SQLITE_FALLBACK: bool(true),
    SQLITE_DB_PATH: str('./database/dev.sqlite'),
    DATABASE_URL: optStr(),
    FFMPEG_PATH: str('ffmpeg'),
    FFPROBE_PATH: str('ffprobe'),

    // API
    PORT: z.coerce.number().default(3000),
    API_HOST: str('127.0.0.1'),
    API_TOKEN: optStr(),
    API_CORS_ORIGIN: optStr(),
  })
  .superRefine((c, ctx) => {
    if (c.SCRIPT_MIN_WORDS > c.SCRIPT_MAX_WORDS) {
      ctx.addIssue({ code: 'custom', message: 'SCRIPT_MIN_WORDS must be <= SCRIPT_MAX_WORDS' });
    }
    if (c.SHORT_MIN_SECONDS >= c.SHORT_MAX_SECONDS) {
      ctx.addIssue({ code: 'custom', message: 'SHORT_MIN_SECONDS must be < SHORT_MAX_SECONDS' });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema> & {
  outputDir: string;
  sqlitePath: string;
  captionFontFile: string;
};

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AppConfig {
  if (env === process.env) loadDotenvOnce();
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && String(v).trim() !== ''));
  const result = ConfigSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
    throw new ConfigurationError(`Invalid configuration: ${issues.join('; ')}`, { issues });
  }
  const c = result.data;
  return {
    ...c,
    outputDir: resolveFromRoot(c.OUTPUT_DIR),
    sqlitePath: c.SQLITE_DB_PATH === ':memory:' ? ':memory:' : resolveFromRoot(c.SQLITE_DB_PATH),
    captionFontFile: resolveFromRoot(c.CAPTION_FONT_FILE),
  };
}

/**
 * Mock runs are isolated from live state: separate database and output tree, so mock topics,
 * caches and exports can never be selected or published by a live job.
 */
export function configForMode(cfg: AppConfig, mode: 'mock' | 'live'): AppConfig {
  if (mode === 'live') return { ...cfg, PIPELINE_MODE: 'live' };
  const sqlitePath =
    cfg.sqlitePath === ':memory:' ? ':memory:' : path.join(path.dirname(cfg.sqlitePath), `mock-${path.basename(cfg.sqlitePath)}`);
  return { ...cfg, PIPELINE_MODE: 'mock', sqlitePath, outputDir: path.join(cfg.outputDir, 'mock') };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test hook: override or reset the process-wide configuration. */
export function setConfigForTests(next: AppConfig | null): void {
  cached = next;
}
