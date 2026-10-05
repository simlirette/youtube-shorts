# System Architecture

## Overview

The YouTube Shorts Production Engine is a modular, event-driven media synthesis pipeline designed around deterministic execution, strict data contracts, and provider agnosticism.

```
┌─────────────────────────────────────────────────────────────┐
│                       apps/cli & apps/api                   │
│               (Execution Runners & Approval UI/API)         │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
               ▼                               ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│      packages/agents        │ │     packages/rendering      │
│  - Discovery Agent          │ │  - FFmpeg Pipeline Engine   │
│  - Scoring Agent            │ │  - Template Registry        │
│  - Research Agent           │ │  - Subtitle/Captions Engine │
│  - Story Editor Agent       │ │  - Audio Mixer & Pacing     │
│  - Scriptwriter Agent       │ └──────────────┬──────────────┘
│  - Visual Director Agent    │                │
│  - QA Agent                 │                │
│  - Analytics Agent          │                │
└──────────────┬──────────────┘                │
               │                               │
               ▼                               ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│     packages/providers      │ │      packages/schemas       │
│  - LLMProvider (Mock/OpenAI)│ │  - Zod Runtime Contracts    │
│  - TTSProvider (Mock/11Labs)│ │  - TypeScript Typings       │
│  - SearchProvider (Mock/Tav)│ └─────────────────────────────┘
│  - AssetProvider (Mock/Pex) │                ▲
│  - YouTubeProvider (API v3) │                │
└──────────────┬──────────────┘                │
               │                               │
               ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│                      packages/core                          │
│  - State Machine & Workflow Lifecycle                       │
│  - Database / Persistence (PostgreSQL & SQLite Fallback)    │
│  - Logging, Metrics, Asset Provenance Tracker               │
└─────────────────────────────────────────────────────────────┘
```

## Layer Responsibilities

### 1. `packages/schemas`
- Pure Zod schemas and derived TypeScript types.
- Zero dependencies on external APIs or database layers.
- Defines data contracts for:
  - `TopicCandidate` & `TopicScore`
  - `ResearchPacket`, `Claim`, and `SourceReference`
  - `StoryOutline` and narrative structure
  - `ShortScript` and `Scene`
  - `VisualPlan` and `AssetDescriptor`
  - `QAResult` (Factual, Story, Visual, Audio, Copyright, Repetition, Policy)
  - `RenderJob` and video output specifications
  - `ApprovalEvent` and review status
  - `PublishJob` and YouTube metadata

### 2. `packages/core`
- Workflow Engine & State Machine: Manages content transitions (`DISCOVERED` -> `SCORED` -> `RESEARCHED` -> `STORY_READY` -> `SCRIPT_APPROVED` -> `RENDERED` -> `QA_PASSED` -> `PUBLISHED`).
- Database Layer: Entity models and repository abstractions supporting PostgreSQL (via Drizzle ORM) with local SQLite fallback for fast local testing.
- Provenance Registry: Enforces that every claim points to a verifiable source, and every asset records licensing terms and usage rights.
- Logging & Observability: Structured JSON logging with trace IDs and estimated cost tracking per pipeline stage.

### 3. `packages/providers`
- Abstract interfaces for external dependencies:
  - `LLMProvider`: Prompt execution, JSON generation, and embeddings.
  - `SearchProvider`: Web queries, news search, reference ingestion.
  - `TTSProvider`: Speech synthesis with timestamps / word boundaries.
  - `AssetProvider`: Stock image, video, and diagram search.
  - `StorageProvider`: Local filesystem or S3-compatible object storage.
  - `YouTubeProvider`: Official YouTube Data API v3 integration for video upload and analytics.
- Mock implementations of all providers for local, zero-credential testing.

### 4. `packages/agents`
- Discrete agent modules with focused single responsibilities:
  - `DiscoveryAgent`: Ingests sources, detects duplicates, proposes topics.
  - `ScoringAgent`: Multi-dimensional topic scoring with explainable weights.
  - `ResearchAgent`: Deep claim extraction and cross-verification.
  - `StoryEditorAgent`: Narrative arc structure (Hook, Conflict, Payoff).
  - `ScriptwriterAgent`: Formats 30–60s machine-readable scene scripts.
  - `VisualDirectorAgent`: Determines optimal media format per scene.
  - `QAAgent`: Multi-criteria automated quality assessment.
  - `AnalyticsAgent`: Evaluates post-publish performance metrics.

### 5. `packages/rendering`
- Deterministic media rendering via FFmpeg.
- Subtitle generation conforming to mobile vertical safe areas.
- Audio ducking (background music + voice narration).
- Scene templates (Documentary, Product/Tech, Data/Chart, Timeline, Map).

### 6. `apps/cli` & `apps/api`
- CLI tooling for executing individual stages or end-to-end runs.
- Lightweight REST API for approvals and dashboard visualization.
