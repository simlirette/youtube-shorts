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

/**
 * Measured demand/supply evidence for a viewer question (gap discovery). Every number is observed
 * from YouTube (autocomplete rank, search results); nothing is estimated by a model.
 */
export const GapEvidenceSchema = z.object({
  /** The question as viewers type it into YouTube search. */
  question: z.string().min(5),
  seed: z.string(),
  cluster: z.string(),
  /** Position in the autocomplete list for the prefix that surfaced it (0 = first). */
  suggestRank: z.number().int().nonnegative(),
  /** Most-viewed long-form answer in the top search results (proven demand). */
  longformTopViews: z.number().int().nonnegative(),
  /** Shorts (<= 65 s) among the top results, and how many of them have >= 10k views (supply). */
  shortsInResults: z.number().int().nonnegative(),
  shortsAbove10k: z.number().int().nonnegative(),
  bestShortViews: z.number().int().nonnegative(),
  /** 0-100, deterministic: high demand and missing Shorts supply score high. */
  score: z.number().min(0).max(100),
  measuredAt: isoDate,
});
export type GapEvidence = z.infer<typeof GapEvidenceSchema>;

/** Script structures. Rotated so a channel does not look template-made (YouTube "inauthentic content"). */
export const ShortFormatSchema = z.enum(['MICRO_EXPLAINER', 'STORY', 'QUESTION_ANSWER', 'THREE_REASONS']);
export type ShortFormat = z.infer<typeof ShortFormatSchema>;

/**
 * How the first spoken sentence opens: a concrete claim ("statement"), an action already happening
 * ("scene"), or the viewer's question ("question", kept for controlled experiments).
 */
export const HookTypeSchema = z.enum(['statement', 'scene', 'question']);
export type HookType = z.infer<typeof HookTypeSchema>;

/** Target length band: standard 30-45 s, short 25-35 s (experimental). */
export const DurationBandSchema = z.enum(['standard', 'short']);
export type DurationBand = z.infer<typeof DurationBandSchema>;

export const CaptionStyleSchema = z.enum(['plain', 'highlight']);
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

/**
 * Every production choice for one Short, frozen when the job is created so that a retry or resume
 * can never change what was tested. `experimentId`/`arm` are set only for controlled experiments.
 */
export const ProductionVariantSchema = z.object({
  experimentId: z.string().nullable(),
  /** Factor varied by the experiment, and this job's value for it. */
  factor: z.string().nullable(),
  arm: z.string().nullable(),
  /** How the arm was chosen (auditable), e.g. "round-robin #7 of hook-test-1". */
  assignment: z.string(),
  hookType: HookTypeSchema,
  /** Fixed format, or "auto" for rotation among SHORT_FORMATS. */
  format: z.union([ShortFormatSchema, z.literal('auto')]),
  durationBand: DurationBandSchema,
  captionStyle: CaptionStyleSchema,
  titleCard: z.boolean(),
  music: z.boolean(),
  voiceId: z.string(),
  voiceSpeed: z.number().min(0.7).max(1.2),
  cta: z.boolean(),
  assignedAt: isoDate,
});
export type ProductionVariant = z.infer<typeof ProductionVariantSchema>;

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
  /** Present for topics found by gap discovery (a real viewer question with measured demand). */
  gap: GapEvidenceSchema.optional(),
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

/**
 * Publication suitability of a source, independent of whether it supports a claim.
 * HIGH/ACCEPTABLE may be cited; QUESTIONABLE requires human review; REJECTED is never used.
 */
export const SourceCredibilitySchema = z.enum(['HIGH', 'ACCEPTABLE', 'QUESTIONABLE', 'REJECTED']);
export type SourceCredibility = z.infer<typeof SourceCredibilitySchema>;

export const SourceCategorySchema = z.enum([
  'government',
  'intergovernmental',
  'academic',
  'scientific_organization',
  'museum_archive',
  'established_news',
  'reference',
  'specialist_publication',
  'commercial',
  'blog_personal',
  'advocacy',
  'religious_advocacy',
  'user_generated',
  'content_farm',
  'unknown',
]);
export type SourceCategory = z.infer<typeof SourceCategorySchema>;

