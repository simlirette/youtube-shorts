import { z } from 'zod';

// =============================================================================
// SHARED ENUMS
// =============================================================================

export const ContentPillarSchema = z.enum([
  'BUSINESS',
  'TECHNOLOGY',
  'ENGINEERING',
  'SCIENCE',
  'STRANGE_REAL_WORLD',
]);
export type ContentPillar = z.infer<typeof ContentPillarSchema>;
export const CONTENT_PILLARS = ContentPillarSchema.options;

/** Lifecycle of a topic in the catalog (independent of any single production job). */
export const TopicStatusSchema = z.enum(['DISCOVERED', 'SCORED', 'REJECTED', 'IN_PRODUCTION', 'USED']);
export type TopicStatus = z.infer<typeof TopicStatusSchema>;

/** Lifecycle of one production job (one Short). Enforced by JobStateMachine in @shorts/core. */
export const JobStateSchema = z.enum([
  'CREATED',
  'SELECTING_TOPIC',
  'AWAITING_IDEA_APPROVAL',
  'RESEARCHING',
  'SCRIPTING',
  'AWAITING_SCRIPT_APPROVAL',
  'SYNTHESIZING_VOICE',
  'BUILDING_TIMELINE',
  'SOURCING_MEDIA',
  'RENDERING',
  'QA',
  'AWAITING_FINAL_APPROVAL',
  'READY_TO_PUBLISH',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'REJECTED',
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const PipelineModeSchema = z.enum(['mock', 'live']);
export type PipelineMode = z.infer<typeof PipelineModeSchema>;

export const ApprovalStageSchema = z.enum(['IDEA', 'SCRIPT', 'FINAL_VIDEO']);
export type ApprovalStage = z.infer<typeof ApprovalStageSchema>;

export const ApprovalDecisionSchema = z.enum(['APPROVED', 'REJECTED', 'REVISIONS_REQUESTED']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

const isoDate = z.string().datetime();

// =============================================================================
// 1. TOPIC DISCOVERY & SCORING
// =============================================================================

export const TopicCandidateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(5).max(140),
  premise: z.string().min(10),
  pillar: ContentPillarSchema,
  /** Reference URLs are only recorded once research has actually retrieved them; discovery never invents them. */
  sourceUrls: z.array(z.string().url()).default([]),
  discoveredAt: isoDate,
  tags: z.array(z.string()).default([]),
  status: TopicStatusSchema.default('DISCOVERED'),
  /** Normalized, order-independent key of significant title tokens used for deduplication. */
  dedupeKey: z.string().optional(),
});
export type TopicCandidate = z.infer<typeof TopicCandidateSchema>;

export const ScoreDimensionsSchema = z.object({
  curiosity: z.number().min(0).max(10),
  audiencePotential: z.number().min(0).max(10),
  originality: z.number().min(0).max(10),
  storyDepth: z.number().min(0).max(10),
  visualPotential: z.number().min(0).max(10),
  sourceAvailability: z.number().min(0).max(10),
  freshness: z.number().min(0).max(10),
  productionComplexity: z.number().min(0).max(10),
  copyrightRisk: z.number().min(0).max(10),
  repetitionRisk: z.number().min(0).max(10),
  monetizationRisk: z.number().min(0).max(10),
});
export type ScoreDimensions = z.infer<typeof ScoreDimensionsSchema>;

export const TopicScoreSchema = ScoreDimensionsSchema.extend({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  /** Computed deterministically from the dimensions — never taken from the LLM. */
  overallScore: z.number().min(0).max(100),
  reasoning: z.string().min(1),
  passGate: z.boolean(),
  gateReasons: z.array(z.string()).default([]),
  scoredAt: isoDate,
});
export type TopicScore = z.infer<typeof TopicScoreSchema>;

// =============================================================================
// 2. RESEARCH, SOURCES & CLAIM VERIFICATION
// =============================================================================

export const CredibilityTierSchema = z.enum([
  'PRIMARY_SOURCE',
  'AUTHORITATIVE_SECONDARY',
  'PEER_REVIEWED',
  'REPUTABLE_JOURNALISM',
  'PUBLIC_DATASET',
  'UNCLASSIFIED',
]);
export type CredibilityTier = z.infer<typeof CredibilityTierSchema>;

export const SourceReferenceSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  title: z.string(),
  publisher: z.string(),
  publishDate: z.string().optional(),
  credibilityTier: CredibilityTierSchema,
  retrievedAt: isoDate,
  retrievalMethod: z.enum(['search_raw_content', 'http_fetch', 'search_snippet']),
  contentChars: z.number().int().nonnegative(),
  contentSha256: z.string().length(64),
  archiveUrl: z.string().url().optional(),
});
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const ClaimVerificationStatusSchema = z.enum(['VERIFIED', 'UNVERIFIED', 'REJECTED']);
export type ClaimVerificationStatus = z.infer<typeof ClaimVerificationStatusSchema>;

