# Architectural Decisions

## ADR-001: pnpm monorepo with TypeScript project references
Packages (`schemas`, `core`, `providers`, `agents`, `rendering`, `pipeline`) plus `apps/cli`, `apps/api`. Composite project references make `pnpm typecheck`/`build` a single `tsc -b`. Runtime executes TypeScript via `tsx`.

## ADR-002: Explicit mock vs live mode, no fallback
Mock providers exist for offline tests and produce real media (FFmpeg-generated video with an audio track, WAV narration with consistent alignment). Live mode builds only real providers; a missing credential is a `ConfigurationError`. Mock runs use a separate database and output tree so mock topics can never be produced or published by a live job.

## ADR-003: Native FFmpeg rendering with a single word-timestamp timeline
Scene boundaries, shots, caption cues and total length are derived from ElevenLabs character alignment. Narration is mapped explicitly (`-map`), stock audio is dropped (`-an`), and audio is padded to the timeline length instead of truncating with `-shortest`. Captions are ASS in the 1080×1920 coordinate system with explicit line breaks.

## ADR-004: Verification is evidence-based
A claim is VERIFIED only when (1) its quote is found in a retrieved source text (re-attributed to the source that actually contains it), (2) every number in the claim appears in the quote, and (3) an LLM entailment check returns SUPPORTED. Scripts may only reference verified claims; numbers in narration must appear in the scene's referenced claims; an LLM review blocks material unsupported facts.

## ADR-005: QA inspects the artifact and fails closed
Media QA measures the produced MP4 (ffprobe, decode, silence, loudness, envelope correlation with the narration, black/frozen detection, caption pixels). WARN checks carry an explicit `blocking` flag. Publication requires a publish-eligible QA result for the exact file (sha256), an approval for that render, and no prior publication.

## ADR-006: Calibrated topic gate
The overall topic score is computed deterministically from LLM-rated dimensions. On 20 real topics the scores ranged 61.8–74.2; a threshold of 70 passed 15% of topics without separating good from weak ones, so the default is 65. Quality is enforced downstream (verified research, fact review, QA, human approval).

## ADR-007: SQLite by default, Postgres-compatible SQL
Schema v2 stores artifacts as immutable JSON documents with indexed keys; upserts use `ON CONFLICT`. Postgres compatibility is by construction and not yet verified against a server.
