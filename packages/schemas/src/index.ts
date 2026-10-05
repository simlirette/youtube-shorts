import { z } from 'zod';

// =============================================================================
// CONTENT PILLARS & WORKFLOW ENUMS
// =============================================================================

export const ContentPillarSchema = z.enum([
  'BUSINESS',
  'TECHNOLOGY',
  'ENGINEERING',
  'SCIENCE',
  'STRANGE_REAL_WORLD',
]);
export type ContentPillar = z.infer<typeof ContentPillarSchema>;

export const WorkflowStateSchema = z.enum([
  'DISCOVERED',
  'SCORED',
  'RESEARCHING',
  'RESEARCHED',
  'STORY_READY',
  'SCRIPTING',
  'SCRIPT_REVIEW',
  'SCRIPT_APPROVED',
  'ASSET_PREPARATION',
  'RENDERING',
  'RENDERED',
  'QA',
  'QA_PASSED',
  'QA_FAILED',
  'APPROVED',
  'UPLOADING',
  'PUBLISHED',
  'ANALYZING',
  'REJECTED',
]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const ApprovalStageSchema = z.enum(['IDEA', 'SCRIPT', 'FINAL_VIDEO']);
export type ApprovalStage = z.infer<typeof ApprovalStageSchema>;

export const ApprovalDecisionSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'REVISIONS_REQUESTED',
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// =============================================================================
// 1. TOPIC DISCOVERY & SCORING
// =============================================================================

export const TopicCandidateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(5),
  premise: z.string().min(10),
  pillar: ContentPillarSchema,
  sourceUrls: z.array(z.string().url()).min(1),
  discoveredAt: z.string().datetime(),
  tags: z.array(z.string()).default([]),
  state: WorkflowStateSchema.default('DISCOVERED'),
  similarityHash: z.string().optional(),
});
export type TopicCandidate = z.infer<typeof TopicCandidateSchema>;

export const TopicScoreSchema = z.object({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  overallScore: z.number().min(0).max(100),
  curiosity: z.number().min(0).max(10),
  audiencePotential: z.number().min(0).max(10),
  originality: z.number().min(0).max(10),
  storyDepth: z.number().min(0).max(10),
  visualPotential: z.number().min(0).max(10),
  sourceAvailability: z.number().min(0).max(10),
  freshness: z.number().min(0).max(10),
  productionComplexity: z.number().min(0).max(10), // Lower is easier or balanced
  copyrightRisk: z.number().min(0).max(10), // 0 = safe, 10 = extreme risk
  repetitionRisk: z.number().min(0).max(10), // 0 = fresh, 10 = duplicate
  monetizationRisk: z.number().min(0).max(10), // 0 = safe, 10 = dangerous
  reasoning: z.string(),
  passGate: z.boolean(),
  scoredAt: z.string().datetime(),
});
export type TopicScore = z.infer<typeof TopicScoreSchema>;

// =============================================================================
// 2. RESEARCH, CLAIMS & PROVENANCE
// =============================================================================

export const CredibilityTierSchema = z.enum([
  'PRIMARY_SOURCE',
  'AUTHORITATIVE_SECONDARY',
  'PEER_REVIEWED',
  'REPUTABLE_JOURNALISM',
  'PUBLIC_DATASET',
]);
export type CredibilityTier = z.infer<typeof CredibilityTierSchema>;