export const EntailmentSchema = z.enum(['SUPPORTED', 'PARTIAL', 'NOT_SUPPORTED', 'NOT_CHECKED']);
export type Entailment = z.infer<typeof EntailmentSchema>;

export const ClaimEvidenceSchema = z.object({
  sourceId: z.string().uuid(),
  quote: z.string().min(1),
  /** True only when the quote was found (normalized) inside the retrieved text of `sourceId`. */
  quoteFound: z.boolean(),
});
export type ClaimEvidence = z.infer<typeof ClaimEvidenceSchema>;

export const ClaimSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(5),
  entity: z.string(),
  /** Sources whose retrieved text contains supporting evidence. Empty for unverified claims. */
  sourceIds: z.array(z.string().uuid()),
  evidence: z.array(ClaimEvidenceSchema),
  verificationStatus: ClaimVerificationStatusSchema,
  verificationReason: z.string().min(1),
  checks: z.object({
    quoteFound: z.boolean(),
    numbersConsistent: z.boolean(),
    entailment: EntailmentSchema,
  }),
  /** Derived from the checks, never from LLM self-assessment. */
  confidence: z.number().min(0).max(1),
  isKeyFact: z.boolean().default(true),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ResearchPacketSchema = z.object({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  title: z.string(),
  summary: z.string().min(1),
  keyEntities: z.array(z.string()),
  claims: z.array(ClaimSchema),
  sources: z.array(SourceReferenceSchema).min(1),
  uncertaintyNotes: z.array(z.string()).default([]),
  verifiedClaimCount: z.number().int().nonnegative(),
  researchedAt: isoDate,
});
export type ResearchPacket = z.infer<typeof ResearchPacketSchema>;

// =============================================================================
// 3. STORY & SCRIPT
// =============================================================================

export const StoryOutlineSchema = z.object({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  logline: z.string().min(1),
  centralConflict: z.string().min(1),
  hookConcept: z.string().min(1),
  narrativeArc: z.object({
    hook: z.string().min(1),
    context: z.string().min(1),
    development: z.string().min(1),
    twist: z.string().min(1),
    payoff: z.string().min(1),
  }),
  targetDurationSeconds: z.number().min(30).max(60).default(45),
  createdAt: isoDate,
});
export type StoryOutline = z.infer<typeof StoryOutlineSchema>;

export const MediaFormatSchema = z.enum([
  'LICENSED_STOCK',
  'HISTORICAL_IMAGE',
  'PUBLIC_DOMAIN_ARCHIVE',
  'CHART_DATA',
  'MAP_GEOGRAPHIC',
  'TIMELINE_GRAPHIC',
  'GENERATED_IMAGE',
  'MOTION_TYPOGRAPHY',
]);
export type MediaFormat = z.infer<typeof MediaFormatSchema>;

