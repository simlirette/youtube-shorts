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
import { TavilySearchProvider } from './real/tavily-search.js';
import { ElevenLabsTTSProvider } from './real/elevenlabs-tts.js';
import { PixabayAssetProvider } from './real/pixabay-asset.js';
import { PexelsAssetProvider } from './real/pexels-asset.js';
import { YouTubePublisher } from './real/youtube-official.js';
import { LocalExportPublisher } from './publishers/local-export.js';
import { SourceContentRetriever } from './retrieval/content-retriever.js';

/** Every credential live mode needs for the configured providers, checked up-front. */
export function missingLiveCredentials(cfg: AppConfig): string[] {
  const missing: string[] = [];
  if (cfg.LLM_PROVIDER === 'openai' && !cfg.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (cfg.LLM_PROVIDER === 'gemini' && !cfg.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
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

function liveLlm(cfg: AppConfig, ctx: ProviderContext, model: string): LLMProvider {
  const opts = { timeoutMs: cfg.LLM_TIMEOUT_MS, maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS };
  return cfg.LLM_PROVIDER === 'gemini'
    ? new GeminiLLMProvider(cfg.GEMINI_API_KEY, model, opts, ctx)
    : new OpenAILLMProvider(cfg.OPENAI_API_KEY, model, opts, ctx);
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
    };
  }
  if (mode !== 'live') throw new ConfigurationError(`Unknown pipeline mode "${String(mode)}" (expected mock or live)`);

  const missing = missingLiveCredentials(cfg);
  if (missing.length > 0) {
    throw new ConfigurationError(`Live mode is missing required configuration: ${missing.join(', ')}. Refusing to fall back to mocks.`, { missing });
  }

  const llmModel = cfg.LLM_PROVIDER === 'gemini' ? cfg.GEMINI_MODEL : cfg.OPENAI_MODEL;
  const verifierModel = cfg.LLM_PROVIDER === 'openai' && cfg.OPENAI_VERIFIER_MODEL ? cfg.OPENAI_VERIFIER_MODEL : llmModel;
  const llm = liveLlm(cfg, ctx, llmModel);
  const verifierLlm = verifierModel === llmModel ? llm : liveLlm(cfg, ctx, verifierModel);

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
    search: new TavilySearchProvider(cfg.TAVILY_API_KEY, { timeoutMs: cfg.HTTP_TIMEOUT_MS, maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS, searchDepth: cfg.TAVILY_SEARCH_DEPTH, usdPerCredit: cfg.TAVILY_USD_PER_CREDIT }, ctx),
    retriever: new SourceContentRetriever({ timeoutMs: cfg.HTTP_TIMEOUT_MS, fetchImpl: ctx.fetchImpl }),
    tts: new ElevenLabsTTSProvider(cfg.ELEVENLABS_API_KEY, cfg.ELEVENLABS_VOICE_ID, cfg.ELEVENLABS_MODEL_ID, { timeoutMs: cfg.TTS_TIMEOUT_MS, maxAttempts: cfg.PROVIDER_MAX_ATTEMPTS, usdPer1kChars: cfg.ELEVENLABS_USD_PER_1K_CHARS, speed: cfg.ELEVENLABS_SPEED }, ctx),
    assets,
    publisher,
  };
}