export const SourceAssessmentSchema = z.object({
  tier: SourceCredibilitySchema,
  category: SourceCategorySchema,
  /** 'rule' = curated domain policy; 'assessed' = LLM category judgment mapped by fixed policy. */
  method: z.enum(['rule', 'assessed']),
  conflictOfInterest: z.boolean().default(false),
  reason: z.string(),
});
export type SourceAssessment = z.infer<typeof SourceAssessmentSchema>;

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
  /** Missing on legacy artifacts; treated as QUESTIONABLE (fail safe). */
  credibility: SourceAssessmentSchema.optional(),
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
  targetDurationSeconds: z.number().min(15).max(60).default(45),
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

/**
 * A clause-level visual beat: an exact contiguous slice of the scene narration with the literal
 * thing that must be on screen while it is spoken.
 */
/**
 * A locally rendered motion graphic (Blender) for a clause stock footage cannot show: a number, a
 * comparison, a short process, or a key term. Its text may only repeat the narration (validated).
 */
export const GraphicSpecSchema = z.discriminatedUnion('template', [
  z.object({ template: z.literal('stat'), value: z.string().min(1).max(14), label: z.string().max(40).default('') }),
  z.object({
    template: z.literal('compare'),
    items: z
      .array(z.object({ label: z.string().min(1).max(18), value: z.number().positive(), display: z.string().min(1).max(12) }))
      .min(2)
      .max(3),
  }),
  z.object({ template: z.literal('process'), steps: z.array(z.string().min(1).max(24)).min(2).max(4) }),
  z.object({ template: z.literal('keyword'), text: z.string().min(1).max(28) }),
]);
export type GraphicSpec = z.infer<typeof GraphicSpecSchema>;

export const VisualBeatSchema = z.object({
  text: z.string().min(1),
  visualIntent: z.string().default(''),
  visualSubject: z.string().min(2),
  assetKeywords: z.array(z.string().min(2)).min(1),
  visualExclusions: z.array(z.string()).default([]),
  /** Present when this beat is shown as a generated graphic instead of stock footage. */
  graphic: GraphicSpecSchema.optional(),
});
export type VisualBeat = z.infer<typeof VisualBeatSchema>;

