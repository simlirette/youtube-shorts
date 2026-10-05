# GEMINI.md — Durable Project Instructions & Operating Principles

## 1. Project Overview & Mission
- **Project**: Automated faceless YouTube Shorts media-production engine (`youtube-shorts`).
- **Objective**: Produce original, factually verified, high-retention documentary-style Shorts (30–60s) at scale without generic "AI spam" tropes.
- **Roles**: The user is the **DIRECTOR** (owns creative, business, and strategic decisions). The agent is the **ENGINEER** (owns technical implementation, execution, tests, and documentation).
- **Default Behavior**: EXECUTE. Do not ask for permission on ordinary engineering decisions. Make reasonable technical choices, document them, and proceed.

## 2. Core Architecture & Pipeline
The engine follows a strictly phased, traceable lifecycle:
1. **DISCOVER**: Ingests signals/sources, outputs candidate topics with deduplication.
2. **SCORE**: Evaluates topics on curiosity, originality, visual potential, factual depth, and policy safety.
3. **RESEARCH**: Collects primary/credible sources, extracts factual claims (`Claim -> Source -> Confidence`). Hallucination is strictly prohibited.
4. **STORY**: Distills research into a narrative arc (Hook -> Context -> Development -> Twist -> Payoff).
5. **SCRIPT**: Produces machine-readable scenes with precise timestamps, narration, visual intent, and text overlays.
6. **VISUAL & VOICE**: Selects visual media types (licensed, chart, motion graphic, public domain, generated) and synthesizes voice pacing via TTS provider abstraction.
7. **RENDER**: Deterministic FFmpeg engine outputting 9:16 (1080x1920) H.264/AAC MP4 with synced captions.
8. **QA**: Multi-stage automated verification (Factual, Story, Visual, Audio, Provenance, Repetition, Policy).
9. **HUMAN APPROVAL**: Explicit review gates for Idea, Script, and Final Video.
10. **PUBLISH**: Official YouTube API integration (initial upload: Private/Unlisted).
11. **ANALYTICS & LEARN**: Ingests performance metrics to optimize future topic scoring.

## 3. Engineering Rules & Coding Standards
- **Language & Runtime**: Node.js 24+ with TypeScript, strict type safety, ES Modules.
- **Schemas**: Runtime validation using Zod for all pipeline payloads (TopicCandidate, ResearchPacket, Claim, Story, Script, Scene, Asset, QAResult, etc.).
- **Provider Agnostic**: All external APIs (LLM, TTS, Search, Asset, Storage, YouTube) must sit behind abstract interfaces (`packages/providers`). Every interface must have a working mock implementation for zero-credential local development.
- **Traceability**: Every output must trace back through `VIDEO -> SCRIPT -> STORY -> RESEARCH -> CLAIMS -> SOURCES` and `VIDEO -> SCENES -> ASSETS -> LICENSES`.
- **Media Safety**: FFmpeg commands must be safely executed via parameterized arguments (no raw shell injection). Verify file existence, MIME types, and durations before rendering.
- **Database**: PostgreSQL (Prisma or Drizzle ORM) with local SQLite fallback for testing.

## 4. Operational Commands
- `pnpm install`: Install workspace dependencies
- `pnpm build`: Typecheck and compile all packages
- `pnpm test`: Run test suite across all packages
- `pnpm dev`: Start local development services
- `pnpm run pipeline:mock`: Run an end-to-end dry run pipeline generating a sample Short

## 5. Do's and Don'ts
- **DO NOT** hardcode API keys or credentials.
- **DO NOT** claim a feature is complete without verifiable unit/integration tests.
- **DO NOT** produce repetitive or generic "AI slideshow / Reddit story" content.
- **DO NOT** commit media files, outputs, or `.env`.