export const SourceReferenceSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  title: z.string(),
  publisher: z.string(),
  publishDate: z.string().optional(),
  credibilityTier: CredibilityTierSchema,
  retrievedAt: z.string().datetime(),
  archiveUrl: z.string().url().optional(),
});
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const ClaimSchema = z.object({
  id: z.string().uuid(),
  text: z.string(),
  entity: z.string(),
  sourceId: z.string().uuid(),
  sourceCitation: z.string(),
  confidence: z.number().min(0).max(1), // 1.0 = absolute certainty
  isKeyFact: z.boolean().default(true),
  verified: z.boolean().default(true),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ResearchPacketSchema = z.object({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  title: z.string(),
  summary: z.string(),
  keyEntities: z.array(z.string()),
  claims: z.array(ClaimSchema).min(2),
  sources: z.array(SourceReferenceSchema).min(1),
  uncertaintyNotes: z.array(z.string()).default([]),
  researchedAt: z.string().datetime(),
});
export type ResearchPacket = z.infer<typeof ResearchPacketSchema>;

// =============================================================================
// 3. STORY ARCHITECTURE & MACHINE-READABLE SCRIPT
// =============================================================================

export const StoryOutlineSchema = z.object({
  id: z.string().uuid(),
  topicId: z.string().uuid(),
  logline: z.string(),
  centralConflict: z.string(),
  hookConcept: z.string(),
  narrativeArc: z.object({
    hook: z.string(), // 0-2s
    context: z.string(), // 2-8s
    development: z.string(), // 8-30s
    twist: z.string(), // 30-45s
    payoff: z.string(), // 45-60s
  }),
  targetDurationSeconds: z.number().min(30).max(60).default(45),
  createdAt: z.string().datetime(),
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
  startTime: z.number().min(0),
  endTime: z.number().min(0),
  durationSeconds: z.number().positive(),
  narration: z.string().min(1),
  visualObjective: z.string(),
  mediaFormat: MediaFormatSchema,
  assetKeywords: z.array(z.string()),
  visualPrompt: z.string().optional(),
  textOverlay: z.string().optional(),
  transitionIntent: z.enum(['CUT', 'FADE', 'ZOOM_IN', 'PAN_LEFT', 'PAN_RIGHT']).default('CUT'),
  claimIds: z.array(z.string().uuid()).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ShortScriptSchema = z.object({
  id: z.string().uuid(),
  storyId: z.string().uuid(),
  topicId: z.string().uuid(),
  title: z.string(),
  hookText: z.string().min(5),
  targetDurationSeconds: z.number().min(30).max(60),
  scenes: z.array(SceneSchema).min(3),
  totalWords: z.number().positive(),
  estimatedDurationSeconds: z.number().positive(),
  createdAt: z.string().datetime(),
});
export type ShortScript = z.infer<typeof ShortScriptSchema>;

// =============================================================================
// 4. ASSETS & VOICE SYNTHESIS
// =============================================================================

export const AssetTypeSchema = z.enum(['IMAGE', 'VIDEO', 'AUDIO_VOICE', 'AUDIO_MUSIC', 'GRAPHIC']);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const AssetDescriptorSchema = z.object({
  id: z.string().uuid(),
  assetType: AssetTypeSchema,
  sourceUrl: z.string(),
  provider: z.string(), // 'pexels' | 'unsplash' | 'replicate' | 'local_synthetic' | etc.
  license: z.string(), // 'Pexels License', 'CC-BY-4.0', 'Public Domain', 'Internal Synth'
  commercialUseAllowed: z.boolean(),
  attributionRequired: z.boolean(),
  retrievedAt: z.string().datetime(),
  localPath: z.string(),
  storageKey: z.string().optional(),
  sceneNumber: z.number().int().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type AssetDescriptor = z.infer<typeof AssetDescriptorSchema>;

export const WordTimestampSchema = z.object({
  word: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
});
export type WordTimestamp = z.infer<typeof WordTimestampSchema>;

export const VoiceNarrationSchema = z.object({
  id: z.string().uuid(),
  scriptId: z.string().uuid(),
  provider: z.string(), // 'elevenlabs' | 'openai' | 'mock_tts'
  voiceId: z.string(),
  audioPath: z.string(),
  durationSeconds: z.number().positive(),
  wordTimestamps: z.array(WordTimestampSchema),
  synthesizedAt: z.string().datetime(),
});
export type VoiceNarration = z.infer<typeof VoiceNarrationSchema>;

// =============================================================================
// 5. RENDERING CONTRACTS
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
  durationSeconds: z.number().positive(),
  resolution: z.object({
    width: z.literal(1080),
    height: z.literal(1920),
  }),
  fps: z.number().default(30),
  renderedAt: z.string().datetime(),
  status: z.enum(['PENDING', 'RENDERING', 'COMPLETED', 'FAILED']),
  error: z.string().optional(),
});
export type RenderJob = z.infer<typeof RenderJobSchema>;

// =============================================================================
// 6. QA ASSESSMENT
// =============================================================================

export const QAStatusSchema = z.enum(['PASS', 'WARN', 'FAIL']);
export type QAStatus = z.infer<typeof QAStatusSchema>;

export const QACheckItemSchema = z.object({
  status: QAStatusSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type QACheckItem = z.infer<typeof QACheckItemSchema>;

export const QAResultSchema = z.object({
  id: z.string().uuid(),
  renderId: z.string().uuid(),
  scriptId: z.string().uuid(),
  overallStatus: QAStatusSchema,
  factualQA: QACheckItemSchema,
  storyQA: QACheckItemSchema,
  visualQA: QACheckItemSchema,
  audioQA: QACheckItemSchema,
  copyrightQA: QACheckItemSchema,
  repetitionQA: QACheckItemSchema,
  policyQA: QACheckItemSchema,
  evaluatedAt: z.string().datetime(),
  recommendation: z.string(),
});
export type QAResult = z.infer<typeof QAResultSchema>;

// =============================================================================
// 7. HUMAN APPROVAL
// =============================================================================

export const ApprovalEventSchema = z.object({
  id: z.string().uuid(),
  stage: ApprovalStageSchema,
  targetId: z.string().uuid(), // topicId | scriptId | renderId
  decision: ApprovalDecisionSchema,
  directorNotes: z.string().optional(),
  decidedAt: z.string().datetime(),
});
export type ApprovalEvent = z.infer<typeof ApprovalEventSchema>;

// =============================================================================
// 8. PUBLISHING & YOUTUBE INTEGRATION
// =============================================================================

export const PublishStatusSchema = z.enum([
  'PENDING',
  'SCHEDULED',
  'UPLOADING',
  'UPLOADED',
  'FAILED',
]);
export type PublishStatus = z.infer<typeof PublishStatusSchema>;

export const PublishJobSchema = z.object({
  id: z.string().uuid(),
  renderId: z.string().uuid(),
  platform: z.literal('YOUTUBE'),
  youtubeVideoId: z.string().optional(),
  privacyStatus: z.enum(['private', 'unlisted', 'public']).default('private'),
  title: z.string().min(5).max(100),
  description: z.string(),
  tags: z.array(z.string()),
  status: PublishStatusSchema,
  scheduledTime: z.string().datetime().optional(),
  publishedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});
export type PublishJob = z.infer<typeof PublishJobSchema>;

// =============================================================================
// 9. ANALYTICS & LEARNING
// =============================================================================

export const AnalyticsRecordSchema = z.object({
  id: z.string().uuid(),
  youtubeVideoId: z.string(),
  renderId: z.string().uuid(),
  topicId: z.string().uuid(),
  pillar: ContentPillarSchema,
  templateType: VideoTemplateTypeSchema,
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  shares: z.number().int().nonnegative(),
  subscribersGained: z.number().int().nonnegative(),
  retentionRate: z.number().min(0).max(1), // Average percentage viewed (0.0 to 1.0)
  averageViewDurationSeconds: z.number().nonnegative(),
  recordedAt: z.string().datetime(),
});
export type AnalyticsRecord = z.infer<typeof AnalyticsRecordSchema>;
