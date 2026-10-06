# YouTube Shorts Production Engine

Produces fact-checked, documentary-style YouTube Shorts (30–60 s, 1080×1920) from topic discovery to a QA-validated MP4, with explicit human/policy gates before anything is published.

Built with TypeScript (pnpm workspaces), FFmpeg/ffprobe, SQLite (Postgres-compatible SQL), and real providers: OpenAI (LLM), Tavily (research), ElevenLabs (voice), Pixabay (stock media).

## What a job does

```text
SELECTING_TOPIC   discover (exact-N with explicit shortfall, fuzzy dedupe) → deterministic score gate
  → [IDEA gate]
RESEARCHING       search → full-text sources → LLM claim extraction → verbatim quote location,
                  numeric consistency, LLM entailment → only VERIFIED claims continue
SCRIPTING         story → script (5 scenes, 100–130 words, hook ≤7 words, claim refs, numbers checked,
                  fact review) with corrective retries; fails closed
  → [SCRIPT gate]
SYNTHESIZING_VOICE ElevenLabs with character timestamps → two-pass loudnorm WAV → probe/silence/
                  loudness validation (cached, never re-billed on resume)
BUILDING_TIMELINE single timeline from real word timestamps: scenes, ≤6 s shots, caption cues
SOURCING_MEDIA    Pixabay search (24 h cache) → rank (relevance, orientation, resolution, duration,
                  no production assets) → LLM visual-fit judge → download → ffprobe + full decode +
                  black-frame check → keyword refinement / shot merge on shortage
RENDERING         per-shot clips (-an, exact frames, landscape blurred-fill) → concat → ASS captions +
                  narration with explicit -map, padded to the timeline (no -shortest)
QA                objective media QA on the real MP4 + content QA; WARNs can be blocking
  → [FINAL gate]  manual, or auto_after_qa
READY_TO_PUBLISH → PUBLISHING → PUBLISHED   publish gate re-verifies everything incl. file sha256
```

Any failure moves the job to `FAILED` with a classified error (`AUTHENTICATION`, `RATE_LIMIT`, `TIMEOUT`, `VALIDATION`, `QA_FAILED`, …) and `output/jobs/<id>/error.json`. `shorts resume <id>` re-enters the failed stage; finished stages are not repeated.

## Quick start

Requirements: Node ≥ 22.5 (uses `node:sqlite`), pnpm ≥ 9, FFmpeg + ffprobe on PATH.

```bash
pnpm install
cp .env.example .env          # add keys for live mode
pnpm typecheck && pnpm build && pnpm test

pnpm cli doctor --mode live   # config, tools, font, credentials (no paid calls)
pnpm cli run --mode mock      # full local run with mock providers (isolated DB/output)
pnpm cli run --mode live      # real providers; stops at manual gates by default
pnpm cli jobs --mode live
pnpm cli job <id> --mode live                 # JSON report: QA checks, costs, events
pnpm cli approve <id> FINAL_VIDEO --mode live # after watching output/jobs/<id>/final/short.mp4
pnpm cli publish <id> --mode live             # local export by default
pnpm cli resume <id> --mode live [--from STAGE]
pnpm cli schedule --mode live --max-per-day 1 # unattended loop (respects approval policy)

pnpm test:live                # real-provider acceptance (costs money)
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [Workflow & states](docs/WORKFLOW.md) · [CLI & API](docs/API.md)
- [Setup](docs/SETUP.md) · [Environment](docs/ENVIRONMENT.md) · [Development](docs/DEVELOPMENT.md) · [Decisions](docs/DECISIONS.md)
- [External audit](AUDIT_REPORT.md) · [Completion report](COMPLETION_REPORT.md)

## License

Private / proprietary. Caption font Anton is licensed under the SIL Open Font License (`assets/fonts/OFL.txt`).
