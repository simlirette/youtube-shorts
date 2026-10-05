import { config } from '@shorts/core';
import {
  LLMProvider,
  SearchProvider,
  TTSProvider,
  AssetProvider,
  StorageProvider,
  YouTubeProvider,
} from './interfaces.js';
import { MockLLMProvider } from './mock/mock-llm.js';
import { MockSearchProvider } from './mock/mock-search.js';
import { MockTTSProvider } from './mock/mock-tts.js';
import { MockAssetProvider } from './mock/mock-assets.js';
import { MockStorageProvider } from './mock/mock-storage.js';
import { MockYouTubeProvider } from './mock/mock-youtube.js';
import { OpenAILLMProvider } from './real/openai-llm.js';
import { ElevenLabsTTSProvider } from './real/elevenlabs-tts.js';
import { YouTubeOfficialProvider } from './real/youtube-official.js';

export interface ProviderBundle {
  llm: LLMProvider;
  search: SearchProvider;
  tts: TTSProvider;
  asset: AssetProvider;
  storage: StorageProvider;
  youtube: YouTubeProvider;
}

export class ProviderFactory {
  static getLLMProvider(forceMock = false): LLMProvider {
    if (forceMock || config.MOCK_LLM || !config.OPENAI_API_KEY) {
      return new MockLLMProvider();
    }
    return new OpenAILLMProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL);
  }

  static getSearchProvider(forceMock = false): SearchProvider {
    if (forceMock || config.MOCK_SEARCH || !config.TAVILY_API_KEY) {
      return new MockSearchProvider();
    }
    return new MockSearchProvider(); // Fallback until specific web search adapter configured
  }

  static getTTSProvider(forceMock = false): TTSProvider {
    if (forceMock || config.MOCK_TTS || !config.ELEVENLABS_API_KEY) {
      return new MockTTSProvider();
    }
    return new ElevenLabsTTSProvider(config.ELEVENLABS_API_KEY, config.ELEVENLABS_VOICE_ID);
  }

  static getAssetProvider(forceMock = false): AssetProvider {
    return new MockAssetProvider();
  }

  static getStorageProvider(forceMock = false): StorageProvider {
    return new MockStorageProvider(config.STORAGE_LOCAL_DIR);
  }

  static getYouTubeProvider(forceMock = false): YouTubeProvider {
    if (forceMock || config.MOCK_YOUTUBE || !config.YOUTUBE_CLIENT_ID) {
      return new MockYouTubeProvider();
    }
    return new YouTubeOfficialProvider();
  }

  static createBundle(forceMock = false): ProviderBundle {
    return {
      llm: this.getLLMProvider(forceMock),
      search: this.getSearchProvider(forceMock),
      tts: this.getTTSProvider(forceMock),
      asset: this.getAssetProvider(forceMock),
      storage: this.getStorageProvider(forceMock),
      youtube: this.getYouTubeProvider(forceMock),
    };
  }
}