export const SceneSchema = z.object({
  sceneNumber: z.number().int().positive(),
  narration: z.string().min(1),
  visualObjective: z.string().min(1),
  mediaFormat: MediaFormatSchema.default('LICENSED_STOCK'),
  /** Generic, stock-searchable visual terms (no names or dates). */
  assetKeywords: z.array(z.string().min(2)).min(1),
  /** The concrete thing the viewer must see (used for semantic media checks). */
  visualSubject: z.string().default(''),
  /** Things that must not appear (e.g. "celebration", "cartoon"). */
  visualExclusions: z.array(z.string()).default([]),
  visualPrompt: z.string().optional(),
  textOverlay: z.string().optional(),
  transitionIntent: z.enum(['CUT', 'FADE', 'ZOOM_IN', 'PAN_LEFT', 'PAN_RIGHT']).default('CUT'),
  /** Verified claim IDs asserted by this scene. Never back-filled. */
  claimIds: z.array(z.string().uuid()).default([]),
  /** Clause-level beats (empty on legacy scripts: the scene is then one visual unit). */
  beats: z.array(VisualBeatSchema).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ShortScriptSchema = z.object({
  id: z.string().uuid(),
  storyId: z.string().uuid(),
  topicId: z.string().uuid(),
  title: z.string().min(5).max(100),
  description: z.string().max(5000).default(''),
  hookText: z.string().min(5),
  format: ShortFormatSchema.default('STORY'),
  hookType: HookTypeSchema.optional(),
  /** On-screen topic shown during the opening (2-6 words); absent when not generated. */
  titleCard: z.string().max(60).optional(),
  targetDurationSeconds: z.number().min(15).max(60),
  scenes: z.array(SceneSchema).min(3),
  totalWords: z.number().int().positive(),
  generationAttempts: z.number().int().positive().default(1),
  createdAt: isoDate,
});
export type ShortScript = z.infer<typeof ShortScriptSchema>;

/** Editorial scores (0-5) from the script editor, which is separate from the writer. */
export const EditorialScoresSchema = z.object({
  hook: z.number().min(0).max(5),
  specificity: z.number().min(0).max(5),
  causalFlow: z.number().min(0).max(5),
  payoff: z.number().min(0).max(5),
});
export type EditorialScores = z.infer<typeof EditorialScoresSchema>;

export const ScriptReviewSchema = z.object({
  id: z.string().uuid(),
  scriptId: z.string().uuid(),
  /** 0 = first draft; n = n-th revision requested by the editor. */
  revision: z.number().int().nonnegative(),
  scores: EditorialScoresSchema,
  total: z.number().min(0).max(20),
  passed: z.boolean(),
  /** Specific, actionable notes (empty when passed). */
  notes: z.array(z.string()),
  thresholds: z.object({ minTotal: z.number(), minHook: z.number(), minPayoff: z.number() }),
  model: z.string(),
  reviewedAt: isoDate,
});
export type ScriptReview = z.infer<typeof ScriptReviewSchema>;

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
  /** Gap tightening applied after synthesis (timestamps above are already realigned). */
  processing: z
    .object({
      leadingTrimmedSeconds: z.number().nonnegative(),
      gapsTightened: z.number().int().nonnegative(),
      secondsRemoved: z.number().nonnegative(),
      maxGapAfterSeconds: z.number().nonnegative(),
      measuredWordsPerSecond: z.number().nonnegative(),
    })
    .optional(),
  /** Speed requested from the provider for this narration (variant), when supported. */
  speed: z.number().optional(),
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
  /** Beat (within the scene) this shot illustrates; absent for legacy scene-level shots. */
  beatIndex: z.number().int().nonnegative().optional(),
  /** Narration words covered by the shot (absent on legacy timelines). */
  firstWordIndex: z.number().int().nonnegative().optional(),
  lastWordIndex: z.number().int().nonnegative().optional(),
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
  /** Frame-level and semantic validation. Missing on legacy artifacts (content QA fails them). */
  visualValidation: z
    .object({
      frames: z.array(
        z.object({
          t: z.number(),
          meanLuma: z.number(),
          stdLuma: z.number(),
          greenFraction: z.number(),
          barFraction: z.number(),
        })
      ),
      defects: z.array(z.string()),
      semantic: z
        .object({
          verdict: z.enum(['ACCEPT', 'REJECT', 'UNSURE']),
          showsSubject: z.boolean(),
          issues: z.array(z.string()),
          reason: z.string(),
          model: z.string(),
        })
        .nullable(),
      decision: z.enum(['ACCEPTED', 'NEEDS_REVIEW']),
    })
    .optional(),
  /**
   * How the asset fills the 9:16 frame, decided deterministically from its dimensions and decoded
   * frames. Centers are horizontal positions (0-1) of the crop window at the start/end of the shot.
   */
  framing: z
    .object({
      mode: z.enum(['cover', 'crop_pan', 'letterbox']),
      centerStart: z.number().min(0).max(1),
      centerEnd: z.number().min(0).max(1),
      /** Scale factor from source pixels to output pixels (> 1 = upscaling). */
      upscale: z.number().positive(),
      reason: z.string(),
    })
    .optional(),
  /** Set for assets generated locally (no third-party content); their text is re-verified by content QA. */
  generated: z.object({ tool: z.literal('blender'), version: z.string(), spec: GraphicSpecSchema, beatText: z.string() }).optional(),
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
  /** Background music actually mixed (null = none; reason recorded). */
  music: z
    .object({
      trackId: z.string(),
      title: z.string(),
      source: z.string(),
      licence: z.string(),
      bedLu: z.number(),
      /** Applied gain and the track's measured loudness (the bed's level is set by this recipe). */
      gainDb: z.number().optional(),
      trackLufs: z.number().optional(),
    })
    .nullable()
    .optional(),
  musicDisabledReason: z.string().optional(),
  titleCard: z.string().nullable().optional(),
  captionStyle: CaptionStyleSchema.optional(),
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
  /** Not a defect, but automatic approval is not allowed: a human must review. */
  reviewRequired: z.boolean().default(false),
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
  requiresHumanReview: z.boolean().default(false),
  reviewReasons: z.array(z.string()).default([]),
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
  /** Eligible but must not be approved by policy: a human has to look (questionable source, uncertain visuals). */
  requiresHumanReview: z.boolean().default(false),
  reviewReasons: z.array(z.string()).default([]),
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
  categoryId: z.string().regex(/^\d+$/).default('27'),
  /** Altered/synthetic content disclosure (status.containsSyntheticMedia). */
  containsSyntheticMedia: z.boolean().default(true),
  defaultLanguage: z.string().default('en'),
  /** Scheduled public release; only honoured for private uploads from an audited API project. */
  publishAt: isoDate.optional(),
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
  /** Whether bytes may have reached the target. Unknown is treated as true (no automatic retry). */
  uploadAttempted: z.boolean().default(true),
  /** Scheduled public release (YouTube `publishAt`), when the upload was scheduled. */
  scheduledFor: isoDate.optional(),
});
export type PublishJob = z.infer<typeof PublishJobSchema>;

