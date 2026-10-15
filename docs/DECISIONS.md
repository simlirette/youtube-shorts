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

## ADR-006: Topic gate threshold is an editorial knob
The overall topic score is computed deterministically from LLM-rated dimensions. On 20 real topics the scores ranged 61.8–74.2; a threshold of 70 passed 15% of topics without separating good from weak ones, so the default is 65. This is a selectivity setting, not an objective quality line; quality is enforced downstream (verified research, fact review, QA, human approval).

## ADR-007: SQLite by default, Postgres-compatible SQL
Schema v2 stores artifacts as immutable JSON documents with indexed keys; upserts use `ON CONFLICT`. SQLite is the single-process mode. PostgreSQL is the multi-worker mode and is verified by `tests/postgres.test.ts` against a real server (CI service + local Docker): concurrent schema init, real transactions with rollback, CAS state updates, exclusive leases, storage-level uniqueness, and a full interrupted/resumed/published job.

## ADR-008: Source credibility is separate from claim support
`verificationStatus` says whether evidence supports a claim; the source tier (HIGH/ACCEPTABLE/QUESTIONABLE/REJECTED) says whether that evidence may be published. Deterministic domain rules decide first; only unknown domains get one batched LLM *publisher-category* classification, mapped to a tier by a fixed table that can never yield HIGH. REJECTED sources are excluded before extraction; QUESTIONABLE support requires human review; only HIGH/ACCEPTABLE sources are cited.

## ADR-009: Visual validation is layered by cost
Cheap deterministic checks (probe, decode, black detection, frame statistics for black/blank/green-screen/letterbox/static) run on every downloaded candidate; a low-detail vision call on a 3-frame contact sheet runs only for finalists (≤3 per shot). The stored result is the measured frame metrics plus the model's categorical verdict; no numeric confidence is fabricated. UNSURE never auto-publishes.

## ADR-010: Word budget derived from the voice
`SCRIPT_MAX_WORDS` defaults to 118 because the slowest measured ElevenLabs pace at speed 1.1 was ~2.0 words/s (measured 2.0–2.35 on six live narrations); config validation rejects a budget that cannot fit `SHORT_MAX_SECONDS` at `VOICE_MIN_WORDS_PER_SECOND`.

## ADR-011: Publication retries only when provably safe
Publishers classify failures with `uploadStarted`. Only `uploadStarted=false` failures can be retried (`publish --retry`), atomically clearing the failed record and re-arming the job; anything else needs manual reconciliation, because a retry could create a duplicate public video.

## ADR-012: Topics come from measured viewer questions, not model brainstorming
Research (Oct 2026, `research/2026-10-content-gap/`) showed generic fact Shorts are the most saturated cluster, while real search questions about planes, ships, trains and infrastructure have multi-million-view long-form answers and almost no Shorts. `GapDiscoveryAgent` takes YouTube autocomplete expansions, filters deterministically, triages with one batched model call (evergreen, factual, filmable, not sensitive), then measures each question against YouTube search: gap score = long-form demand × (1 − existing Shorts supply). Signals are free (public suggest endpoint + yt-dlp). Gap topics are scored from evidence, so no model score is needed; LLM discovery remains as a fallback.

## ADR-013: Rotated script formats
Question formats (`QUESTION_ANSWER`, `THREE_REASONS`) answer the viewer's question in the first seconds and are 55–95 words (≈35–45 % fewer voice credits than STORY). Formats rotate (least recently used, never three in a row) because YouTube demonetizes template-looking channels; analytics nudges the rotation by at most ±3 positions so variety is preserved.

## ADR-014: Spend gates in front of paid narration
Voice is the most expensive step and everything after it (footage, render, QA) can fail. Before voice: human script review (recommended policy), a stock-footage preflight (same search and ranking as sourcing; failing scenes are rewritten), and an ElevenLabs balance check. The TTS cache means resumes never re-bill.

## ADR-015: Analytics feeds back, conservatively
`analytics sync` stores per-video measurements (Analytics API owner metrics when OAuth is configured; public counters otherwise). `analyzePerformance` compares groups only with ≥3 Shorts older than 48 h and refuses to conclude from fewer than 6. Format weights are bounded; cluster and release-time changes are recommendations for a human, not automatic.