export const SceneSchema = z.object({
  sceneNumber: z.number().int().positive(),
  narration: z.string().min(1),
  visualObjective: z.string().min(1),
  mediaFormat: MediaFormatSchema.default('LICENSED_STOCK'),
  /** Generic, stock-searchable visual terms (no names or dates). */
  assetKeywords: z.array(z.string().min(2)).min(1),
  visualPrompt: z.string().optional(),
  textOverlay: z.string().optional(),
  transitionIntent: z.enum(['CUT', 'FADE', 'ZOOM_IN', 'PAN_LEFT', 'PAN_RIGHT']).default('CUT'),
  /** Verified claim IDs asserted by this scene. Never back-filled. */
  claimIds: z.array(z.string().uuid()).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ShortScriptSchema = z.object({
  id: z.string().uuid(),
  storyId: z.string().uuid(),
  topicId: z.string().uuid(),
  title: z.string().min(5).max(100),
  description: z.string().max(5000).default(''),
  hookText: z.string().min(5),
  targetDurationSeconds: z.number().min(30).max(60),
  scenes: z.array(SceneSchema).min(3),
  totalWords: z.number().int().positive(),
  generationAttempts: z.number().int().positive().default(1),
  createdAt: isoDate,
});
export type ShortScript = z.infer<typeof ShortScriptSchema>;

// =============================================================================
// 4. VOICE NARRATION & TIMELINE
// =============================================================================

export const WordTimestampSchema = z.object({
  word: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
});
export type WordTimestamp = z.infer<typeof WordTimestampSchema>;

export const VoiceNarrationSchema = z.object({
  id: z.string().uuid(),
  scriptId: z.string().uuid(),
  provider: z.string(),
  voiceId: z.string(),
  modelId: z.string(),
  /** Normalized narration actually used by the renderer (PCM WAV). */
  audioPath: z.string().min(1),
  /** Untouched provider output. */
  rawAudioPath: z.string().min(1),
  /** Probed from the normalized file, not estimated. */
  durationSeconds: z.number().positive(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  codec: z.string(),
  integratedLufs: z.number(),
  truePeakDb: z.number(),
  wordTimestamps: z.array(WordTimestampSchema).min(1),
  sha256: z.string().length(64),
  cacheKey: z.string().length(64),
  synthesizedAt: isoDate,
});
export type VoiceNarration = z.infer<typeof VoiceNarrationSchema>;

export const TimelineSceneSchema = z.object({
  sceneNumber: z.number().int().positive(),
  start: z.number().min(0),
  end: z.number().positive(),
  firstWordIndex: z.number().int().nonnegative(),
  lastWordIndex: z.number().int().nonnegative(),
});
export type TimelineScene = z.infer<typeof TimelineSceneSchema>;

export const CaptionCueSchema = z.object({
  index: z.number().int().nonnegative(),
  sceneNumber: z.number().int().positive(),
  start: z.number().min(0),
  end: z.number().positive(),
  lines: z.array(z.string().min(1)).min(1).max(2),
  firstWordIndex: z.number().int().nonnegative(),
  lastWordIndex: z.number().int().nonnegative(),
});
export type CaptionCue = z.infer<typeof CaptionCueSchema>;

/** Single authoritative timeline derived from narration word timestamps. */
/** A visual cut inside a scene. Long scenes are split so no single clip holds the screen too long. */
export const TimelineShotSchema = z.object({
  sceneNumber: z.number().int().positive(),
  shotIndex: z.number().int().nonnegative(),
  start: z.number().min(0),
  end: z.number().positive(),
});
export type TimelineShot = z.infer<typeof TimelineShotSchema>;

export const TimelineSchema = z.object({
  fps: z.number().int().positive(),
  narrationDurationSeconds: z.number().positive(),
  totalDurationSeconds: z.number().positive(),
  totalFrames: z.number().int().positive(),
  scenes: z.array(TimelineSceneSchema).min(1),
  shots: z.array(TimelineShotSchema).min(1),
  captions: z.array(CaptionCueSchema).min(1),
});
export type Timeline = z.infer<typeof TimelineSchema>;

// =============================================================================
// 5. MEDIA ASSETS
// =============================================================================

export const AssetTypeSchema = z.enum(['IMAGE', 'VIDEO']);
export type AssetType = z.infer<typeof AssetTypeSchema>;

/** Normalized search result from any stock provider (nothing downloaded yet). */
export const AssetCandidateSchema = z.object({
  provider: z.string(),
  providerMediaId: z.string(),
  mediaType: AssetTypeSchema,
  pageUrl: z.string().url(),
  previewUrl: z.string().url().optional(),
  downloadUrl: z.string().url(),
  /** Dimensions of the rendition referenced by downloadUrl. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspectRatio: z.number().positive(),
  durationSeconds: z.number().positive().optional(),
  fileSizeBytes: z.number().int().positive().optional(),
  tags: z.array(z.string()),
  description: z.string().default(''),
  author: z.string().optional(),
  license: z.string(),
  commercialUseAllowed: z.boolean(),
  attributionRequired: z.boolean(),
});
export type AssetCandidate = z.infer<typeof AssetCandidateSchema>;

export const AssetRankingSchema = z.object({
  score: z.number(),
  relevance: z.number().min(0).max(1),
  matchedTerms: z.array(z.string()),
  orientation: z.number(),
  resolution: z.number(),
  duration: z.number(),
  reasons: z.array(z.string()),
});
export type AssetRanking = z.infer<typeof AssetRankingSchema>;

export const MediaProbeSchema = z.object({
  formatName: z.string(),
  videoCodec: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().nonnegative(),
  hasAudio: z.boolean(),
  sizeBytes: z.number().int().positive(),
});
export type MediaProbe = z.infer<typeof MediaProbeSchema>;

/** A downloaded, ffprobe-validated asset bound to a scene. */
export const AssetDescriptorSchema = z.object({
  id: z.string().uuid(),
  assetType: AssetTypeSchema,
  provider: z.string(),
  providerAssetId: z.string(),
  sourceUrl: z.string().url(),
  pageUrl: z.string().url(),
  license: z.string().min(1),
  licenseVerified: z.boolean(),
  commercialUseAllowed: z.boolean(),
  attributionRequired: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  localPath: z.string().min(1),
  sha256: z.string().length(64),
  sceneNumber: z.number().int().positive(),
  shotIndex: z.number().int().nonnegative().default(0),
  probe: MediaProbeSchema,
  ranking: AssetRankingSchema,
  retrievedAt: isoDate,
  metadata: z.record(z.unknown()).default({}),
});
export type AssetDescriptor = z.infer<typeof AssetDescriptorSchema>;

// =============================================================================
// 6. RENDERING
// =============================================================================

export const VideoTemplateTypeSchema = z.enum([
  'DOCUMENTARY',
  'DATA_CHART',
  'TIMELINE',
  'MAP_GEOGRAPHIC',
  'TECHNOLOGY_PRODUCT',
]);
export type VideoTemplateType = z.infer<typeof VideoTemplateTypeSchema>;

export const RenderJobSchema = z.object({
  id: z.string().uuid(),
  scriptId: z.string().uuid(),
  templateType: VideoTemplateTypeSchema.default('DOCUMENTARY'),
  videoPath: z.string(),
  captionsPath: z.string(),
  /** Probed from the produced MP4. 0 for failed renders. */
  durationSeconds: z.number().nonnegative(),
  resolution: z.object({ width: z.literal(1080), height: z.literal(1920) }),
  fps: z.number().default(30),
  sha256: z.string().optional(),
  renderedAt: isoDate,
  status: z.enum(['COMPLETED', 'FAILED']),
  error: z.string().optional(),
});
export type RenderJob = z.infer<typeof RenderJobSchema>;

// =============================================================================
// 7. QA
// =============================================================================

export const QAStatusSchema = z.enum(['PASS', 'WARN', 'FAIL']);
export type QAStatus = z.infer<typeof QAStatusSchema>;

export const QACheckSchema = z.object({
  id: z.string(),
  category: z.string(),
  status: QAStatusSchema,
  /** A blocking WARN or any FAIL prevents publication. */
  blocking: z.boolean(),
  message: z.string(),
  measured: z.unknown().optional(),
  expected: z.unknown().optional(),
});
export type QACheck = z.infer<typeof QACheckSchema>;

export const QAReportSchema = z.object({
  kind: z.enum(['MEDIA', 'CONTENT']),
  checks: z.array(QACheckSchema).min(1),
  overallStatus: QAStatusSchema,
  publishEligible: z.boolean(),
  blockingReasons: z.array(z.string()),
});
export type QAReport = z.infer<typeof QAReportSchema>;

export const QAResultSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  renderId: z.string().uuid(),
  scriptId: z.string().uuid(),
  videoSha256: z.string().length(64),
  media: QAReportSchema,
  content: QAReportSchema,
  overallStatus: QAStatusSchema,
  publishEligible: z.boolean(),
  blockingReasons: z.array(z.string()),
  evaluatedAt: isoDate,
});
export type QAResult = z.infer<typeof QAResultSchema>;

// =============================================================================
// 8. APPROVALS
// =============================================================================

export const ApprovalEventSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  stage: ApprovalStageSchema,
  targetId: z.string().uuid(),
  decision: ApprovalDecisionSchema,
  /** 'human' for explicit reviewer decisions; 'policy:<name>' for configured automatic approvals. */
  decidedBy: z.string().min(1),
  directorNotes: z.string().optional(),
  decidedAt: isoDate,
});
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

// =============================================================================
// 9. PUBLISHING
// =============================================================================

export const PublishTargetSchema = z.enum(['youtube', 'local_export', 'mock']);
export type PublishTarget = z.infer<typeof PublishTargetSchema>;

export const PublishStatusSchema = z.enum(['PUBLISHING', 'PUBLISHED', 'FAILED']);
export type PublishStatus = z.infer<typeof PublishStatusSchema>;

export const YouTubeMetadataSchema = z.object({
  title: z.string().min(5).max(100).refine((t) => !/[<>]/.test(t), 'title must not contain < or >'),
  description: z.string().max(5000),
  tags: z.array(z.string().min(1).max(100)).refine((t) => t.join(',').length <= 500, 'tags exceed 500 characters'),
  privacyStatus: z.enum(['private', 'unlisted', 'public']),
});
export type YouTubeMetadata = z.infer<typeof YouTubeMetadataSchema>;

export const PublishJobSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  renderId: z.string().uuid(),
  target: PublishTargetSchema,
  status: PublishStatusSchema,
  videoSha256: z.string().length(64),
  externalId: z.string().optional(),
  url: z.string().optional(),
  metadata: YouTubeMetadataSchema,
  startedAt: isoDate,
  publishedAt: isoDate.optional(),
  error: z.string().optional(),
});
export type PublishJob = z.infer<typeof PublishJobSchema>;