// =============================================================================
// 10. JOBS
// =============================================================================

export const JobErrorKindSchema = z.enum([
  'CONFIGURATION',
  'AUTHENTICATION',
  'RATE_LIMIT',
  'QUOTA_EXCEEDED',
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
  /** Stock clips a reviewer rejected for this job ("provider:id"); never selected again. */
  excludedMediaKeys: z.array(z.string()).optional(),
  /** Production choices frozen at job creation (see ProductionVariantSchema). */
  variant: ProductionVariantSchema.optional(),
  /** Latest script-editor review for the current script. */
  scriptReviewId: z.string().uuid().optional(),
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
// 11. ANALYTICS
// =============================================================================

/**
 * One measurement of a published Short. `source` says where the numbers came from: the YouTube
 * Analytics API (owner metrics incl. engaged views and retention) or public counters only.
 */
export const VideoMetricsSchema = z.object({
  id: z.string().uuid(),
  publishId: z.string().uuid(),
  jobId: z.string().uuid(),
  youtubeVideoId: z.string().min(1),
  source: z.enum(['analytics_api', 'data_api', 'public']),
  capturedAt: isoDate,
  /** Hours between publication and capture (normalizes views for age). */
  ageHours: z.number().nonnegative(),
  views: z.number().int().nonnegative(),
  engagedViews: z.number().int().nonnegative().optional(),
  likes: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
  subscribersGained: z.number().int().optional(),
  averageViewDurationSeconds: z.number().nonnegative().optional(),
  averageViewPercentage: z.number().nonnegative().optional(),
});
export type VideoMetrics = z.infer<typeof VideoMetricsSchema>;

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

// =============================================================================
// 3D MECHANISM VIDEOS (Blender kits driven by narration timestamps)
// =============================================================================

export const MECHANISM_KITS = ['crank_piston', 'four_stroke'] as const;
export type MechanismKit = (typeof MECHANISM_KITS)[number];

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const MechanismBeatSchema = z.object({
  /** Narration for this beat. Beats are spoken in order and joined with a space. */
  text: z.string().min(3),
  /** Crank angle in degrees at the start and end of the beat (the kit's driving motion). */
  crank: z.tuple([z.number(), z.number()]).optional(),
  /** Piecewise-linear crank angle within the beat (at = fraction of the beat). Overrides `crank`; use it to land an event, such as the spark, on a spoken word. */
  crankPath: z.array(z.object({ at: z.number().min(0).max(1), deg: z.number() })).min(2).optional(),
  /** Camera: look-at point, distance from it, and the viewing direction (default: front, slightly right and above). */
  camera: z.object({ look: Vec3Schema, distance: z.number().positive(), dir: Vec3Schema.optional() }),
  /** Short heading shown at the top while the beat plays (e.g. "1 · INTAKE"). */
  hud: z.string().max(40).optional(),
  /** Callouts that point at named kit parts; from/to are fractions (0-1) of the beat. */
  labels: z.array(z.object({ text: z.string().min(1).max(24), part: z.string().min(1), from: z.number().min(0).max(1).default(0), to: z.number().min(0).max(1).default(1) })).default([]),
});
export type MechanismBeat = z.infer<typeof MechanismBeatSchema>;

export const MechanismVideoSpecSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(3),
  kit: z.enum(MECHANISM_KITS),
  /** Voice speed override (ElevenLabs 0.7-1.2); defaults to the configured speed. */
  speed: z.number().min(0.7).max(1.2).optional(),
  beats: z.array(MechanismBeatSchema).min(1),
});
export type MechanismVideoSpec = z.infer<typeof MechanismVideoSpecSchema>;
