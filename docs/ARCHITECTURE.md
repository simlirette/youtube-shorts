# Architecture

```text
apps/cli, apps/api            entry points (explicit mock|live mode; API is token-authenticated, localhost-bound)
        │
packages/pipeline             PipelineRunner: job lifecycle, stages, resume, approvals, publish gate, reports
        │
packages/agents               stage logic (provider-agnostic, no persistence):
  discovery · scoring · research (+verification) · story · script (+validation) · voice ·
  media ranking/selection/validation · narration review · content QA
packages/rendering            timeline (from word timestamps) · ASS captions · FFmpeg renderer · media QA
packages/providers            interfaces + implementations; factory builds an all-mock or all-live bundle
  real: OpenAI, Gemini, Tavily, web retriever, ElevenLabs, Pixabay, Pexels, YouTube, local export
  mock: deterministic LLM/search/TTS/stock (real media files) for offline tests
packages/core                 config · typed errors · HTTP policy · ffmpeg/ffprobe toolkit · text utils ·
                              job state machine · provenance · DB (SQLite / Postgres SQL) · repository
packages/schemas              Zod contracts for every artifact and the job
```

## Principles

- **Validated boundaries.** LLM output → JSON parse → Zod schema → semantic validator; violations are fed back (with the previous response) for a bounded number of attempts, then a `ValidationError`. Nothing is defaulted.
- **Deterministic tooling for objective facts.** Word counts, numbers, quote location, durations, codecs, loudness, silence, caption geometry and hashes are computed in code / with FFmpeg — never asked of an LLM.
- **Fail closed.** Every provider call has a timeout, bounded retries for transient errors only (401/403/4xx never retried; 429 honours Retry-After), and typed errors. Live mode never substitutes a mock.
- **One timeline.** Scenes, shots, caption cues and total length all derive from the narration's real word timestamps.
- **Idempotent stages.** Each stage checks for its persisted artifact before doing work; TTS, search responses and validated media are cached content-addressed, so resumes do not re-bill or re-download.

## Persistence

`database/schema.sql` (v2): `topics`, `topic_scores`, `jobs` (+ lock columns), `job_events`, `artifacts` (immutable JSON documents per kind), `approvals`, `publishes` (unique per job and per video+target), `provider_runs` (cost/reliability ledger). SQLite by default; SQL is written to be Postgres-compatible (`ON CONFLICT … DO UPDATE`) but Postgres has not been exercised against a live server.

## Files per job

```text
output/jobs/<jobId>/
  research/ topic.json research.json sources/<sourceId>.txt
  script/   story.json script.json
  audio/    raw.mp3 narration.wav narration.json
  captions/ timeline.json
  media/    scene_<n>_<shot>_<asset>.mp4 (hard links into output/cache/media) assets.json
  render/   short.mp4 video_uncaptioned.mp4 captions.ass fonts/
  qa/       qa.json
  final/    short.mp4 (copy of the QA-ed render)
  error.json (on failure)
output/cache/{search,media,tts}/   shared caches
output/exports/<jobId>/            local-export publication (short.mp4 + metadata.json)
output/mock/…                      everything for mock mode (separate DB too)
```
