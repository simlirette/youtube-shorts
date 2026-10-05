import {
  TopicCandidate,
  TopicScore,
  ResearchPacket,
  StoryOutline,
  ShortScript,
  AssetDescriptor,
  VoiceNarration,
  RenderJob,
  QAResult,
  ApprovalEvent,
  PublishJob,
  AnalyticsRecord,
  WorkflowState,
} from '@shorts/schemas';
import { IDatabase, getDatabase } from './db.js';

export class ShortsRepository {
  private db: IDatabase;

  constructor(db?: IDatabase) {
    this.db = db || getDatabase();
  }

  async init(): Promise<void> {
    await this.db.initSchema();
  }

  // TOPICS
  async saveTopic(topic: TopicCandidate): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO topics (id, title, premise, pillar, source_urls, tags, state, similarity_hash, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        topic.id,
        topic.title,
        topic.premise,
        topic.pillar,
        JSON.stringify(topic.sourceUrls),
        JSON.stringify(topic.tags),
        topic.state,
        topic.similarityHash || null,
        topic.discoveredAt,
      ]
    );
  }

  async getTopic(id: string): Promise<TopicCandidate | null> {
    const rows = await this.db.query<any>(`SELECT * FROM topics WHERE id = ?`, [id]);
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      title: r.title,
      premise: r.premise,
      pillar: r.pillar,
      sourceUrls: JSON.parse(r.source_urls),
      tags: JSON.parse(r.tags),
      state: r.state,
      similarityHash: r.similarity_hash || undefined,
      discoveredAt: r.discovered_at,
    };
  }

  async listTopics(state?: WorkflowState): Promise<TopicCandidate[]> {
    const sql = state ? `SELECT * FROM topics WHERE state = ?` : `SELECT * FROM topics`;
    const params = state ? [state] : [];
    const rows = await this.db.query<any>(sql, params);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      premise: r.premise,
      pillar: r.pillar,
      sourceUrls: JSON.parse(r.source_urls),
      tags: JSON.parse(r.tags),
      state: r.state,
      similarityHash: r.similarity_hash || undefined,
      discoveredAt: r.discovered_at,
    }));
  }

  async updateTopicState(id: string, state: WorkflowState): Promise<void> {
    await this.db.execute(`UPDATE topics SET state = ? WHERE id = ?`, [state, id]);
  }

  // SCORES
  async saveTopicScore(score: TopicScore): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO topic_scores (id, topic_id, overall_score, curiosity, audience_potential, originality, story_depth, visual_potential, source_availability, freshness, production_complexity, copyright_risk, repetition_risk, monetization_risk, reasoning, pass_gate, scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        score.id,
        score.topicId,
        score.overallScore,
        score.curiosity,
        score.audiencePotential,
        score.originality,
        score.storyDepth,
        score.visualPotential,
        score.sourceAvailability,
        score.freshness,
        score.productionComplexity,
        score.copyrightRisk,
        score.repetitionRisk,
        score.monetizationRisk,
        score.reasoning,
        score.passGate ? 1 : 0,
        score.scoredAt,
      ]
    );
  }

  // RESEARCH
  async saveResearchPacket(packet: ResearchPacket): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO research_packets (id, topic_id, title, summary, key_entities, uncertainty_notes, researched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        packet.id,
        packet.topicId,
        packet.title,
        packet.summary,
        JSON.stringify(packet.keyEntities),
        JSON.stringify(packet.uncertaintyNotes),
        packet.researchedAt,
      ]
    );

    for (const source of packet.sources) {
      await this.db.execute(
        `INSERT OR REPLACE INTO source_references (id, research_id, url, title, publisher, publish_date, credibility_tier, retrieved_at, archive_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          source.id,
          packet.id,
          source.url,
          source.title,
          source.publisher,
          source.publishDate || null,
          source.credibilityTier,
          source.retrievedAt,
          source.archiveUrl || null,
        ]
      );
    }

    for (const claim of packet.claims) {
      await this.db.execute(
        `INSERT OR REPLACE INTO claims (id, research_id, source_id, text, entity, source_citation, confidence, is_key_fact, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          claim.id,
          packet.id,
          claim.sourceId,
          claim.text,
          claim.entity,
          claim.sourceCitation,
          claim.confidence,
          claim.isKeyFact ? 1 : 0,
          claim.verified ? 1 : 0,
        ]
      );
    }
  }

  async getResearchPacket(topicId: string): Promise<ResearchPacket | null> {
    const rows = await this.db.query<any>(`SELECT * FROM research_packets WHERE topic_id = ?`, [topicId]);
    if (!rows || rows.length === 0) return null;
    const r = rows[0];

    const sourceRows = await this.db.query<any>(`SELECT * FROM source_references WHERE research_id = ?`, [r.id]);
    const sources = sourceRows.map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
      publisher: s.publisher,
      publishDate: s.publish_date || undefined,
      credibilityTier: s.credibility_tier,
      retrievedAt: s.retrieved_at,
      archiveUrl: s.archive_url || undefined,
    }));

    const claimRows = await this.db.query<any>(`SELECT * FROM claims WHERE research_id = ?`, [r.id]);
    const claims = claimRows.map((c) => ({
      id: c.id,
      text: c.text,
      entity: c.entity,
      sourceId: c.source_id,
      sourceCitation: c.source_citation,
      confidence: c.confidence,
      isKeyFact: Boolean(c.is_key_fact),
      verified: Boolean(c.verified),
    }));

    return {
      id: r.id,
      topicId: r.topic_id,
      title: r.title,
      summary: r.summary,
      keyEntities: JSON.parse(r.key_entities),
      uncertaintyNotes: JSON.parse(r.uncertainty_notes),
      researchedAt: r.researched_at,
      sources,
      claims,
    };
  }

  // STORIES
  async saveStory(story: StoryOutline): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO stories (id, topic_id, logline, central_conflict, hook_concept, narrative_arc, target_duration_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        story.id,
        story.topicId,
        story.logline,
        story.centralConflict,
        story.hookConcept,
        JSON.stringify(story.narrativeArc),
        story.targetDurationSeconds,
        story.createdAt,
      ]
    );
  }

  // SCRIPTS & SCENES
  async saveScript(script: ShortScript): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO scripts (id, story_id, topic_id, title, hook_text, target_duration_seconds, total_words, estimated_duration_seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        script.id,
        script.storyId,
        script.topicId,
        script.title,
        script.hookText,
        script.targetDurationSeconds,
        script.totalWords,
        script.estimatedDurationSeconds,
        script.createdAt,
      ]
    );

    for (const scene of script.scenes) {
      const sceneId = `${script.id}_scene_${scene.sceneNumber}`;
      await this.db.execute(
        `INSERT OR REPLACE INTO scenes (id, script_id, scene_number, start_time, end_time, duration_seconds, narration, visual_objective, media_format, asset_keywords, visual_prompt, text_overlay, transition_intent, claim_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sceneId,
          script.id,
          scene.sceneNumber,
          scene.startTime,
          scene.endTime,
          scene.durationSeconds,
          scene.narration,
          scene.visualObjective,
          scene.mediaFormat,
          JSON.stringify(scene.assetKeywords),
          scene.visualPrompt || null,
          scene.textOverlay || null,
          scene.transitionIntent,
          JSON.stringify(scene.claimIds),
        ]
      );
    }
  }

  async getScript(id: string): Promise<ShortScript | null> {
    const rows = await this.db.query<any>(`SELECT * FROM scripts WHERE id = ?`, [id]);
    if (!rows || rows.length === 0) return null;
    const r = rows[0];

    const sceneRows = await this.db.query<any>(
      `SELECT * FROM scenes WHERE script_id = ? ORDER BY scene_number ASC`,
      [id]
    );
    const scenes = sceneRows.map((s) => ({
      sceneNumber: s.scene_number,
      startTime: s.start_time,
      endTime: s.end_time,
      durationSeconds: s.duration_seconds,
      narration: s.narration,
      visualObjective: s.visual_objective,
      mediaFormat: s.media_format,
      assetKeywords: JSON.parse(s.asset_keywords),
      visualPrompt: s.visual_prompt || undefined,
      textOverlay: s.text_overlay || undefined,
      transitionIntent: s.transition_intent,
      claimIds: JSON.parse(s.claim_ids),
    }));

    return {
      id: r.id,
      storyId: r.story_id,
      topicId: r.topic_id,
      title: r.title,
      hookText: r.hook_text,
      targetDurationSeconds: r.target_duration_seconds,
      totalWords: r.total_words,
      estimatedDurationSeconds: r.estimated_duration_seconds,
      scenes,
      createdAt: r.created_at,
    };
  }

  // ASSETS
  async saveAsset(asset: AssetDescriptor): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO assets (id, asset_type, source_url, provider, license, commercial_use_allowed, attribution_required, retrieved_at, local_path, storage_key, scene_number, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        asset.id,
        asset.assetType,
        asset.sourceUrl,
        asset.provider,
        asset.license,
        asset.commercialUseAllowed ? 1 : 0,
        asset.attributionRequired ? 1 : 0,
        asset.retrievedAt,
        asset.localPath,
        asset.storageKey || null,
        asset.sceneNumber || null,
        JSON.stringify(asset.metadata),
      ]
    );
  }

  // VOICE
  async saveVoiceNarration(narration: VoiceNarration): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO voice_narrations (id, script_id, provider, voice_id, audio_path, duration_seconds, word_timestamps, synthesized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        narration.id,
        narration.scriptId,
        narration.provider,
        narration.voiceId,
        narration.audioPath,
        narration.durationSeconds,
        JSON.stringify(narration.wordTimestamps),
        narration.synthesizedAt,
      ]
    );
  }

  // RENDERS
  async saveRender(render: RenderJob): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO renders (id, script_id, template_type, video_path, duration_seconds, width, height, fps, status, error, rendered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        render.id,
        render.scriptId,
        render.templateType,
        render.videoPath,
        render.durationSeconds,
        render.resolution.width,
        render.resolution.height,
        render.fps,
        render.status,
        render.error || null,
        render.renderedAt,
      ]
    );
  }

  // QA
  async saveQAResult(qa: QAResult): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO qa_results (id, render_id, script_id, overall_status, factual_qa, story_qa, visual_qa, audio_qa, copyright_qa, repetition_qa, policy_qa, recommendation, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        qa.id,
        qa.renderId,
        qa.scriptId,
        qa.overallStatus,
        JSON.stringify(qa.factualQA),
        JSON.stringify(qa.storyQA),
        JSON.stringify(qa.visualQA),
        JSON.stringify(qa.audioQA),
        JSON.stringify(qa.copyrightQA),
        JSON.stringify(qa.repetitionQA),
        JSON.stringify(qa.policyQA),
        qa.recommendation,
        qa.evaluatedAt,
      ]
    );
  }

  // APPROVALS
  async saveApproval(approval: ApprovalEvent): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO approval_events (id, stage, target_id, decision, director_notes, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        approval.id,
        approval.stage,
        approval.targetId,
        approval.decision,
        approval.directorNotes || null,
        approval.decidedAt,
      ]
    );
  }

  // PUBLISHES
  async savePublishJob(publish: PublishJob): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO publishes (id, render_id, platform, youtube_video_id, privacy_status, title, description, tags, status, scheduled_time, published_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publish.id,
        publish.renderId,
        publish.platform,
        publish.youtubeVideoId || null,
        publish.privacyStatus,
        publish.title,
        publish.description,
        JSON.stringify(publish.tags),
        publish.status,
        publish.scheduledTime || null,
        publish.publishedAt || null,
        publish.error || null,
      ]
    );
  }

  // ANALYTICS
  async saveAnalytics(analytics: AnalyticsRecord): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO analytics (id, youtube_video_id, render_id, topic_id, pillar, template_type, views, likes, comments, shares, subscribers_gained, retention_rate, average_view_duration_seconds, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        analytics.id,
        analytics.youtubeVideoId,
        analytics.renderId,
        analytics.topicId,
        analytics.pillar,
        analytics.templateType,
        analytics.views,
        analytics.likes,
        analytics.comments,
        analytics.shares,
        analytics.subscribersGained,
        analytics.retentionRate,
        analytics.averageViewDurationSeconds,
        analytics.recordedAt,
      ]
    );
  }
}
