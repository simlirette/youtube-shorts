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

/** Silence padding appended after the last word, and safety margin under the platform limit. */
export const VOICE_TAIL_SECONDS = 0.6;
export const DURATION_MARGIN_SECONDS = 0.4;

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_FORMAT: z.enum(['text', 'json']).default('text'),

    // Execution mode is never defaulted: callers must choose mock or live explicitly.
    PIPELINE_MODE: z.enum(['mock', 'live']).optional(),

    // Provider selection (live mode)
    LLM_PROVIDER: z.enum(['openai', 'gemini', 'claude_code']).default('openai'),
    /** Used per request when the main LLM is rate-limited, out of quota, overloaded or timing out. */
    LLM_FALLBACK_PROVIDER: z.enum(['none', 'gemini', 'openai']).default('none'),
    SEARCH_PROVIDER: z.enum(['tavily']).default('tavily'),
    TTS_PROVIDER: z.enum(['elevenlabs']).default('elevenlabs'),
    ASSET_PROVIDER: z.enum(['pixabay', 'pexels']).default('pixabay'),
    PUBLISH_TARGET: z.enum(['local_export', 'youtube']).default('local_export'),

    // Credentials
    OPENAI_API_KEY: optStr(),
    OPENAI_MODEL: str('gpt-4o'),
    OPENAI_VERIFIER_MODEL: optStr(),
    /** Claude Code CLI (claude.ai plan, $0 per call): executable path; empty = auto-detect. */
    CLAUDE_CODE_PATH: optStr(),
    /** Model alias or id for writing (story, script, beats) and for judging (fact review, editor, QA, vision). */
    CLAUDE_CODE_MODEL: str('sonnet'),
    CLAUDE_CODE_VERIFIER_MODEL: optStr(),
    GEMINI_API_KEY: optStr(),
    GEMINI_MODEL: str('gemini-3.8-flash'),
    /** Free tier: calls are recorded at $0 and limited below Google's free quotas (see docs/FREE_WORKFLOW.md). */
    GEMINI_FREE_TIER: bool(false),
    /** Requests per minute / per Pacific-time day this machine allows itself on the free tier. */
    GEMINI_FREE_RPM: int(8),
    GEMINI_FREE_RPD: int(200),
    /** Thinking tokens for Flash models (0 = off; they count against the output limit). Empty = model default. */
    GEMINI_THINKING_BUDGET: optStr(),
    TAVILY_API_KEY: optStr(),
    TAVILY_SEARCH_DEPTH: z.enum(['basic', 'advanced']).default('advanced'),
    /** Free plan: credits per month this machine may use (0 = no cap). The free plan has 1,000. */
    TAVILY_MONTHLY_CREDITS: int(0),
    /** Free-tier counters shared by every run on this machine (default ~/.shorts-engine/free-tier-usage.json). */
    FREE_TIER_USAGE_FILE: optStr(),
    ELEVENLABS_API_KEY: optStr(),
    ELEVENLABS_VOICE_ID: str('pNInz6obpgDQGcFmaJgB'),
    ELEVENLABS_MODEL_ID: str('eleven_multilingual_v2'),
    /**
     * ElevenLabs voice speed (0.7-1.2). Measured live (2026-10-10): 1.1 gave 2.2-2.5 words/s
     * with timestamp gap cuts only; 1.2 gave 3.06-3.07 with the acoustic gap pass (target 2.6-3.0).
     * 1.15 is the default; re-measure it with `pnpm acceptance:campaign`.
     */
    ELEVENLABS_SPEED: z.coerce.number().min(0.7).max(1.2).default(1.15),
    PIXABAY_API_KEY: optStr(),
    PEXELS_API_KEY: optStr(),
    YOUTUBE_CLIENT_ID: optStr(),
    YOUTUBE_CLIENT_SECRET: optStr(),
    YOUTUBE_REFRESH_TOKEN: optStr(),
    YOUTUBE_DEFAULT_PRIVACY: z.enum(['private', 'unlisted', 'public']).default('private'),
    /** 27 = Education, 28 = Science & Technology. */
    YOUTUBE_CATEGORY_ID: str('27'),
    /** Declares altered/synthetic content (AI narration). Labelled content keeps reach and monetization. */
    YOUTUBE_CONTAINS_SYNTHETIC_MEDIA: bool(true),
    /**
     * Uploads from Google Cloud projects that have not passed YouTube's API audit are locked private.
     * Only set true after the audit; it enables scheduled public release (publishAt).
     */
    YOUTUBE_PROJECT_AUDITED: bool(false),
    /** Daily local publish slots ("HH:MM,HH:MM") and their timezone, for scheduled releases. */
    PUBLISH_SLOTS: str('17:00'),
    PUBLISH_TIMEZONE: str('America/New_York'),
    /** Upload cap per rolling 24 h (YouTube default project limit is 100 videos.insert per day). */
    MAX_UPLOADS_PER_DAY: int(3),
    /** Refuse to synthesize when the ElevenLabs account cannot cover the narration (needs user_read). */
    ELEVENLABS_CREDIT_PREFLIGHT: bool(true),

    // Topic discovery
    /** gap = measured viewer questions (autocomplete + YouTube supply/demand); llm = model brainstorming. */
    DISCOVERY_MODE: z.enum(['gap', 'llm']).default('gap'),
    /** Question seeds "cluster:seed|cluster:seed" for gap discovery. */
    GAP_SEEDS: str(
      'aviation:why do planes|aviation:why do pilots|maritime:why do ships|maritime:why are cargo ships|infrastructure:why are bridges|infrastructure:why do skyscrapers|infrastructure:why are runways|odd_laws:why is it illegal to|engineering:why do trains|engineering:how do submarines'
    ),
    /** Minimum gap score (0-100) for a question to become a topic. */
    GAP_MIN_SCORE: num(45),
    /** Questions probed against YouTube search per discovery run (each probe is one free search). */
    GAP_MAX_PROBES: int(16),
    YTDLP_PATH: str('yt-dlp'),

    // Formats & sourcing preflight
    /** Enabled script formats: MICRO_EXPLAINER (default target format), QUESTION_ANSWER, THREE_REASONS, STORY. */
    SHORT_FORMATS: str('MICRO_EXPLAINER'),

    // Editorial defaults (frozen per job in its production variant; see EXPERIMENT)
    /** statement = concrete claim; scene = action in progress; question = experiments only. */
    HOOK_TYPE: z.enum(['statement', 'scene', 'question']).default('statement'),
    /** standard = 30-45 s; short = 25-35 s (experimental band). */
    DURATION_BAND: z.enum(['standard', 'short']).default('standard'),
    TITLE_CARD: bool(true),
    CAPTION_STYLE: z.enum(['plain', 'highlight']).default('plain'),
    /** Mix an approved track from MUSIC_LIBRARY under the narration (recorded as disabled when none is approved). */
    MUSIC_ENABLED: bool(true),
    MUSIC_LIBRARY: str('./assets/music/library.json'),
    /** Music bed level below the narration's integrated loudness, in LU. */
    MUSIC_BED_LU: num(20),
    /** Calls to action are not generated yet; recorded for completeness. */
    CTA_ENABLED: bool(false),
    /**
     * One-factor experiment "id|factor|valueA,valueB" (factor: hookType, durationBand, titleCard,
     * music, captionStyle, voiceSpeed, format). Empty = no experiment.
     */
    EXPERIMENT: str(''),

    // Script editor (separate from the writer)
    EDITOR_ENABLED: bool(true),
    EDITOR_MAX_REVISIONS: int(2),
    EDITOR_MIN_TOTAL: num(15),
    EDITOR_MIN_HOOK: num(4),
    EDITOR_MIN_PAYOFF: num(4),

    // Narration continuity and pacing (measured on the narration stem)
    SPEECH_START_MAX_SECONDS: num(0.3),
    /** Longest silence allowed between words after tightening (acceptance: 0.4 s). */
    MAX_SPEECH_GAP_SECONDS: num(0.4),
    /** Inter-sentence gaps longer than this are shortened to it. */
    NARRATION_GAP_TARGET_SECONDS: num(0.22),
    PACE_MIN_WPS: num(2.6),
    PACE_MAX_WPS: num(3.0),

    // Visual beats and framing
    MIN_SHOT_SECONDS: num(1.6),
    MAX_SHOT_SECONDS: num(4.0),
    /** Landscape footage is cropped to fill 9:16 unless that would upscale more than this. */
    MAX_UPSCALE: num(2.0),
    /** Locally rendered Blender graphics for clauses stock cannot show (used only when Blender is found). */
    GRAPHICS_ENABLED: bool(true),
    /** Blender executable; empty = auto-detect (standard install folders, then PATH). */
    BLENDER_PATH: optStr(),
    /** Largest share of beats shown as graphics (the rest stays real footage). */
    GRAPHICS_MAX_SHARE: num(0.4),
    /** Share of shots that must be full-bleed (acceptance: 90 %). */
    FULL_BLEED_MIN_RATIO: num(0.9),
    /** Usable stock candidates each scene needs before voice credits are spent. */
    MEDIA_PREFLIGHT_MIN_CANDIDATES: int(3),
    /** Same check per visual beat (one short shot each) in beat formats. */
    MEDIA_PREFLIGHT_MIN_BEAT_CANDIDATES: int(2),

    // Content contract
    SCRIPT_MIN_WORDS: int(100),
    /**
     * Upper bound derived from the voice, not from taste: the slowest measured ElevenLabs pace at
     * speed 1.1 was ~2.0 words/s, so 118 words + ~0.6 s tail stays under a 59.6 s narration.
     */
    SCRIPT_MAX_WORDS: int(118),
    /** Slowest expected speaking rate of the configured voice (words per second); see validation below. */
    VOICE_MIN_WORDS_PER_SECOND: num(2.0),
    SCRIPT_HOOK_MAX_WORDS: int(7),
    SCRIPT_MAX_ATTEMPTS: int(4),
    SHORT_MIN_SECONDS: num(20),
    SHORT_MAX_SECONDS: num(60),
    MIN_VERIFIED_CLAIMS: int(3),
    /**
     * Editorial selectivity knob, NOT an objective quality line. Observed distribution of the
     * deterministic weighted score: 20 real topics scored 61.8-74.2; 65 admits ~75%, 70 admits ~15%.
     * Topics above the gate still pass every downstream evidence/QA gate; see docs/WORKFLOW.md.
     */
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
    DB_CONNECT_TIMEOUT_MS: int(5000),
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
    const formats = c.SHORT_FORMATS.split(',').map((f) => f.trim()).filter(Boolean);
    const unknown = formats.filter((f) => !['MICRO_EXPLAINER', 'QUESTION_ANSWER', 'THREE_REASONS', 'STORY'].includes(f));
    if (formats.length === 0 || unknown.length) ctx.addIssue({ code: 'custom', message: `SHORT_FORMATS has unknown or no formats: ${unknown.join(', ') || '(empty)'}` });
    if (!c.PUBLISH_SLOTS.split(',').every((s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s.trim()))) {
      ctx.addIssue({ code: 'custom', message: 'PUBLISH_SLOTS must be a comma list of HH:MM times' });
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: c.PUBLISH_TIMEZONE });
    } catch {
      ctx.addIssue({ code: 'custom', message: `PUBLISH_TIMEZONE "${c.PUBLISH_TIMEZONE}" is not a valid IANA timezone` });
    }
    if (c.EXPERIMENT.trim()) {
      const [id, factor, values] = c.EXPERIMENT.split('|').map((x) => (x ?? '').trim());
      const factors = ['hookType', 'durationBand', 'titleCard', 'music', 'captionStyle', 'voiceSpeed', 'format'];
      if (!id || !factors.includes(factor) || !values || values.split(',').filter(Boolean).length < 2) {
        ctx.addIssue({ code: 'custom', message: `EXPERIMENT must be "id|factor|valueA,valueB" with factor in ${factors.join(', ')}` });
      }
    }
    if (c.PACE_MIN_WPS >= c.PACE_MAX_WPS) ctx.addIssue({ code: 'custom', message: 'PACE_MIN_WPS must be < PACE_MAX_WPS' });
    if (c.GRAPHICS_MAX_SHARE < 0 || c.GRAPHICS_MAX_SHARE > 0.6) ctx.addIssue({ code: 'custom', message: 'GRAPHICS_MAX_SHARE must be between 0 and 0.6' });
    if (c.MIN_SHOT_SECONDS >= c.MAX_SHOT_SECONDS) ctx.addIssue({ code: 'custom', message: 'MIN_SHOT_SECONDS must be < MAX_SHOT_SECONDS' });
    if (c.NARRATION_GAP_TARGET_SECONDS > c.MAX_SPEECH_GAP_SECONDS) ctx.addIssue({ code: 'custom', message: 'NARRATION_GAP_TARGET_SECONDS must be <= MAX_SPEECH_GAP_SECONDS' });
    for (const part of c.GAP_SEEDS.split('|')) {
      if (!/^[a-z_]+:.{3,}$/.test(part.trim())) ctx.addIssue({ code: 'custom', message: `GAP_SEEDS entry "${part}" must be "cluster:seed phrase"` });
    }
    if (c.SHORT_MIN_SECONDS >= c.SHORT_MAX_SECONDS) {
      ctx.addIssue({ code: 'custom', message: 'SHORT_MIN_SECONDS must be < SHORT_MAX_SECONDS' });
    }
    // The generation contract must be achievable by the voice: the longest permitted script, read at
    // the slowest expected pace, plus the trailing pad must still fit inside the Short.
    const worstSeconds = c.SCRIPT_MAX_WORDS / c.VOICE_MIN_WORDS_PER_SECOND + VOICE_TAIL_SECONDS;
    if (worstSeconds > c.SHORT_MAX_SECONDS - DURATION_MARGIN_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        message: `SCRIPT_MAX_WORDS=${c.SCRIPT_MAX_WORDS} at VOICE_MIN_WORDS_PER_SECOND=${c.VOICE_MIN_WORDS_PER_SECOND} needs ~${worstSeconds.toFixed(1)}s, over SHORT_MAX_SECONDS-${DURATION_MARGIN_SECONDS}`,
      });
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