// =============================================================================
// 10. JOBS
// =============================================================================

export const JobErrorKindSchema = z.enum([
  'CONFIGURATION',
  'AUTHENTICATION',
  'RATE_LIMIT',
  'TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'INVALID_RESPONSE',
  'VALIDATION',
  'QA_FAILED',
  'INTERNAL',
]);
export type JobErrorKind = z.infer<typeof JobErrorKindSchema>;

export const JobArtifactsSchema = z.object({
  topicId: z.string().uuid().optional(),
  scoreId: z.string().uuid().optional(),
  researchId: z.string().uuid().optional(),
  storyId: z.string().uuid().optional(),
  scriptId: z.string().uuid().optional(),
  narrationId: z.string().uuid().optional(),
  timelinePath: z.string().optional(),
  captionsPath: z.string().optional(),
  assetIds: z.array(z.string().uuid()).optional(),
  renderId: z.string().uuid().optional(),
  qaId: z.string().uuid().optional(),
  publishId: z.string().uuid().optional(),
});
export type JobArtifacts = z.infer<typeof JobArtifactsSchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  mode: PipelineModeSchema,
  state: JobStateSchema,
  /** State that was executing when the job failed; resume re-enters it. */
  failedStage: JobStateSchema.optional(),
  errorKind: JobErrorKindSchema.optional(),
  errorMessage: z.string().optional(),
  retryable: z.boolean().optional(),
  artifacts: JobArtifactsSchema,
  workDir: z.string(),
  attempts: z.number().int().nonnegative(),
  lockedBy: z.string().optional(),
  lockedAt: isoDate.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Job = z.infer<typeof JobSchema>;

// =============================================================================
// 11. ANALYTICS (not yet implemented against a real API)
// =============================================================================

export const AnalyticsRecordSchema = z.object({
  id: z.string().uuid(),
  youtubeVideoId: z.string(),
  jobId: z.string().uuid(),
  topicId: z.string().uuid(),
  pillar: ContentPillarSchema,
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  retentionRate: z.number().min(0).max(1),
  averageViewDurationSeconds: z.number().nonnegative(),
  recordedAt: isoDate,
});
export type AnalyticsRecord = z.infer<typeof AnalyticsRecordSchema>;
