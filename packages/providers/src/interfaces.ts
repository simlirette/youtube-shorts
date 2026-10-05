import {
  TopicCandidate,
  TopicScore,
  ResearchPacket,
  StoryOutline,
  ShortScript,
  AssetDescriptor,
  VoiceNarration,
  PublishJob,
  AnalyticsRecord,
  ContentPillar,
} from '@shorts/schemas';

// =============================================================================
// LLM PROVIDER
// =============================================================================

export interface LLMGenerateOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}

export interface LLMProvider {
  name: string;
  generateText(prompt: string, options?: LLMGenerateOptions): Promise<string>;
  generateJSON<T>(prompt: string, schemaDescription: string, options?: LLMGenerateOptions): Promise<T>;
  generateTopicCandidates(pillar?: ContentPillar, count?: number): Promise<TopicCandidate[]>;
  scoreTopic(topic: TopicCandidate): Promise<TopicScore>;
  conductResearch(topic: TopicCandidate): Promise<ResearchPacket>;
  developStory(topic: TopicCandidate, research: ResearchPacket): Promise<StoryOutline>;
  writeScript(story: StoryOutline, research: ResearchPacket): Promise<ShortScript>;
}

// =============================================================================
// SEARCH PROVIDER
// =============================================================================

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  sourceDomain: string;
  publishedDate?: string;
}

export interface SearchProvider {
  name: string;
  search(query: string, maxResults?: number): Promise<SearchResultItem[]>;
}

// =============================================================================
// TTS PROVIDER
// =============================================================================

export interface TTSOptions {
  voiceId?: string;
  speed?: number; // 1.0 = normal
  pitch?: number;
}

export interface TTSProvider {
  name: string;
  synthesizeSpeech(
    scriptId: string,
    narrationText: string,
    outputFilePath: string,
    options?: TTSOptions
  ): Promise<VoiceNarration>;
}

// =============================================================================
// IMAGE / VIDEO / ASSET PROVIDER
// =============================================================================

export interface ImageGenerateOptions {
  width: number;
  height: number;
  style?: string;
}

export interface ImageProvider {
  name: string;
  generateImage(prompt: string, outputPath: string, options?: ImageGenerateOptions): Promise<AssetDescriptor>;
}

export interface VideoProvider {
  name: string;
  generateVideo(prompt: string, outputPath: string, durationSeconds: number): Promise<AssetDescriptor>;
}

export interface AssetProvider {
  name: string;
  searchStockAssets(
    keywords: string[],
    assetType: 'IMAGE' | 'VIDEO',
    sceneNumber?: number
  ): Promise<AssetDescriptor[]>;
  acquireAsset(
    sourceUrl: string,
    destinationPath: string,
    metadata: Partial<AssetDescriptor>
  ): Promise<AssetDescriptor>;
}

// =============================================================================
// STORAGE PROVIDER
// =============================================================================

export interface StorageProvider {
  name: string;
  save(localSourcePath: string, targetKey: string): Promise<string>; // Returns accessible URI or local path
  get(targetKey: string): Promise<string>;
  delete(targetKey: string): Promise<void>;
}

// =============================================================================
// YOUTUBE PUBLISHING PROVIDER
// =============================================================================

export interface YouTubeUploadParams {
  videoPath: string;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: 'private' | 'unlisted' | 'public';
}

export interface YouTubeProvider {
  name: string;
  uploadVideo(params: YouTubeUploadParams): Promise<{ youtubeVideoId: string; watchUrl: string }>;
  getVideoAnalytics(youtubeVideoId: string): Promise<Partial<AnalyticsRecord>>;
  verifyAuthentication(): Promise<boolean>;
}
