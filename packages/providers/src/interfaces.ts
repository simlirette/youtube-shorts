import type { z } from 'zod';
import type { AssetCandidate, AssetType, PipelineMode, PublishTarget, YouTubeMetadata } from '@shorts/schemas';
import type { FetchLike } from '@shorts/core';

// =============================================================================
// OBSERVABILITY
// =============================================================================

export interface ProviderCallReport {
  provider: string;
  operation: string;
  status: 'OK' | 'ERROR';
  attempts: number;
  durationMs: number;
  costUsd: number;
  units?: Record<string, number>;
  error?: string;
}

export type ProviderObserver = (report: ProviderCallReport) => void;

/** Shared construction context for every provider implementation. */
export interface ProviderContext {
  observer?: ProviderObserver;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected for tests to avoid real backoff waits. */
  sleep?: (ms: number) => Promise<void>;
}

// =============================================================================
// LLM
// =============================================================================

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface LLMResponse<T> {
  content: T;
  usage: LLMUsage;
  model: string;
  durationMs: number;
  /** Number of model completions requested (validation re-prompts included). */
  attempts: number;
}

export interface StructuredRequest<T> {
  /** Stable task name used for logs, cost attribution and mock routing. */
  task: string;
  system: string;
  prompt: string;
  /** Human-readable description of the JSON shape shown to the model. */
  schemaHint: string;
  /** Structural contract; the response must parse. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Semantic contract; non-empty result triggers a corrective re-prompt. */
  validate?: (value: T) => string[] | Promise<string[]>;
  /** Total completions allowed for structural + semantic validation failures (default 2). */
  maxValidationAttempts?: number;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  /** Optional images (vision). Providers without vision support must throw rather than ignore them. */
  images?: Array<{ mimeType: 'image/jpeg' | 'image/png'; data: Buffer }>;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<T>(req: StructuredRequest<T>): Promise<LLMResponse<T>>;
}

// =============================================================================
// SEARCH
// =============================================================================

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  sourceDomain: string;
  publishedDate?: string;
  /** Full cleaned page text when the provider returns it. */
  rawContent?: string;
}

export interface SearchOptions {
  maxResults: number;
  includeRawContent: boolean;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts: SearchOptions): Promise<SearchResultItem[]>;
}

export interface RetrievedSourceContent {
  url: string;
  title: string;
  cleanText: string;
  contentLength: number;
  statusCode: number;
  retrievedAt: string;
  error?: string;
}

/** Fetches full page text when a search result lacks it. Failures are returned as data. */
export interface PageRetriever {
  retrieveUrl(url: string): Promise<RetrievedSourceContent>;
}

// =============================================================================
// TTS
// =============================================================================

export interface TTSRequest {
  text: string;
  voiceId?: string;
  /** Speaking speed for this request (provider range; ElevenLabs 0.7-1.2). */
  speed?: number;
}

export interface CharacterAlignment {
  characters: string[];
  startTimes: number[];
  endTimes: number[];
}

export interface TTSResult {
  provider: string;
  voiceId: string;
  modelId: string;
  /** Encoded audio exactly as returned by the provider. */
  audio: Buffer;
  audioExtension: 'mp3' | 'wav';
  /** Character-level timing for the submitted text. Required: no timing is ever fabricated. */
  alignment: CharacterAlignment;
}

export interface TTSProvider {
  readonly name: string;
  readonly voiceId: string;
  readonly modelId: string;
  /** Identifies voice settings that change the audio (part of the TTS cache key). */
  readonly settingsKey: string;
  synthesize(req: TTSRequest): Promise<TTSResult>;
  /** Account credits a synthesis of `text` will consume (provider pricing model). */
  creditsFor?(text: string): number;
  /** Remaining account credits, or null when the account does not expose them to this key. */
  remainingCredits?(): Promise<{ remaining: number; limit: number; resetsAt?: string } | null>;
}

// =============================================================================
// STOCK MEDIA
// =============================================================================

export interface AssetSearchRequest {
  query: string;
  mediaType: AssetType;
  /** Upper bound on results requested from the provider. */
  perPage?: number;
}

export interface AssetDownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export interface AssetProvider {
  readonly name: string;
  /** Normalized candidates (nothing downloaded). Empty array = no results; errors throw. */
  search(req: AssetSearchRequest): Promise<AssetCandidate[]>;
  /** Download a candidate's rendition to `destPath`. Validation is performed by the caller. */
  download(candidate: AssetCandidate, destPath: string): Promise<AssetDownloadResult>;
}

// =============================================================================
// PUBLISHING
// =============================================================================

export interface PublishRequest {
  jobId: string;
  videoPath: string;
  metadata: YouTubeMetadata;
}

export interface PublishResult {
  externalId: string;
  url: string;
}

export interface Publisher {
  readonly name: string;
  readonly target: PublishTarget;
  publish(req: PublishRequest): Promise<PublishResult>;
}

// =============================================================================
// BUNDLE
// =============================================================================

// =============================================================================
// AUDIENCE SIGNALS (topic gap discovery)
// =============================================================================

/** One search result as YouTube reports it (no estimates). */
export interface VideoSignal {
  id: string;
  title: string;
  views: number | null;
  durationSeconds: number | null;
  channel: string | null;
}

/** Public audience-demand signals: what viewers type, and what already answers it. */
export interface SignalsProvider {
  readonly name: string;
  /** YouTube search autocomplete for a prefix, most popular first. */
  suggest(prefix: string): Promise<string[]>;
  /** Top YouTube search results for a query. */
  searchVideos(query: string, limit: number): Promise<VideoSignal[]>;
  /** Public counters for specific videos (views/likes/comments), for analytics without OAuth. */
  videoStats(ids: string[]): Promise<Array<{ id: string; views: number | null; likes: number | null; comments: number | null }>>;
}

export interface ProviderBundle {
  mode: PipelineMode;
  llm: LLMProvider;
  /** Model used for claim entailment / content review (may equal `llm`). */
  verifierLlm: LLMProvider;
  search: SearchProvider;
  retriever: PageRetriever;
  tts: TTSProvider;
  assets: AssetProvider;
  publisher: Publisher;
  signals: SignalsProvider;
}
