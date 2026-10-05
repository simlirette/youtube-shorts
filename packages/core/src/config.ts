import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

// Load .env file from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().default(3000),

  // Mock flags
  MOCK_LLM: z.string().transform((v) => v === 'true').default('true'),
  MOCK_SEARCH: z.string().transform((v) => v === 'true').default('true'),
  MOCK_TTS: z.string().transform((v) => v === 'true').default('true'),
  MOCK_IMAGE: z.string().transform((v) => v === 'true').default('true'),
  MOCK_VIDEO: z.string().transform((v) => v === 'true').default('true'),
  MOCK_ASSETS: z.string().transform((v) => v === 'true').default('true'),
  MOCK_STORAGE: z.string().transform((v) => v === 'true').default('true'),
  MOCK_YOUTUBE: z.string().transform((v) => v === 'true').default('true'),

  // Database
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/youtube_shorts'),
  USE_SQLITE_FALLBACK: z.string().transform((v) => v === 'true').default('true'),
  SQLITE_DB_PATH: z.string().default('./database/dev.sqlite'),

  // API Keys (Optional when MOCK_* is true)
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-1.5-pro'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),

  TAVILY_API_KEY: z.string().optional().default(''),
  SERPER_API_KEY: z.string().optional().default(''),

  ELEVENLABS_API_KEY: z.string().optional().default(''),
  ELEVENLABS_VOICE_ID: z.string().default('21m00Tcm4TlvDq8ikWAM'),

  REPLICATE_API_TOKEN: z.string().optional().default(''),
  PEXELS_API_KEY: z.string().optional().default(''),
  UNSPLASH_ACCESS_KEY: z.string().optional().default(''),

  YOUTUBE_CLIENT_ID: z.string().optional().default(''),
  YOUTUBE_CLIENT_SECRET: z.string().optional().default(''),
  YOUTUBE_REDIRECT_URI: z.string().default('http://localhost:3000/auth/youtube/callback'),
  YOUTUBE_REFRESH_TOKEN: z.string().optional().default(''),
  YOUTUBE_CHANNEL_ID: z.string().optional().default(''),
  YOUTUBE_DEFAULT_PRIVACY: z.enum(['private', 'unlisted', 'public']).default('private'),

  // Storage and Paths
  STORAGE_TYPE: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./output/storage'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  RENDER_OUTPUT_DIR: z.string().default('./output/renders'),
  TEMP_DIR: z.string().default('./output/temp'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid configuration environment variables:', result.error.format());
    throw new Error('Failed to load application configuration');
  }
  return result.data;
}

export const config = loadConfig();
