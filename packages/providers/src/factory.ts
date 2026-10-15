import os from 'node:os';
import path from 'node:path';
import type { PipelineMode } from '@shorts/schemas';
import { AppConfig, ConfigurationError, cacheDir } from '@shorts/core';
import type { LLMProvider, ProviderBundle, ProviderContext, Publisher } from './interfaces.js';
import { MockLLMProvider } from './mock/mock-llm.js';
import { MockPageRetriever, MockSearchProvider } from './mock/mock-search.js';
import { MockTTSProvider } from './mock/mock-tts.js';
import { MockAssetProvider } from './mock/mock-assets.js';
import { OpenAILLMProvider } from './real/openai-llm.js';
import { GeminiLLMProvider } from './real/gemini-llm.js';
import { ClaudeCodeLLMProvider, findClaudeCli } from './real/claude-code-llm.js';
import { FallbackLLMProvider } from './fallback-llm.js';
import { TavilySearchProvider } from './real/tavily-search.js';
import { ElevenLabsTTSProvider } from './real/elevenlabs-tts.js';
import { PixabayAssetProvider } from './real/pixabay-asset.js';
import { PexelsAssetProvider } from './real/pexels-asset.js';
import { YouTubePublisher } from './real/youtube-official.js';
import { YouTubeSignalsProvider } from './real/youtube-signals.js';
import { MockSignalsProvider } from './mock/mock-signals.js';
import { LocalExportPublisher } from './publishers/local-export.js';
import { SourceContentRetriever } from './retrieval/content-retriever.js';

