# YouTube Shorts Production Engine

An automated, faceless YouTube Shorts media-production engine designed to produce original, factually verified, high-retention documentary-style Shorts (30–60 seconds) at scale.

Built with **TypeScript**, **Node.js**, and **FFmpeg**, following strict architectural principles of asset provenance, factual source verification, provider agnosticism, and human-in-the-loop review.

---

## Content Pillars & Direction

The engine focuses on **Short Documentary Stories**:
1. **Business** (e.g., market inflection points, counterintuitive failures)
2. **Technology** (e.g., forgotten tech wars, unexpected breakthroughs)
3. **Engineering** (e.g., megastructure adaptations, critical edge-cases)
4. **Science** (e.g., serendipitous discoveries, extreme experiments)
5. **Strange / Unusual Real-World Stories** (e.g., eccentric events, bizarre historical outcomes)

---

## System Lifecycle

```text
DISCOVER ──> SCORE ──> RESEARCH ──> STORY ──> SCRIPT
                                                  │
                                                  ▼
PUBLISH <── APPROVED <── QA <── RENDER <── VISUAL & VOICE
   │
   ▼
ANALYTICS ──> LEARN ──> (Future Scoring & Topic Selection)
```

1. **Discovery & Scoring**: Ingests signals and scores ideas based on curiosity, originality, visual depth, and YouTube monetization policy safety.
2. **Fact-Checked Research**: Gathers credible primary sources; extracts claims with confidence scores (`Claim -> Source -> Confidence`).
3. **Narrative Architecture**: Distinct story editor shapes the hook, conflict, and payoff before script generation.
4. **Structured Scripting**: Validated scene-by-scene script with timestamps, visual directions, and text overlay requirements.
5. **Visuals & Voice**: Provider-agnostic asset retrieval/generation (licensed stock, diagrams, charts, motion graphics) and TTS pacing.
6. **Deterministic Video Rendering**: Native FFmpeg engine composing 1080×1920 (9:16) H.264 video with synchronized dynamic captions.
7. **Comprehensive QA**: Checks factual claims, audio levels, subtitle clipping, license compliance, and repetition against previous channel content.
8. **Human Review Gates**: Director approval checkpoints for Idea, Script, and Final Render.
9. **YouTube Integration**: Official YouTube API v3 integration with automated Private/Unlisted staging.
10. **Analytics & Feedback**: Performance tracking to inform future topic scoring.

---

## Quick Start

### 1. Requirements
- Node.js >= 20 (v24+ recommended)
- `pnpm` >= 9
- `ffmpeg` installed and available in system PATH

### 2. Setup
```bash
# Clone the repository
git clone https://github.com/simlirette/youtube-shorts.git
cd youtube-shorts

# Install workspace dependencies
pnpm install

# Copy environment template
cp .env.example .env

# Run automated tests
pnpm test

# Run a complete end-to-end dry run (mock mode)
pnpm run pipeline:mock
```

---

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md)
- [Setup & Prerequisites](docs/SETUP.md)
- [Environment Variables](docs/ENVIRONMENT.md)
- [API Reference](docs/API.md)
- [Workflow & State Machine](docs/WORKFLOW.md)
- [Architectural Decisions Log (ADR)](docs/DECISIONS.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Gemini Durable Instructions](GEMINI.md)

---

## License

Private / Proprietary. All rights reserved.
