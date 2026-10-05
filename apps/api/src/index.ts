import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { config, ShortsRepository, logger, ContentStateMachine } from '@shorts/core';
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
import { ApprovalEvent, PublishJob } from '@shorts/schemas';

const app = express();
app.use(cors());
app.use(express.json());

const repo = new ShortsRepository();
await repo.init();

const providers = ProviderFactory.createBundle(config.MOCK_LLM);
const discoveryAgent = new DiscoveryAgent(providers.llm, repo);
const scoringAgent = new ScoringAgent(providers.llm, repo);
const researchAgent = new ResearchAgent(providers.llm, providers.search, repo);
const storyAgent = new StoryEditorAgent(providers.llm, repo);
const scriptAgent = new ScriptwriterAgent(providers.llm, repo);
const visualAgent = new VisualDirectorAgent(providers.asset, repo);
const voiceAgent = new VoiceAgent(providers.tts, repo);
const renderer = new VideoRenderer(repo);
const qaAgent = new QAAgent(repo);
const analyticsAgent = new AnalyticsAgent(repo);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// GET /api/topics
app.get('/api/topics', async (req, res) => {
  try {
    const state = req.query.state as any;
    const topics = await repo.listTopics(state);
    res.json({ topics });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/topics/discover
app.post('/api/topics/discover', async (req, res) => {
  try {
    const { pillar, count } = req.body;
    const topics = await discoveryAgent.discoverTopics(pillar, count || 2);
    res.json({ topics });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/topics/:id/score
app.post('/api/topics/:id/score', async (req, res) => {
  try {
    const topic = await repo.getTopic(req.params.id);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });
    const score = await scoringAgent.scoreTopic(topic);
    res.json({ score });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/topics/:id/approve (Gate 1: Idea)
app.post('/api/topics/:id/approve', async (req, res) => {
  try {
    const topic = await repo.getTopic(req.params.id);
    if (!topic) return res.status(404).json({ error: 'Topic not found' });

    const approval: ApprovalEvent = {
      id: randomUUID(),
      stage: 'IDEA',
      targetId: topic.id,
      decision: req.body.decision || 'APPROVED',
      directorNotes: req.body.notes,
      decidedAt: new Date().toISOString(),
    };
    await repo.saveApproval(approval);

    // Trigger research & story & script automatically on approval
    const research = await researchAgent.conductResearch(topic);
    const story = await storyAgent.developStory(topic, research);
    const script = await scriptAgent.writeScript(story, research);

    res.json({ approval, script });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scripts/:id
app.get('/api/scripts/:id', async (req, res) => {
  try {
    const script = await repo.getScript(req.params.id);
    if (!script) return res.status(404).json({ error: 'Script not found' });
    res.json({ script });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scripts/:id/approve (Gate 2: Script)
app.post('/api/scripts/:id/approve', async (req, res) => {
  try {
    const script = await repo.getScript(req.params.id);
    if (!script) return res.status(404).json({ error: 'Script not found' });

    const approval: ApprovalEvent = {
      id: randomUUID(),
      stage: 'SCRIPT',
      targetId: script.id,
      decision: req.body.decision || 'APPROVED',
      directorNotes: req.body.notes,
      decidedAt: new Date().toISOString(),
    };
    await repo.saveApproval(approval);

    ContentStateMachine.transition('SCRIPT_REVIEW', 'SCRIPT_APPROVED', { scriptId: script.id });
    ContentStateMachine.transition('SCRIPT_APPROVED', 'ASSET_PREPARATION', { scriptId: script.id });
    await repo.updateTopicState(script.topicId, 'ASSET_PREPARATION');

    // Trigger asset acquisition, voice synthesis & rendering
    const assets = await visualAgent.planAndCollectAssets(script);
    const voice = await voiceAgent.generateVoiceover(script);
    const render = await renderer.renderShort(script, assets, voice);

    const research = await repo.getResearchPacket(script.topicId);
    let qa = null;
    if (research) {
      qa = await qaAgent.evaluateShort({ script, research, render, assets });
    }

    res.json({ approval, render, qa });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/render/:renderId/approve (Gate 3: Final Video)
app.post('/api/render/:renderId/approve', async (req, res) => {
  try {
    const approval: ApprovalEvent = {
      id: randomUUID(),
      stage: 'FINAL_VIDEO',
      targetId: req.params.renderId,
      decision: req.body.decision || 'APPROVED',
      directorNotes: req.body.notes,
      decidedAt: new Date().toISOString(),
    };
    await repo.saveApproval(approval);

    res.json({ approval, message: 'Video approved for staging/publishing.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics
app.get('/api/analytics', async (_req, res) => {
  try {
    // Generate sample analytics summary
    const summary = await analyticsAgent.analyzePerformance([]);
    res.json({ summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = config.PORT || 3000;
export const server = app.listen(PORT, () => {
  logger.info(`YouTube Shorts Production API server listening on http://localhost:${PORT}`, {
    stage: 'API',
    port: PORT,
  });
});