/** Every credential live mode needs for the configured providers, checked up-front. */
export function missingLiveCredentials(cfg: AppConfig): string[] {
  const missing: string[] = [];
  if (cfg.LLM_PROVIDER === 'openai' && !cfg.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if ((cfg.LLM_PROVIDER === 'gemini' || cfg.LLM_FALLBACK_PROVIDER === 'gemini') && !cfg.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (cfg.LLM_FALLBACK_PROVIDER === 'openai' && !cfg.OPENAI_API_KEY && !missing.includes('OPENAI_API_KEY')) missing.push('OPENAI_API_KEY');
  if (cfg.LLM_PROVIDER === 'claude_code' && !findClaudeCli(cfg.CLAUDE_CODE_PATH || undefined)) missing.push('CLAUDE_CODE_PATH (Claude Code CLI not found)');
  if (cfg.SEARCH_PROVIDER === 'tavily' && !cfg.TAVILY_API_KEY) missing.push('TAVILY_API_KEY');
  if (cfg.TTS_PROVIDER === 'elevenlabs') {
    if (!cfg.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY');
    if (!cfg.ELEVENLABS_VOICE_ID) missing.push('ELEVENLABS_VOICE_ID');
  }
  if (cfg.ASSET_PROVIDER === 'pixabay' && !cfg.PIXABAY_API_KEY) missing.push('PIXABAY_API_KEY');
  if (cfg.ASSET_PROVIDER === 'pexels' && !cfg.PEXELS_API_KEY) missing.push('PEXELS_API_KEY');
  if (cfg.PUBLISH_TARGET === 'youtube') {
    for (const k of ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'] as const) if (!cfg[k]) missing.push(k);
  }
  return missing;
}

/** Machine-wide free-tier counters (not per output directory, so separate campaigns share them). */
export function freeTierUsageFile(cfg: AppConfig): string {
  return cfg.FREE_TIER_USAGE_FILE || path.join(os.homedir(), '.shorts-engine', 'free-tier-usage.json');
}

type LlmKind = AppConfig['LLM_PROVIDER'];

function liveLlm(cfg: AppConfig, ctx: ProviderContext, kind: LlmKind, model: string): LLMProvider {
  const opts = { timeoutMs: cfg.LLM_TIMEOUT_MS, maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS };
  if (kind === 'claude_code') return new ClaudeCodeLLMProvider(findClaudeCli(cfg.CLAUDE_CODE_PATH || undefined)!, model, { timeoutMs: cfg.LLM_TIMEOUT_MS }, ctx);
  if (kind === 'gemini') {
    return new GeminiLLMProvider(
      cfg.GEMINI_API_KEY,
      model,
      {
        ...opts,
        thinkingBudget: cfg.GEMINI_THINKING_BUDGET ? Number(cfg.GEMINI_THINKING_BUDGET) : undefined,
        freeTier: cfg.GEMINI_FREE_TIER ? { rpm: cfg.GEMINI_FREE_RPM, rpd: cfg.GEMINI_FREE_RPD, budgetFile: freeTierUsageFile(cfg) } : undefined,
      },
      ctx
    );
  }
  return new OpenAILLMProvider(cfg.OPENAI_API_KEY, model, opts, ctx);
}

/** Writer and verifier models for a provider (the verifier judges facts, scripts, footage and QA). */
function llmModels(cfg: AppConfig, kind: LlmKind): { writer: string; verifier: string } {
  if (kind === 'claude_code') return { writer: cfg.CLAUDE_CODE_MODEL, verifier: cfg.CLAUDE_CODE_VERIFIER_MODEL || cfg.CLAUDE_CODE_MODEL };
  if (kind === 'gemini') return { writer: cfg.GEMINI_MODEL, verifier: cfg.GEMINI_MODEL };
  return { writer: cfg.OPENAI_MODEL, verifier: cfg.OPENAI_VERIFIER_MODEL || cfg.OPENAI_MODEL };
}

/** Writer and verifier LLMs, each falling back per request to LLM_FALLBACK_PROVIDER when configured. */
function liveLlms(cfg: AppConfig, ctx: ProviderContext): { llm: LLMProvider; verifierLlm: LLMProvider } {
  const m = llmModels(cfg, cfg.LLM_PROVIDER);
  const fallbackKind = cfg.LLM_FALLBACK_PROVIDER === 'none' || cfg.LLM_FALLBACK_PROVIDER === cfg.LLM_PROVIDER ? null : cfg.LLM_FALLBACK_PROVIDER;
  const fm = fallbackKind ? llmModels(cfg, fallbackKind) : null;
  const build = (model: string, fallbackModel?: string): LLMProvider => {
    const primary = liveLlm(cfg, ctx, cfg.LLM_PROVIDER, model);
    return fallbackKind && fallbackModel ? new FallbackLLMProvider(primary, liveLlm(cfg, ctx, fallbackKind, fallbackModel)) : primary;
  };
  const llm = build(m.writer, fm?.writer);
  return { llm, verifierLlm: m.verifier === m.writer && fm?.verifier === fm?.writer ? llm : build(m.verifier, fm?.verifier) };
}

/**
 * Builds the provider bundle for an explicitly chosen mode.
 * - mock: every provider is a deterministic local mock.
 * - live: every provider is real; any missing credential is a ConfigurationError. There is no
 *   per-provider fallback to mocks in live mode.
 */
export function createProviders(cfg: AppConfig, mode: PipelineMode, ctx: ProviderContext = {}): ProviderBundle {
  const exportRoot = path.join(cfg.outputDir, 'exports');
  if (mode === 'mock') {
    const llm = new MockLLMProvider(ctx);
    return {
      mode,
      llm,
      verifierLlm: llm,
      search: new MockSearchProvider(),
      retriever: new MockPageRetriever(),
      tts: new MockTTSProvider(),
      assets: new MockAssetProvider(),
      publisher: new LocalExportPublisher(path.join(cfg.outputDir, 'exports-mock'), 'mock'),
      signals: new MockSignalsProvider(),
    };
  }
  if (mode !== 'live') throw new ConfigurationError(`Unknown pipeline mode "${String(mode)}" (expected mock or live)`);

  const missing = missingLiveCredentials(cfg);
  if (missing.length > 0) {
    throw new ConfigurationError(`Live mode is missing required configuration: ${missing.join(', ')}. Refusing to fall back to mocks.`, { missing });
  }

  const { llm, verifierLlm } = liveLlms(cfg, ctx);

  const assets =
    cfg.ASSET_PROVIDER === 'pexels'
      ? new PexelsAssetProvider(cfg.PEXELS_API_KEY, { timeoutMs: cfg.HTTP_TIMEOUT_MS, downloadTimeoutMs: cfg.DOWNLOAD_TIMEOUT_MS, maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS, maxDownloadBytes: cfg.MAX_DOWNLOAD_BYTES }, ctx)
      : new PixabayAssetProvider(
          cfg.PIXABAY_API_KEY,
          {
            timeoutMs: cfg.HTTP_TIMEOUT_MS,
            downloadTimeoutMs: cfg.DOWNLOAD_TIMEOUT_MS,
            maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS,
            maxDownloadBytes: cfg.MAX_DOWNLOAD_BYTES,
            cacheDir: cacheDir(cfg.outputDir, 'search'),
          },
          ctx
        );

  const publisher: Publisher =
    cfg.PUBLISH_TARGET === 'youtube'
      ? new YouTubePublisher(
          { clientId: cfg.YOUTUBE_CLIENT_ID, clientSecret: cfg.YOUTUBE_CLIENT_SECRET, refreshToken: cfg.YOUTUBE_REFRESH_TOKEN },
          { timeoutMs: cfg.HTTP_TIMEOUT_MS, uploadTimeoutMs: cfg.DOWNLOAD_TIMEOUT_MS * 5, maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS },
          ctx
        )
      : new LocalExportPublisher(exportRoot);

  return {
    mode,
    llm,
    verifierLlm,
    search: new TavilySearchProvider(
      cfg.TAVILY_API_KEY,
      {
        timeoutMs: cfg.HTTP_TIMEOUT_MS,
        maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS,
        searchDepth: cfg.TAVILY_SEARCH_DEPTH,
        usdPerCredit: cfg.TAVILY_USD_PER_CREDIT,
        monthlyCredits: cfg.TAVILY_MONTHLY_CREDITS > 0 ? { limit: cfg.TAVILY_MONTHLY_CREDITS, budgetFile: freeTierUsageFile(cfg) } : undefined,
      },
      ctx
    ),
    retriever: new SourceContentRetriever({ timeoutMs: cfg.HTTP_TIMEOUT_MS, fetchImpl: ctx.fetchImpl }),
    tts: new ElevenLabsTTSProvider(cfg.ELEVENLABS_API_KEY, cfg.ELEVENLABS_VOICE_ID, cfg.ELEVENLABS_MODEL_ID, { timeoutMs: cfg.TTS_TIMEOUT_MS, maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS, usdPer1kChars: cfg.ELEVENLABS_USD_PER_1K_CHARS, speed: cfg.ELEVENLABS_SPEED }, ctx),
    assets,
    publisher,
    // Free public signals (autocomplete + yt-dlp); never billed, so always the real provider in live mode.
    signals: new YouTubeSignalsProvider({ ytdlpPath: cfg.YTDLP_PATH, timeoutMs: cfg.HTTP_TIMEOUT_MS * 4 }, ctx),
  };
}
