import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@shorts/core';
import { ElevenLabsTTSProvider, OpenAILLMProvider, PixabayAssetProvider, TavilySearchProvider, createProviders, missingLiveCredentials } from '@shorts/providers';
import { testConfig } from './helpers.js';

describe('provider factory', () => {
  // Regression 12: missing production keys → clear failure, never a mock.
  it('live mode with missing keys throws a ConfigurationError naming every missing key', () => {
    const cfg = testConfig({ PIPELINE_MODE: 'live' });
    expect(missingLiveCredentials(cfg)).toEqual(['OPENAI_API_KEY', 'TAVILY_API_KEY', 'ELEVENLABS_API_KEY', 'PIXABAY_API_KEY']);
    let err: unknown;
    try {
      createProviders(cfg, 'live');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as Error).message).toMatch(/OPENAI_API_KEY, TAVILY_API_KEY, ELEVENLABS_API_KEY, PIXABAY_API_KEY/);
    expect((err as Error).message).toMatch(/Refusing to fall back to mocks/);
  });

  it('a single missing key in live mode still fails', () => {
    const cfg = testConfig({ OPENAI_API_KEY: 'sk-test', TAVILY_API_KEY: 't', ELEVENLABS_API_KEY: 'e' });
    expect(() => createProviders(cfg, 'live')).toThrow(/PIXABAY_API_KEY/);
  });

  it('youtube publishing requires OAuth credentials', () => {
    const cfg = testConfig({ OPENAI_API_KEY: 'sk-test', TAVILY_API_KEY: 't', ELEVENLABS_API_KEY: 'e', PIXABAY_API_KEY: 'p', PUBLISH_TARGET: 'youtube' });
    expect(() => createProviders(cfg, 'live')).toThrow(/YOUTUBE_CLIENT_ID/);
  });

  it('fully configured live mode builds only real providers', () => {
    const cfg = testConfig({ OPENAI_API_KEY: 'sk-test', TAVILY_API_KEY: 't', ELEVENLABS_API_KEY: 'e', PIXABAY_API_KEY: 'p' });
    const b = createProviders(cfg, 'live');
    expect(b.llm).toBeInstanceOf(OpenAILLMProvider);
    expect(b.search).toBeInstanceOf(TavilySearchProvider);
    expect(b.tts).toBeInstanceOf(ElevenLabsTTSProvider);
    expect(b.assets).toBeInstanceOf(PixabayAssetProvider);
    expect(b.publisher.target).toBe('local_export');
  });

  it('mock mode is all-mock and publishes only to the mock export target', () => {
    const b = createProviders(testConfig(), 'mock');
    expect([b.llm.name, b.search.name, b.tts.name, b.assets.name]).toEqual(['mock-llm', 'mock-search', 'mock-tts', 'mock-stock']);
    expect(b.publisher.target).toBe('mock');
  });

  it('rejects an unknown mode', () => {
    expect(() => createProviders(testConfig(), 'staging' as never)).toThrow(ConfigurationError);
  });
});
