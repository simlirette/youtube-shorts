import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ShortsRepository, ContentStateMachine, getDatabase } from '@shorts/core';
import { ProviderFactory } from '@shorts/providers';
import {
  DiscoveryAgent,
  ScoringAgent,
  ResearchAgent,
  StoryEditorAgent,
  ScriptwriterAgent,
  VisualDirectorAgent,
  VoiceAgent,
  QAAgent,
  AnalyticsAgent,
} from '@shorts/agents';
import { VideoRenderer } from '@shorts/rendering';

describe('End-to-End Production Pipeline (Mock Execution)', () => {
  let repo: ShortsRepository;
  const providers = ProviderFactory.createBundle(true); // forceMock = true

  beforeAll(async () => {
    // Use an isolated in-memory database for testing
    const memDb = getDatabase(true);
    repo = new ShortsRepository(memDb);
    await repo.init();
  });

  it('runs complete lifecycle from Discovery to Render to QA and Publish', async () => {
    // 1. DISCOVERY & DEDUPLICATION
    const discoveryAgent = new DiscoveryAgent(providers.llm, repo);
    const topics = await discoveryAgent.discoverTopics('ENGINEERING', 1);
    expect(topics.length).toBe(1);
    const topic = topics[0];
    expect(topic.state).toBe('DISCOVERED');
    expect(topic.title).toBeDefined();

    // Verify deduplication rejects same topic
    const dupCheck = await discoveryAgent.discoverTopics('ENGINEERING', 1);
    expect(dupCheck.length).toBe(0); // Duplicate topic rejected

    // 2. SCORING
    const scoringAgent = new ScoringAgent(providers.llm, repo);
    const score = await scoringAgent.scoreTopic(topic);
    expect(score.overallScore).toBeGreaterThanOrEqual(70);
    expect(score.passGate).toBe(true);
    expect(topic.state).toBe('SCORED');

    // 3. HUMAN REVIEW GATE 1: IDEA
    await repo.saveApproval({
      id: randomUUID(),
      stage: 'IDEA',
      targetId: topic.id,
      decision: 'APPROVED',
      decidedAt: new Date().toISOString(),
    });

    // 4. RESEARCH
    const researchAgent = new ResearchAgent(providers.llm, providers.search, repo);
    const research = await researchAgent.conductResearch(topic);
    expect(research.claims.length).toBeGreaterThanOrEqual(2);
    expect(research.sources.length).toBeGreaterThanOrEqual(1);
    expect(topic.state).toBe('RESEARCHED');

    // 5. STORY EDITOR
    const storyAgent = new StoryEditorAgent(providers.llm, repo);
    const story = await storyAgent.developStory(topic, research);
    expect(story.logline).toBeDefined();
    expect(story.narrativeArc.hook).toBeDefined();
    expect(topic.state).toBe('STORY_READY');

    // 6. SCRIPTWRITER
    const scriptAgent = new ScriptwriterAgent(providers.llm, repo);
    const script = await scriptAgent.writeScript(story, research);
    expect(script.scenes.length).toBeGreaterThanOrEqual(3);
    expect(script.totalWords).toBeGreaterThan(0);
    expect((await repo.getTopic(topic.id))?.state).toBe('SCRIPT_REVIEW');

    // 7. HUMAN REVIEW GATE 2: SCRIPT
    await repo.saveApproval({
      id: randomUUID(),
      stage: 'SCRIPT',
      targetId: script.id,
      decision: 'APPROVED',
      decidedAt: new Date().toISOString(),
    });
    ContentStateMachine.transition('SCRIPT_REVIEW', 'SCRIPT_APPROVED', { scriptId: script.id });
    ContentStateMachine.transition('SCRIPT_APPROVED', 'ASSET_PREPARATION', { scriptId: script.id });
    await repo.updateTopicState(topic.id, 'ASSET_PREPARATION');

    // 8. ASSETS & VOICE
    const visualAgent = new VisualDirectorAgent(providers.asset, repo);
    const assets = await visualAgent.planAndCollectAssets(script);
    expect(assets.length).toBe(script.scenes.length);

    const voiceAgent = new VoiceAgent(providers.tts, repo);
    const voice = await voiceAgent.generateVoiceover(script);
    expect(fs.existsSync(voice.audioPath)).toBe(true);
    expect(voice.durationSeconds).toBeGreaterThan(0);

    // 9. VIDEO RENDERING (FFMPEG)
    const renderer = new VideoRenderer(repo);
    const render = await renderer.renderShort(script, assets, voice, {
      templateType: 'DOCUMENTARY',
      enableSubtitles: false, // Fast headless test
    });
    expect(fs.existsSync(render.videoPath)).toBe(true);
    expect(render.resolution.width).toBe(1080);
    expect(render.resolution.height).toBe(1920);
    expect(render.status).toBe('COMPLETED');
    expect((await repo.getTopic(topic.id))?.state).toBe('QA');

    // 10. QA AGENT
    const qaAgent = new QAAgent(repo);
    const qaResult = await qaAgent.evaluateShort({
      script,
      research,
      render,
      assets,
    });
    expect(qaResult.overallStatus).toBe('PASS');
    expect(qaResult.factualQA.status).toBe('PASS');
    expect(qaResult.storyQA.status).toBe('PASS');
    expect(qaResult.visualQA.status).toBe('PASS');
    expect(qaResult.copyrightQA.status).toBe('PASS');

    // 11. PUBLISHING & YOUTUBE INTEGRATION
    ContentStateMachine.transition('QA_PASSED', 'APPROVED');
    ContentStateMachine.transition('APPROVED', 'UPLOADING');
    const upload = await providers.youtube.uploadVideo({
      videoPath: render.videoPath,
      title: script.title,
      description: script.hookText,
      tags: ['shorts', 'engineering'],
      privacyStatus: 'private',
    });
    expect(upload.youtubeVideoId).toBeDefined();
    expect(upload.watchUrl).toContain('youtube.com/shorts/');

    // 12. ANALYTICS & LEARNING
    const analyticsMetrics = await providers.youtube.getVideoAnalytics(upload.youtubeVideoId);
    expect(analyticsMetrics.views).toBeGreaterThan(0);

    const analyticsAgent = new AnalyticsAgent(repo);
    const analyticsReport = await analyticsAgent.analyzePerformance([
      {
        id: randomUUID(),
        youtubeVideoId: upload.youtubeVideoId,
        renderId: render.id,
        topicId: topic.id,
        pillar: topic.pillar,
        templateType: render.templateType,
        views: analyticsMetrics.views || 0,
        likes: analyticsMetrics.likes || 0,
        comments: analyticsMetrics.comments || 0,
        shares: analyticsMetrics.shares || 0,
        subscribersGained: analyticsMetrics.subscribersGained || 0,
        retentionRate: analyticsMetrics.retentionRate || 0,
        averageViewDurationSeconds: analyticsMetrics.averageViewDurationSeconds || 0,
        recordedAt: new Date().toISOString(),
      },
    ]);
    expect(analyticsReport.recommendations.length).toBeGreaterThan(0);

    // Clean up rendered test video
    if (fs.existsSync(render.videoPath)) {
      fs.unlinkSync(render.videoPath);
    }
  });
});
