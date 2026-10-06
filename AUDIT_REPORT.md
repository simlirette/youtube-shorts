# External Audit — YouTube Shorts Automation System

**Repository:** `C:\Users\simon\youtube-shorts` (branch `main`, HEAD `59b59f6` + large uncommitted working tree)
**Audit date:** 2026-10-05
**Auditor stance:** external, adversarial. No production code was modified. All claims below are tagged **VERIFIED** (executed/inspected directly), **INFERRED** (strong conclusion from code, not executed), or **UNKNOWN / NOT VERIFIED**.

Evidence produced during the audit (harness code, real-provider outputs, renders, frame sheets) is in `output/audit_evidence/` (gitignored). File references below use `path:line`.

---

# Executive Summary

**Would I trust this system to run unattended in production today? — NO.**

The system cannot currently start, and if the startup defect is patched, the pipeline it would run produces Shorts that are silent or truncated, have clipped captions, and carry fabricated "verified" provenance. It would still pass its own QA and get marked publishable.

Top-line facts, all **VERIFIED by execution**:

1. **Nothing starts.** `packages/providers/src/real/pixabay-asset.ts` is a **0-byte file**, but `factory.ts:20` imports `PixabayAssetProvider` from it. Every entry point (`shorts --help`, the API server, `pnpm pipeline:mock`) dies at module load with `SyntaxError: The requested module './real/pixabay-asset.js' does not provide an export named 'PixabayAssetProvider'`. `pnpm typecheck` and `pnpm build` both fail. The test suite exits non-zero because `tests/pixabay.test.ts` is also 0 bytes. The Pixabay live-test script and the validation script are 0 bytes too, so the "active" stock-media provider has **no source code at all**.
2. **Narration can be silently dropped.** The final FFmpeg mux has no `-map` (`renderer.ts:192-203`). When a stock clip has its own audio track (one of the cached Pixabay clips does: AAC stereo), FFmpeg picks that stereo track over the mono narration. My render with real ElevenLabs narration came out **100% silent** (silencedetect: 0 → 15.03 s). The previous developer's own `output/artifacts/pixabay_validation/pixabay_short_render.mp4` is **also completely silent**, and its video (19.1 s) is longer than its audio (10.0 s).
3. **Narration is truncated, and visuals and captions drift.** Scene timing comes from an assumed 2.6 words/s with a 3 s floor, not from the real TTS duration. With real gpt-4o + ElevenLabs output, the video was 15.0 s and the voice was 16.81 s. `-shortest` cut the final words ("…against unseen forces."), and scene cuts and captions drifted by up to **1.81 s**.
4. **Captions are clipped off the top of the frame** on every frame I sampled. `MarginV=260` is applied to an SRT, which libass renders in a 288-line coordinate space, so the captions get pushed to the top edge. A correct ASS generator (`PlayResY: 1920`) exists in `captions.ts:55` but is never used.
5. **QA passes broken output.** Given the real script plus the silent, 15 s, caption-clipped render, `QAAgent` returned **WARN**, which is mapped to state `QA_PASSED`. It reported "All scene claims verified against authoritative research sources" and "rendered video output exists". QA never opens the video or audio.
6. **"Verified" facts are not verified.** Claims are hard-coded `verified: true` with confidence `0.95`, and missing evidence is replaced by the claim's own text. Every scene without a claim is assigned claim #0. Sources are attached by array index, and one of three claims in the real run was **misattributed** (its quote exists only on Wikipedia but is credited to practical.engineering).
7. **There is no real automation path.** `shorts pipeline` forces mock providers (`--mock` defaults to `true` and there is no `--no-mock`), auto-approves all three "human" gates, and uploads regardless of score or QA result. There is no scheduler, queue, resume, or idempotency key.

What does work (**VERIFIED**): OpenAI gpt-4o JSON generation, Tavily search, web retrieval, ElevenLabs TTS with word timestamps and loudness normalization (≈ −15.6 LUFS), the Pixabay credential (raw API; the system code is gone), and 1080×1920 / 30 fps / H.264 / AAC container output.

Measured real cost for the LLM part of one (too-short) Short: **$0.034** on gpt-4o. The estimated all-in variable cost for a properly sized Short is **≈ $0.17–0.27**, dominated by ElevenLabs.

---

# System Architecture

## Repository map (reconstructed from code, not docs)

| Package | Real responsibility | State |
|---|---|---|
| `packages/schemas` | Zod contracts (Topic, Score, Research, Story, Script, Asset, Voice, Render, QA, Approval, Publish, Analytics) | Works; some constraints too weak (see F-07, F-10) |
| `packages/core` | `config.ts` (dotenv + zod), `logger.ts` (string logger plus an in-memory cost counter), `state-machine.ts` (a **stateless** transition validator), `provenance.ts`, `database/db.ts` (node:sqlite or pg), `repository.ts` (raw SQL) | SQLite works; Postgres path broken (F-17) |
| `packages/providers` | Interfaces, factory, mocks, real adapters: OpenAI, Gemini, Tavily, ElevenLabs, Pexels, **Pixabay (0 bytes)**, YouTube (upload only, analytics stub), `SourceContentRetriever` (cheerio) | Factory crashes at import (F-01) |
| `packages/agents` | Discovery, Scoring, Research, StoryEditor, Scriptwriter, VisualDirector, Voice, QA, Analytics | Run sequentially, no orchestration |
| `packages/rendering` | FFmpeg scene clips → concat → SRT burn-in + audio mux | Works mechanically; output defective (F-02/03/04) |
| `apps/cli` | commander CLI: `discover`, `score`, `research`, `script`, `approve`, `pipeline` | Cannot start (F-01); `pipeline` is mock-only (F-06) |
| `apps/api` | Express server with approval endpoints that trigger generation synchronously | Cannot start (F-01); no auth (F-19) |

There is **no** worker, queue, scheduler, cron, Dockerfile, CI config, or deployment config. **Anthropic is not used anywhere**: `ANTHROPIC_API_KEY` is declared in config, never read, and empty in `.env`.

## Inputs
- Content pillar (CLI flag or API body) and topic count. There is no external topic feed: "discovery" means asking the LLM to invent topics from its own memory (`discovery-agent.ts:23-33`).
- Environment configuration (`.env`; presence verified with values masked): OpenAI, Tavily, ElevenLabs, and Pixabay keys are set. Gemini, Pexels, Anthropic, and YouTube OAuth are empty. `MOCK_YOUTUBE=true`, `USE_SQLITE_FALLBACK=true`.

## Processing
LLM topic invention → LLM self-scoring → Tavily search on the title → fetch the top 3 pages → LLM claim extraction → LLM story outline → LLM 5-scene script → per-scene stock search and download → one TTS call for the whole narration → FFmpeg render → heuristic QA → (mock) YouTube upload → (mock) analytics.

## External services (actually wired)
| Service | Used by | Status |
|---|---|---|
| OpenAI Chat Completions (`gpt-4o`) | all LLM agents | **VERIFIED** working |
| Tavily `/search` (advanced) | ResearchAgent | **VERIFIED** working |
| Arbitrary web pages (fetch + cheerio) | ResearchAgent | **VERIFIED** working |
| ElevenLabs `/v1/text-to-speech/{voice}/with-timestamps` | VoiceAgent | **VERIFIED** working |
| Pixabay video/image API | VisualDirector (via factory) | Credential **VERIFIED**; integration **FAILED** (no code) |
| Pexels | fallback only | **UNKNOWN** (no key) |
| Gemini REST | alternative LLM | **UNKNOWN** (no key) |
| YouTube Data API v3 + OAuth | publish | **UNKNOWN** (no credentials; mocked) |

## State
- SQLite file `./database/dev.sqlite` (no file present now; it was committed in `28f650a` and its deletion is staged).
- The filesystem holds all media. Paths are hard-coded relative to `process.cwd()`: `output/temp/assets`, `output/temp/audio`, `output/temp/render_<id>`, `output/renders`.
- The workflow "state" is a `topics.state` string column. The state machine does not read or enforce it (F-15).

## Outputs
`output/renders/short_<scriptId>_<ts>.mp4`, DB rows for every artifact, and console logs. There is no thumbnail, metadata file, or upload manifest.

## Failure boundaries
Every provider call, every FFmpeg invocation, every DB write (FK enforcement is on in node:sqlite), and file I/O. The pipeline CLI wraps everything in one try/catch and calls `process.exit(1)`, which leaves the topic in whatever state it reached.

## Retry boundaries
- OpenAI: SDK default (2 retries) × wrapper (3 attempts) = **up to 9 HTTP calls per logical call** (**VERIFIED**). Malformed JSON is re-requested up to 3 times, and each attempt is billed.
- Gemini: wrapper 3×.
- ElevenLabs, Tavily, downloads, YouTube: **no retry** (**VERIFIED** for ElevenLabs on 429/500).
- FFmpeg: one "fallback" re-run per scene with a simpler filter, and a fallback mux **without subtitles** that still reports success.

## Idempotency
None. Every run mints new UUIDs. Re-running research on a topic creates a second research packet (**VERIFIED**: 2 rows). Nothing checks whether a render, voice, or publish already exists.

## Human intervention
Documented as three director gates. In practice:
- the CLI pipeline auto-approves all three with hard-coded notes (`apps/cli/src/index.ts:177-186, 209-217, 258-266`);
- the API endpoints exist but never upload, so with the API a human must do something the system cannot do;
- a broken asset or render needs manual cleanup, because there is no resume.

---

# Actual End-to-End Workflow

| # | Stage | Module | Input → Output | External API / creds | Validation | Retry / timeout | Implemented? | Tested? |
|---|---|---|---|---|---|---|---|---|
| 1 | Discovery | `discovery-agent.ts` | pillar, count → `TopicCandidate[]` | OpenAI | Zod on mapped object; **validator is a pass-through**; `sourceUrls` default `https://en.wikipedia.org` | 9 HTTP / SDK 10 min timeout | Yes, but `count` is ignored in practice (F-11) | Mock only; real run by auditor |
| 2 | Scoring | `scoring-agent.ts` | topic → `TopicScore` | OpenAI | Missing fields are **filled with passing defaults** (F-09) | same | Yes; gate never enforced | Mock; real by auditor |
| 3 | Idea gate | CLI / API | — | — | Auto-approved in CLI | — | Fake in CLI | No |
| 4 | Research | `research-agent.ts` | topic → `ResearchPacket` | Tavily (advanced) + raw fetch + OpenAI | `claims.min(2)`, `evidence.min(5)`; no evidence-vs-source check | Tavily: none; fetch: 8 s for headers only | Yes | Real by auditor |
| 5 | Story | `story-editor-agent.ts` | research → `StoryOutline` | OpenAI | Placeholder prose substituted for missing fields | 9 HTTP | Yes | Real by auditor |
| 6 | Script | `scriptwriter-agent.ts` | story → `ShortScript` | OpenAI | Zod: ≥3 scenes, hook ≥5 chars; **no word or duration bounds**; claim IDs back-filled | 9 HTTP | Yes | Real by auditor |
| 7 | Script gate | CLI / API | — | — | Auto-approved in CLI | — | Fake in CLI | No |
| 8 | Assets | `visual-director-agent.ts` → AssetProvider | scenes → `AssetDescriptor[]` | Pixabay (**no code**) / Pexels / mock | License flag check only; no relevance, orientation, duration, or file validation | none / none | **No** (Pixabay empty) | Mock only |
| 9 | Voice | `voice-agent.ts` → ElevenLabs | full narration → mp3 + word timestamps | ElevenLabs | Zod on metadata only; a 0-byte file is accepted (F-14) | none / none | Yes | Real by auditor |
| 10 | Render | `renderer.ts` | script + assets + voice → mp4 | FFmpeg | Exit code only | Fallback filters; no timeout | Yes, defective | Mock image path only (subtitles disabled in test) |
| 11 | QA | `qa-agent.ts` | artifacts → `QAResult` | — | `existsSync`, reported duration, 4-phrase blocklist | — | Shallow | Mock only |
| 12 | Final gate + upload | CLI → YouTube provider | mp4 → video id | YouTube OAuth + Data API v3 | none (title length, tags unchecked) | none / none | Code exists, never exercised | Mock only |
| 13 | Analytics | `analytics-agent.ts` | records → hard-coded recommendations | YouTube analytics **stub** | — | — | Fake (mock writes 14,250 views into the DB) | Mock only |

### Documented vs actual behavior (high-priority discrepancies)

| Documentation claim | Actual behavior | Status |
|---|---|---|
| README: "`pnpm run pipeline:mock` — complete end-to-end dry run" | Crashes at import | **VERIFIED FAILED** |
| README / ARCH: "synchronized dynamic captions" | Captions timed from a words-per-second estimate; drift up to 1.81 s; clipped at the top | **VERIFIED FAILED** |
| ARCH: "PostgreSQL (via Drizzle ORM)" | No Drizzle. Raw SQL uses SQLite-only `INSERT OR REPLACE` | **INFERRED FAILED** |
| ARCH: "Audio ducking (background music + voice)" | No music support exists | **VERIFIED** absent |
| ARCH: "Structured JSON logging with trace IDs" | String logs; `runId` is never set | **VERIFIED** absent |
| README: QA "checks audio levels, subtitle clipping, repetition against previous channel content" | No audio analysis, no subtitle check; `previousScripts` is never passed, so repetition is always PASS | **VERIFIED** absent |
| WORKFLOW: three director approval gates | Auto-approved in CLI; API render approval never publishes | **VERIFIED** |
| README: "Gathers credible primary sources… Claim → Source → Confidence" | Confidence is defaulted to 0.95, `verified` is hard-coded true, source chosen by index | **VERIFIED** |
| ARCH: "Provenance Registry enforces every claim points to a verifiable source" | It only checks that the IDs exist in the same packet | **VERIFIED** |
| ARCH: "event-driven media synthesis pipeline" | Sequential function calls | **VERIFIED** |
| Prompt (user): "Pixabay is the active provider" | Provider file is empty | **VERIFIED** |
| Prompt (user): Anthropic in use | Not used anywhere | **VERIFIED** |
| ENVIRONMENT.md: `FFMPEG_PATH`, `RENDER_OUTPUT_DIR`, `TEMP_DIR`, `YOUTUBE_DEFAULT_PRIVACY`, `MOCK_IMAGE/VIDEO/STORAGE` configurable | Declared but never read (13 dead variables) | **VERIFIED** |

---

# Provider Audit

Real calls were made with the configured credentials (secrets never printed). Each item gets a verdict.

### OpenAI (gpt-4o) — `packages/providers/src/real/openai-llm.ts`
- **Authentication:** VERIFIED. 5 real calls succeeded.
- **Endpoint / request:** VERIFIED. Chat Completions with `response_format: json_object`, temperature 0.3, `max_tokens` 3000.
- **Response parsing:** VERIFIED. `JSON.parse` of `choices[0].message.content`. Agent "validators" are `(raw) => raw` (`scoring-agent.ts:60`, `research-agent.ts:114`, `story-editor-agent.ts:61`, `scriptwriter-agent.ts:82`), so shape checking happens only after defaults have been injected.
- **Usable output:** PARTIAL. The research output had verbatim quotes, all three of which exist on the retrieved pages (VERIFIED by fetching them). The script output was 31 words, about one third of the required length (F-07). Discovery returned 1 topic when asked for 3, in all 3 runs (F-11).
- **Error behavior (VERIFIED with stubbed fetch / bogus key):**
  - 401 → retried; 3 HTTP calls, 6.1 s, then a clear error. The 401 short-circuit exists only in `generateText`, not in `generateJSON` (`openai-llm.ts:79` vs `:154`).
  - 500 (persistent) → **9 HTTP calls**, 7.6 s.
  - 200 with truncated JSON → 3 billed calls, then throws.
  - Timeout: SDK default (10 min) per attempt. **UNKNOWN** total worst case, up to ~90 min per logical call.
- **Cost:** VERIFIED via returned usage. 5,373 input + 2,091 output tokens = **$0.0343 per Short** at the code's hard-coded prices ($2.50 / $10 per 1M). Whether those prices are current is **NOT VERIFIED** against OpenAI billing.
- **Rate limits:** UNKNOWN (account tier not inspected).
- **Retry safety:** Retrying is safe from a duplicate-artifact standpoint but **not cost-safe** (malformed-JSON retries are billed).

### Tavily — `tavily-search.ts`
- **Auth:** VERIFIED (real call succeeded; bogus key → `401 Unauthorized`, surfaced cleanly).
- **Request:** `search_depth: 'advanced'` (2 credits) with `max_results: 4`. The query is the raw topic title only.
- **Response → next stage:** VERIFIED. 3 sources retrieved and used.
- **429 / 5xx / timeout:** INFERRED. No retry and **no timeout**, so one hung Tavily call hangs the pipeline.
- **API key sent in the JSON body** (`api_key`). This is Tavily's legacy style; acceptable, not logged.

### Web retrieval — `retrieval/content-retriever.ts`
- VERIFIED working on 3 real pages.
- `clearTimeout` is called right after headers arrive (`:273`), so **body download has no timeout and no size limit** (INFERRED: memory or hang risk).
- No private-IP / SSRF filtering. URLs come from Tavily, so the risk is low but non-zero.
- Raw page text goes straight into the LLM prompt (prompt-injection exposure, F-23).

### ElevenLabs — `elevenlabs-tts.ts`
- **Auth:** VERIFIED (TTS succeeded). The key is permission-scoped: `/v1/user/subscription` returns `401 missing_permissions`. That is good least-privilege, but it means tier and quota could not be read.
- **Model / voice:** `eleven_multilingual_v2`, voice `pNInz6obpgDQGcFmaJgB` (a premade ElevenLabs voice). VERIFIED.
- **Output:** VERIFIED. MP3, 48 kHz mono, 192 kbps, 16.81 s, 31 word timestamps reconstructed correctly from character alignment. Integrated loudness after normalization: **−15.6 LUFS**, LRA 1.6 LU (target −14; single-pass loudnorm undershoots, which is acceptable).
- **Error behavior (VERIFIED):** 401, 429, and 500 each produce exactly **1 HTTP call** and an immediate throw (no retry, including on 429). A hung connection was **still pending after 8 s (no timeout)**. A 200 response with empty `audio_base64` is **accepted**: it writes a 0-byte mp3 and returns `durationSeconds: 2.3` with synthesized timestamps.
- **Loudness normalization failure** is swallowed silently (`:92-101`), INFERRED.
- **Caching:** none. Every pipeline run re-synthesizes, re-billing characters.
- **Cost:** ESTIMATED (see Cost Audit).

### Pixabay — `pixabay-asset.ts`
- **Credential:** VERIFIED working with a raw request (HTTP 200, `x-ratelimit-limit: 100`). An invalid key returns **HTTP 400**, not 401; any future error handling must account for that.
- **System integration:** **FAILED.** The source file is 0 bytes. No search, ranking, orientation filter, download, or cache code exists in the repo. `output/cache/pixabay/*.json` and the artifacts show that an implementation existed and ran at about 18:15–18:24, then the file was truncated at 18:28. It is not in git and not in VS Code local history.
- **Suitability of results (VERIFIED, raw API):** the query "Tacoma Narrows Bridge collapse twisting" returned Kintai Bridge (Japan), Brooklyn Bridge, Golden Gate, a VJ "twist tunnel" loop, and a generic traffic bridge. **All 5 are landscape**, and three of them are 4K at 37–76 MB. Pixabay video search has no orientation filter, so portrait footage is rare.
- **Prior run evidence:** `pixabay_search_candidates.json` shows the lost ranker picked a **3840×2160 landscape** clip (`isPortrait: false`, score 73) as the top candidate.

### Pexels — `pexels-asset.ts`
- UNKNOWN (no key). From code: picks the *first* portrait file regardless of resolution or quality, has no duration check, buffers the entire download in memory, has no timeout, and does no content-type or decode validation.
- **Coupling:** the factory silently falls back to Pexels, then to **mock solid-color images**, when keys are missing (`factory.ts:65-74`). A misconfigured production box would render **blank slate Shorts** without any error.

### Gemini — `gemini-llm.ts`
- UNKNOWN (no key). Defaults to `gemini-1.5-pro`, which I believe has been retired (**NOT VERIFIED**). The API key is sent in the URL query string, and the system prompt is sent as a user turn. `@google/genai` is declared as a dependency but never imported.

### YouTube — `youtube-official.ts`
- UNKNOWN (no credentials; `MOCK_YOUTUBE=true`).
- From code: `verifyAuthentication()` only checks that the env vars are non-empty. The whole mp4 is read into memory for a single multipart upload (not resumable). Title (≤100 chars) and tags (≤500 chars total) are not checked. `getVideoAnalytics` is a stub returning zeros.
- Quota: `videos.insert` has historically cost 1,600 of the default 10,000 daily units, which would cap uploads at about 6 per day. **NOT VERIFIED** against current Google documentation.

---

# Media Pipeline Audit

| Concern | Finding | Status |
|---|---|---|
| Pixabay auth / search / pagination / filtering / ranking / download / cache | No code exists | **FAILED** |
| Query generation | `assetKeywords.join(' ')` from the LLM, e.g. `"bridge collapse November 7, 1940 chaos"` | VERIFIED (script output) |
| Relevance | None. `candidates[0]` is always taken (`visual-director-agent.ts:55`). Real query for a specific historical event returns unrelated famous bridges | VERIFIED (API results) |
| Media-format intent | Script asks for `HISTORICAL_IMAGE`, `PUBLIC_DOMAIN_ARCHIVE`, `CHART_DATA`, `MAP_GEOGRAPHIC`, `TIMELINE_GRAPHIC`. All map to stock search; none are implemented | VERIFIED (code) |
| Portrait / 9:16 suitability | Renderer center-crops anything to 1080×1920. Landscape 16:9 loses ~68 % of width | VERIFIED (render A) |
| Resolution | Prior ranker chose 4K "large" files (20–92 MB each) for a 1080p output | VERIFIED (artifacts) |
| Clip duration vs scene | `-stream_loop -1` loops short clips, so visible loops are possible | INFERRED |
| Duplicate prevention | None. The **same file was downloaded 3×** (identical MD5 `574681cc…`) | VERIFIED |
| Download reliability | Whole file buffered in memory; no timeout; no retry; no partial-file cleanup | INFERRED |
| Corrupt media handling | No ffprobe validation. A failed download pushes a descriptor with empty `localPath` (`:72-77`), and the render then crashes (test D) | VERIFIED |
| Embedded audio in stock | Not stripped (`-an` absent). It **replaces the narration** (F-02) | VERIFIED |
| Storage cleanup | `output/temp/assets` is never cleaned (236 MB after a few dev runs). Failed renders leave `render_<id>` dirs (2 leaked in test) | VERIFIED |
| Pexels coupling | Pexels stays as the silent fallback and type naming leaks into defaults (`license: 'Pexels License'` default in `acquireAsset`). Mild | VERIFIED (code) |

**Conclusion:** the system cannot currently source media. Even the lost Pixabay implementation, judging by its artifacts, would have chosen landscape 4K generic footage that does not depict the documentary subject.

---

# AI / LLM Audit

All calls go to one provider and one model (gpt-4o by default), with no per-task model selection.

| Call | Purpose | Measured tokens in / out | Validation | Key problems |
|---|---|---|---|---|
| Discovery | Invent topics from model memory | 317 / 149 | Pass-through; topic Zod | Asks for N, gets 1 (json_object returns an object; the validator wraps `[raw]`). No existing-topic context, so the model re-proposes the same famous topics. Exact-hash dedupe is bypassed by re-titling (**VERIFIED**: "The Bizarre Tale of the Tacoma Narrows Bridge Collapse" → "The Bizarre Failure of Tacoma Narrows Bridge") |
| Scoring | Self-graded viability | 544 / 289 | Defaults injected | Garbage response → **75 / pass** (VERIFIED). Same model scores its own idea. The gate is not enforced anywhere |
| Research | Claim extraction from 3 pages (≤4 k chars each) | 3,068 / 726 | `claims ≥ 2`, `evidence ≥ 5 chars` | Source attribution by index (misattributed, VERIFIED). URLs accepted if they parse. `verified: true` hard-coded. When no pages are found the prompt says "Rely on well-documented historical record", which is an explicit invitation to hallucinate |
| Story | 5-beat outline | 534 / 228 | Defaults injected | Missing beats replaced with generic filler ("Until engineers noticed an impossible anomaly.") that would be voiced |
| Script | 5-scene script | 910 / 699 | Zod ≥3 scenes | Ignored the 100–130 word rule (produced 31 words). No duration or word bounds enforced. Missing claims back-filled with claim #0. Missing keywords become `["documentary","cinematic"]` |

- **Malformed JSON:** retried up to 3× with an error hint. VERIFIED that each retry is a full billed call.
- **Prompt injection:** retrieved HTML text is concatenated raw into the research prompt with no delimiters or instructions to treat it as data (`research-agent.ts:64-79`). An adversarial page could plant "claims" that flow into a published video. INFERRED; not exploited.
- **Hallucination handling:** none beyond asking. No check that `evidence` is a substring of the retrieved text, even though the text is in memory. This check would have been easy and would have caught the misattribution.
- **Model choice:** discovery, scoring, and story are short, low-stakes generations. Research and script are the quality-critical calls. Per-task model selection would let the three cheap calls move to a smaller model. The saving is small in absolute terms (LLM is ≈15–20 % of per-Short cost), so this is not a priority until correctness is fixed. Any switch should be validated against the evidence-substring check proposed above, not assumed.

---

# Voice / Audio Audit

- **Provider:** ElevenLabs only (mock otherwise). VERIFIED working.
- **Format:** mp3, 48 kHz mono, 192 kbps, after an in-place loudnorm re-encode (`elevenlabs-tts.ts:69-107`). The raw ElevenLabs file is overwritten, so the original is lost.
- **Loudness:** −15.6 LUFS integrated (VERIFIED). Fine for Shorts.
- **Silence and clipping:** not checked by the code. My sample showed no clipping (true peak −1.2 dBFS, within the −1 dBTP target, VERIFIED by ebur128 run).
- **Sync with video: FAILED.** Word timestamps are stored in the DB and then **never used** by the renderer or captions. Video length = Σ(estimated scene durations) = 15.0 s vs real audio 16.81 s.

| Scene | Clip & caption window | Actually spoken | Drift at end |
|---|---|---|---|
| 1 | 0–3 s | 0–1.83 s | −1.17 s |
| 2 | 3–6 s | 2.44–6.37 s | +0.37 s |
| 3 | 6–9 s | 6.65–10.05 s | +1.05 s |
| 4 | 9–12 s | 10.44–13.22 s | +1.22 s |
| 5 | 12–15 s | 13.43–16.81 s | **+1.81 s (cut by `-shortest`)** |

- **Failure propagation:** HTTP errors propagate (good). An empty audio body is accepted as success (bad). Normalization failure is swallowed (bad).
- **Caching / idempotency:** none. The same script is re-billed on every run.
- **Production quality:** the voice itself is fine. The integration around it is not.

---

# Video Rendering Audit

Two renders were produced with the real ElevenLabs narration: **A** used real Pixabay stock clips cached from the lost implementation's prior run, **B** used mock solid-color images (Ken Burns path).

| Check | A (stock video) | B (images) | Status |
|---|---|---|---|
| Dimensions | 1080×1920 | 1080×1920 | VERIFIED ✅ |
| FPS / pix_fmt | 30 / yuv420p | 30 / yuv420p | VERIFIED ✅ |
| Video codec | H.264 **Constrained Baseline**, ultrafast | same | VERIFIED ⚠ |
| Bitrate | **7.5 Mbps** (14 MB for 15 s) | 0.17 Mbps | VERIFIED ⚠ |
| Audio | **AAC stereo, 927 bps, 100 % silence** (stock track) | AAC mono 48 kHz, narration | VERIFIED ❌ / ✅ |
| Duration vs narration | 15.03 s vs 16.81 s voice | 15.00 s vs 16.81 s | VERIFIED ❌ truncation |
| Reported duration | `durationSeconds: 15` (estimate, never probed) | same | VERIFIED ⚠ |
| Captions | Clipped at the top edge; 5-word chunks split mid-sentence | same | VERIFIED ❌ |
| Safe zones | Captions sit in the top Shorts UI zone (channel / search overlay) | same | VERIFIED ❌ |
| Transitions | `transitionIntent` ignored; hard cuts only | same | VERIFIED (code) |
| Text overlays | `textOverlay` generated by the LLM, ignored by the renderer | same | VERIFIED (code) |
| Templates | `templateType` selects a name only; colors and fonts unused | same | VERIFIED (code) |
| Fonts | `FontName=Arial` via libass system lookup; not bundled | — | INFERRED (Linux hosts lack Arial) |
| Faststart | No `-movflags +faststart` | — | VERIFIED (code) |
| Subtitle failure | Falls back to a mux **without captions** and reports `COMPLETED` (`renderer.ts:217-236`) | — | VERIFIED (code) |
| Zero assets | `TypeError: Cannot read properties of undefined (reading 'assetType')` | — | VERIFIED |
| Missing file | FFmpeg "Error opening input"; RENDER_FAILED; temp dir leaked | — | VERIFIED |
| FFmpeg binary | Hard-coded `'ffmpeg'`; `FFMPEG_PATH` ignored | — | VERIFIED |
| Shell safety | `spawn(cmd, argsArray)`, no shell | — | VERIFIED ✅ |
| Concurrency / timeouts | No FFmpeg timeout; a hung FFmpeg hangs the job | — | INFERRED |
| Render time | 5.7 s (A, includes 4K decode) / 3.7 s (B) for 15 s output | — | VERIFIED |

Frame contact sheets: `output/audit_evidence/out/sheet_A_video.png`, `sheet_B_images.png`.

---

# Reliability Audit

| Failure | Detected? | Retried? | State preserved? | Avoids duplicates? | Useful error? | Resumes? |
|---|---|---|---|---|---|---|
| OpenAI 5xx / 429 | Yes | 9× (excessive) | n/a | n/a | Yes | No |
| OpenAI 401 | Yes | 3× (should be 0) | n/a | n/a | Yes | No |
| Malformed LLM JSON | Yes | 3× billed | n/a | n/a | Yes | No |
| Missing LLM fields | **No**: defaults fabricated | — | — | — | No | — |
| Tavily outage / timeout | Outage yes; **timeout never** | No | No | — | Yes | No |
| ElevenLabs 429 / 5xx | Yes | **No** | No | — | Yes | No |
| ElevenLabs hang | **No (hangs forever)** | — | — | — | — | — |
| ElevenLabs empty audio | **No** | — | — | — | — | — |
| Asset download fails | Logged warning, continues with an empty path | No | — | — | Misleading | No |
| Corrupt asset / audio | **No** (no probe) | — | — | — | — | — |
| Subtitle filter fails | Hidden (captions dropped, status COMPLETED) | Fallback | — | — | No | — |
| Narration silently lost | **No** | — | — | — | — | — |
| Disk full | FFmpeg error → RENDER_FAILED; temp files leak | No | Partial | — | Raw stderr tail (truncated banner) | No |
| Process crash mid-run | — | — | Topic stuck in last state | No | — | **No resume command** for assets / voice / render / publish |
| Duplicate execution | — | — | — | **No**: new topic or research / voice / render each time | — | — |
| Missing env var | Silent downgrade to **mock** providers (factory) | — | — | — | **No** (would publish slate-color, sine-tone videos if YouTube were real) | — |
| Invalid / expired YouTube token | Throws at upload | No | — | — | Yes | No |

The state machine (`state-machine.ts`) is a validator whose return value is ignored. Callers write the DB state regardless (**VERIFIED**: research on a `DISCOVERED` topic logs "Invalid workflow transition" and still sets `RESEARCHED`).

---

# Security Audit

| Area | Finding | Severity | Status |
|---|---|---|---|
| Secrets in git | `.env` never committed; no API-key patterns in full history | — | VERIFIED ✅ |
| `.gitignore` | Covers `.env`, outputs, media, sqlite | — | VERIFIED ✅ |
| Committed DB | `database/dev.sqlite` in commit `28f650a` (content generated, low sensitivity) | P3 | VERIFIED |
| ElevenLabs key scope | Restricted (subscription endpoint denied) | — | VERIFIED ✅ (good) |
| API server | No authentication; `cors()` allows any origin; `app.listen(PORT)` binds all interfaces; `POST /api/topics/discover` and the approve endpoints trigger **paid** LLM/TTS work synchronously. Anyone on the network can burn credits | P1 | INFERRED (server cannot start, F-01) |
| Error leakage | API returns `err.message` verbatim, which can include provider error bodies | P3 | INFERRED |
| Shell / FFmpeg injection | Arguments passed as an array, no shell. Concat list uses `file '<path>'` (breaks on `'` in path, not exploitable as injection) | — | VERIFIED ✅ |
| Subtitle path escaping | Handles `\` and `:` only; path is internal (`render_<uuid>`) | — | VERIFIED ✅ |
| Prompt injection | Untrusted web text inlined into the research prompt without delimiting | P2 | INFERRED |
| SSRF | Retriever and `acquireAsset` fetch arbitrary URLs from provider results with no private-range blocking or size cap | P3 | INFERRED |
| Key in URL | Gemini key in query string (and Pixabay requires the same) — leaks into proxies / logs if a URL is ever logged | P3 | VERIFIED (code) |
| Dependencies | 7 advisories (1 critical, 1 high, 5 moderate), **all in the dev-only vitest/vite/esbuild chain** | P3 | VERIFIED (`pnpm audit`) |
| Logs | Logger prints LLM reasoning, URLs, local paths; no secrets observed in logs during the audit | — | VERIFIED |

---

# Cost Audit

## Measured (VERIFIED)
Real run (gpt-4o, at the code's price table):

| Stage | In tok | Out tok | USD |
|---|---|---|---|
| Discovery | 317 | 149 | 0.0023 |
| Scoring | 544 | 289 | 0.0043 |
| Research | 3,068 | 726 | 0.0149 |
| Story | 534 | 228 | 0.0036 |
| Script | 910 | 699 | 0.0093 |
| **Total LLM** | 5,373 | 2,091 | **0.0343** |

ElevenLabs narration: 207 characters (only 31 words, a defective script). Tavily: 1 advanced search.

## Per-Short estimate for a correctly sized (≈120-word, ≈45 s) Short

| Component | Basis | Per Short | Label |
|---|---|---|---|
| LLM (gpt-4o) | Measured, plus ~300 more script output tokens | $0.035–0.040 | ESTIMATED (from measured) |
| Research search | Tavily advanced = 2 credits at ~$0.008 | ≈ $0.016 | ESTIMATED |
| TTS | ~700 chars × 1 credit/char (multilingual_v2); plan-dependent ~$0.18–0.30 per 1k chars | $0.13–0.21 | ESTIMATED |
| Stock media | Pixabay free | $0 | ESTIMATED |
| Rendering | Local CPU, ~10–30 s | ≈ $0 | ESTIMATED |
| Storage | Final 40–60 MB at current bitrate, plus 100–450 MB temp never deleted | disk, not cash | ESTIMATED |
| YouTube | Free, but quota-bound | $0 | NOT VERIFIED (quota) |
| **Total variable** | | **≈ $0.18–0.27** | ESTIMATED |

| Volume | Variable cost |
|---|---|
| 1 Short | ≈ $0.18–0.27 |
| 10 Shorts | ≈ $1.8–2.7 |
| 100 Shorts | ≈ $18–27 |
| 1,000 Shorts | ≈ $180–270 |

**Monthly (ESTIMATED, subscription floors dominate TTS):**
- 1 / day ≈ 30 / month: ~$1.2 LLM + $0.5 Tavily + ElevenLabs low tier → **≈ $7–25 / month**
- 10 / day ≈ 300 / month: ~$12 LLM + $5 Tavily + ~210 k chars TTS (mid tier) → **≈ $115–130 / month**
- 100 / day ≈ 3,000 / month: ~$120 LLM + $48 Tavily + ~2.1 M chars TTS (high tier + overage) → **≈ $500–650 / month**. YouTube upload quota would likely block this volume before cost does (NOT VERIFIED).

## Cost leaks (all VERIFIED unless noted)
1. **Wasted spend on broken output:** today 100 % of real-provider spend produces unpublishable videos (F-02/03/04). This dwarfs every other leak.
2. OpenAI malformed-JSON retries are billed (up to 3×); 5xx can trigger 9 HTTP calls.
3. No TTS caching: every re-run re-synthesizes.
4. Re-running research duplicates Tavily + LLM spend and DB rows (2 packets VERIFIED).
5. Duplicate asset downloads (same 11 MB file ×3) and 4K originals for 1080p output (up to 92 MB per scene). Bandwidth, not cash.
6. Discovery asks for N topics but gets 1, so finding a novel topic needs repeated calls; dedupe misses near-duplicates.
7. Tavily `advanced` is 2× the cost of `basic`. Whether it improves claim quality here is NOT VERIFIED.
8. Cost tracking covers LLM only. `provider_runs` table exists and is never written; TTS and search spend are invisible.

---

# Performance Audit

Measured, sequential (VERIFIED): discovery 3.8 s, scoring 3.7 s, research 11.5 s, story 3.2 s, script 5.9 s, TTS 5.6 s, render 3.7–5.7 s for 15 s of output. That totals **≈ 39 s for a 15 s Short, excluding asset download** (no working asset provider).

ESTIMATED for a 45 s Short with 5 stock clips: add 5 sequential downloads of 20–90 MB each, plus 4K decode-and-scale in five sequential FFmpeg runs. Expect roughly 1–3 minutes wall-clock. Bandwidth, not CPU, will dominate.

Safe parallelization opportunities (after correctness fixes):
- TTS can run concurrently with asset search and download, because both depend only on the script.
- Per-scene asset download with a concurrency of 2–3 (Pixabay limit 100 requests per window).
- Per-scene clip encoding, bounded to the number of cores.

Do **not** parallelize discovery, scoring, or research across topics until idempotency keys exist, or duplicate spend multiplies.

Other: `node:sqlite` `DatabaseSync` blocks the event loop (irrelevant for the CLI, harmful for the API). The `ultrafast` preset trades file size (7.5 Mbps) for speed, and YouTube re-encodes anyway, so `veryfast`/`-crf 20` would give smaller uploads for modest CPU.

---

# Testing Audit

| Test file | Type | What it proves | Weakness |
|---|---|---|---|
| `schemas.test.ts` (4) | Unit | Zod accepts and rejects fixtures | Fine, narrow |
| `state-machine.test.ts` (4) | Unit | Transition table | The machine is never enforced in agents |
| `provenance.test.ts` (3) | Unit | ID membership check | Does not test evidence-vs-source, which is the real requirement |
| `captions.test.ts` (3) | Unit | SRT/ASS strings contain `-->` / `PlayResY` | Never renders. Clipping bug invisible |
| `pipeline.test.ts` (1) | Mocked "E2E" | Mock providers chain without throwing | **Subtitles disabled**, image-only mock assets, sine-tone audio, mock upload, mock analytics. Asserts file existence and constants. Never probes the output |
| `pixabay.test.ts` | — | **0 bytes, causes the suite to fail** | — |

- Provider acceptance tests: **none** (the scripts that existed are now 0 bytes).
- Failure-path tests: **none**.
- Negative tests on LLM output: **none**.
- Output inspection (ffprobe, silence, duration, caption position): **none**.
- The mock E2E is structurally unable to catch F-02 (mock assets have no audio), F-03 (mock TTS duration equals the script estimate), or F-04 (subtitles disabled).
- `lint` scripts are `echo`. There is no CI. The build fails.
- Tests write into the real `output/temp` and do not clean up assets or audio.

**Test Confidence Score: 12 / 100.**

---

# Code Quality Audit

Strengths and weaknesses that materially affect correctness or maintainability:

- **Good layering on paper:** schemas → core → providers → agents → rendering → apps, with a provider interface per capability. This is a sound base for targeted fixes.
- **Defaults instead of errors:** about 30 call sites substitute plausible-looking content for missing LLM fields (scores, claims, evidence, story beats, keywords, narration "Scene N narration."). This is the single worst code pattern in the repo, because it converts failures into publishable-looking garbage.
- **Stateless state machine:** decorative. Return values are ignored and the DB is updated unconditionally.
- **Silent downgrade to mocks** in `ProviderFactory` when keys are missing.
- **Configuration:** 13 declared env vars are never read. Paths are hard-coded to `process.cwd()`, so running from another directory breaks DB schema loading (`db.ts:33`) and output locations.
- **Dead code:** `generateAssFromScenes` (the better caption path), `ImageProvider`/`VideoProvider`, template colors and fonts, `transitionIntent`, `textOverlay`, `provider_runs` table, `@google/genai` dependency, `getStorageProvider` (always mock).
- **Typing:** `any` used for every LLM payload; validators are no-ops.
- **Build config:** per-package `rootDir: ./src` conflicts with path-mapped cross-package imports, so `tsc -b` fails (VERIFIED). Running it also emits stray `.js`/`.d.ts` into `packages/schemas/src` (VERIFIED during the audit; I removed the stray files afterwards).
- **Work-tree hygiene:** 29 modified and 7 untracked files are uncommitted, including all real-provider adapters. The only copy of the Pixabay adapter was lost this way.

---

# Shorts Output Quality

I generated a complete real-provider Short up to rendering (real gpt-4o script, real Tavily research, real ElevenLabs voice). Assets were stand-ins: cached real Pixabay clips (render A) and mock images (render B), because the Pixabay provider has no code.

| Criterion | Result |
|---|---|
| Correctly formatted 9:16 | ✅ |
| Duration in the Shorts sweet spot (30–60 s, as the project itself targets) | ❌ 15 s |
| Understandable narration | ❌ A: silent. B: final words cut |
| Synchronized | ❌ Up to 1.8 s drift |
| Captions readable on mobile | ❌ First line clipped at the top; collides with the top UI |
| Visually coherent / on-topic | ❌ Generic bridges, pedestrians' feet, a woman with a handbag, for a Tacoma Narrows story (stand-in A); blank slate (B). Live Pixabay results for the topic are equally off-subject |
| Factually trustworthy | ⚠ The claims in this run happened to be correct, but one source was misattributed, and the system marks anything as `verified` |
| Original topic | ❌ Tacoma Narrows (proposed twice in 3 runs) |

**The system cannot reliably produce a publishable Short.** It produced zero acceptable Shorts in this audit.

---

# Findings

Format: **ID — Severity — Component**, then Evidence / Why it matters / Reproduction / Fix.

### P0 — Critical

**F-01 — P0 — providers/factory, packaging** — **VERIFIED**
- Evidence: `pixabay-asset.ts`, `tests/pixabay.test.ts`, `scripts/test_pixabay_live.ts`, and `scripts/run_pre_pexels_validation.ts` are 0 bytes. `factory.ts:20` imports the Pixabay class.
- Why it matters: CLI, API, and `pipeline:mock` all crash at import. `pnpm typecheck` fails with TS2305; `pnpm build` fails (also TS6059 rootDir in core); `pnpm test` exits 1.
- Reproduce: `npx tsx apps/cli/src/index.ts --help`.
- Fix: re-implement the Pixabay adapter (or remove the import), commit all work, and add a CI job running typecheck + test.

**F-02 — P0 — rendering mux** — **VERIFIED**
- Evidence: `renderer.ts:126-136` encodes scene clips with no `-an`; `renderer.ts:192-203` muxes with no `-map`. Render A audio is a stereo AAC track that is 100 % silent. The previous developer's `pixabay_short_render.mp4` is also fully silent.
- Why it matters: any stock clip with an audio track yields a Short without narration, and QA passes it.
- Reproduce: `output/audit_evidence/render.audit.ts` test A, then `ffmpeg -i render_A_video.mp4 -af silencedetect …`.
- Fix: add `-an` to scene clips and `-map 0:v:0 -map 1:a:0` to the final mux.

**F-03 — P0 — scriptwriter / renderer timing** — **VERIFIED**
- Evidence: `scriptwriter-agent.ts:94-103` uses 2.6 wps with a 3 s floor. The renderer uses `scene.durationSeconds` and `-shortest`. Video 15.0 s vs voice 16.81 s; last 3 words lost; drift up to 1.81 s.
- Why it matters: every real Short is truncated and out of sync.
- Fix: after TTS, recompute scene start and end from `wordTimestamps` (the scene boundary is the last word of each scene), set clip durations from that, and drop `-shortest` in favor of padding video to audio length.

**F-04 — P0 — captions** — **VERIFIED**
- Evidence: `renderer.ts:196` (SRT + `force_style MarginV=260`); frame extracts show the first line clipped at y=0.
- Why it matters: captions are unreadable and sit in the Shorts top UI zone.
- Fix: use the existing `generateAssFromScenes` (PlayRes 1080×1920), drive it from `wordTimestamps`, and place captions in the lower-middle safe area (MarginV ≈ 500–700 px in 1920 space).

**F-05 — P0 — QA** — **VERIFIED**
- Evidence: silent 15 s render → `overall: WARN` → `QA_PASSED` (`qa-agent.ts:144`). Audio QA reads the *reported* duration. Visual QA is `existsSync`.
- Why it matters: QA is the last line of defense for unattended operation, and it cannot detect any of the P0 defects.
- Fix: ffprobe the output (streams, durations within 0.2 s of the voice), run ebur128/silencedetect on the final audio, check captions exist (rendered with ASS), and treat WARN as blocking for unattended runs.

**F-06 — P0 — orchestration (CLI pipeline)** — **VERIFIED**
- Evidence: `apps/cli/src/index.ts:130` sets `--mock` default `true` with no negation (commander test: `[]` and `--mock` give `true`; `--no-mock` → unknownOption). Lines 177-266 auto-approve all gates, ignore `score.passGate`, ignore `qa.overallStatus`, and call `uploadVideo` regardless.
- Why it matters: there is no path that runs real providers end-to-end, and the path that exists would publish anything.
- Fix: add `--no-mock` (or `--live`), stop on `!passGate` and on `qa.overallStatus !== 'PASS'`, and replace auto-approvals with persisted gate checks.

### P1 — High

**F-07 — P1 — script constraints** — **VERIFIED**
- Evidence: real gpt-4o produced 31 words / 5×3 s with the prompt requiring 100–130 words. A fake 4-word, 9 s script was also accepted. `ShortScriptSchema` has no word or duration bounds.
- Fix: enforce `totalWords ∈ [100,140]` and real TTS duration ∈ [30,60] s; on violation, re-prompt once with the measured count.

**F-08 — P1 — research provenance** — **VERIFIED**
- Evidence: `research-agent.ts:161,168-171` (index-based `sourceId`, `verified: true`, confidence default 0.95, evidence fallback to claim text). `scriptwriter-agent.ts:108-110` back-fills claim #0. Real run: claim 0's quote exists only on Wikipedia but is attributed to practical.engineering. Fake run: "Invented fact A" stored as verified, evidence = itself.
- Fix: require `evidence` to be a normalized substring of a specific retrieved document and set `sourceId` from the matching document. Drop claims that fail. No back-filling. Reject LLM-supplied URLs not in `searchResults`.

**F-09 — P1 — scoring** — **VERIFIED**
- Evidence: `scoring-agent.ts:70-83`. Empty JSON → `overallScore 75, passGate true`. The gate is never consulted.
- Fix: validate with a strict Zod schema (no defaults), compute `passGate` in code from the dimensions, and enforce it in the orchestrator.

**F-10 — P1 — schema / prompt mismatch** — **VERIFIED**
- Evidence: the prompt and CLI offer `STRANGE_EVENTS`; the schema has `STRANGE_REAL_WORLD`. Discovery throws ZodError.
- Fix: use a single source of truth by generating the prompt enum from `ContentPillarSchema.options`.

**F-11 — P1 — discovery novelty** — **VERIFIED**
- Evidence: 3 runs × `count=3` returned 1 topic each; "Tacoma Narrows" repeated with a new title.
- Fix: request `{"topics":[…]}` explicitly, include recent topic titles in the prompt, and add fuzzy dedupe (normalized token Jaccard or embeddings).

**F-12 — P1 — timeouts** — **VERIFIED** (ElevenLabs hang) / **INFERRED** (others)
- Evidence: no `AbortSignal` in ElevenLabs, Tavily, Pexels, YouTube, or downloads. The retriever clears its timeout before reading the body. No FFmpeg timeout.
- Fix: `AbortSignal.timeout(n)` on every fetch, plus an FFmpeg watchdog (kill after N× expected duration).

**F-13 — P1 — retry policy** — **VERIFIED**
- Evidence: OpenAI 9 HTTP calls on 5xx and 3 on 401; ElevenLabs and Tavily 0 retries on 429/5xx.
- Fix: one retry layer per provider (set the OpenAI SDK `maxRetries: 0` or remove the wrapper loop), never retry 4xx except 429, honor `Retry-After`.

**F-14 — P1 — TTS output validation** — **VERIFIED**
- Evidence: 200 with empty audio → 0-byte mp3 accepted. Loudnorm failure is swallowed.
- Fix: reject `audio_base64` that is empty or not decodable, ffprobe the result, and fail if the duration differs from the last timestamp by more than 0.5 s.

**F-15 — P1 — idempotency / resume / state** — **VERIFIED** (duplicate packets, state bypass) / **INFERRED** (crash recovery)
- Fix: introduce a `jobs` table keyed by `topicId` with per-stage artifact references. Each stage first checks for an existing artifact and skips it. Enforce `canTransition` against the DB state and throw on an invalid transition. Add a `resume <topicId>` command.

**F-16 — P1 — media relevance and suitability** — **VERIFIED** (API results, code)
- Evidence: Pixabay results for the topic are unrelated landmark bridges, all landscape. `candidates[0]` is always taken. Archive/chart/map/timeline formats are unimplemented.
- Fix: rank by orientation (portrait first), resolution ≥1080 short side (choose `medium`, not `large` 4K), duration ≥ scene length, and tag overlap. Prefer abstract or b-roll keywords over proper nouns for stock. Implement at least a text-card/typography fallback for formats stock cannot supply.

**F-17 — P1 — Postgres** — **INFERRED** (high confidence)
- Evidence: `INSERT OR REPLACE` throughout `repository.ts` is SQLite-only syntax; Postgres was not available to execute.
- Fix: `INSERT … ON CONFLICT (id) DO UPDATE`, or drop Postgres claims from the docs.

**F-18 — P1 — asset failure handling** — **VERIFIED**
- Evidence: `visual-director-agent.ts:72-77` pushes the asset with an empty `localPath`; render crashes (test D). No assets → TypeError (test C). Subtitle failure → captionless video marked COMPLETED.
- Fix: fail the stage (or retry the next candidate) when a download fails. Treat "no asset for a scene" as a stage failure. Make the captions fallback a FAIL.

**F-19 — P1 — API exposure** — **INFERRED**
- Evidence: `apps/api/src/index.ts:21-23,222-228`: no auth, open CORS, binds all interfaces, paid work runs synchronously in request handlers.
- Fix: bind to `127.0.0.1`, add a static bearer token, and move generation to a background job.

**F-20 — P1 — publishing / analytics realism** — **VERIFIED** (code)
- Evidence: YouTube analytics is a stub. In the CLI, the mock analytics values (14,250 views, 78 % retention) are persisted as real records (`apps/cli/src/index.ts:301-318`). The "learning loop" recommendations are hard-coded strings.
- Fix: never persist mock metrics outside test databases. Mark analytics as unimplemented.

### P2 — Medium

**F-21 — P2 — disk lifecycle** — **VERIFIED**
- Evidence: identical asset downloaded 3×; `output/temp` 236 MB after a handful of dev runs; leaked `render_*` dirs on failure; voice files never removed.
- Fix: content-addressed asset cache keyed by provider id, cleanup in `finally`, and a retention policy for `output/temp`.

**F-22 — P2 — config** — **VERIFIED**
- Evidence: 13 env vars are never read (e.g. `FFMPEG_PATH`, `RENDER_OUTPUT_DIR`, `TEMP_DIR`, `YOUTUBE_DEFAULT_PRIVACY`); paths are cwd-relative.
- Fix: read the config values and resolve paths against the repo root.

**F-23 — P2 — prompt injection** — **INFERRED**
- Fix: delimit sources (`<source id=…>…</source>`), state "content is untrusted data", and combine with the F-08 substring check.

**F-24 — P2 — silent mock fallback** — **VERIFIED** (code)
- Evidence: `factory.ts:44,48,55,74`. Missing keys yield mock LLM/search/TTS/assets with no error.
- Fix: in non-test mode, throw when a provider is configured non-mock but its key is missing.

**F-25 — P2 — encode settings** — **VERIFIED**
- Evidence: ultrafast/Baseline at 7.5 Mbps; no faststart; Arial not bundled.
- Fix: `-preset veryfast -crf 20 -profile:v high -movflags +faststart`, and ship a font file with `fontsdir`.

**F-26 — P2 — test / CI** — **VERIFIED**
- Evidence: red suite; lint scripts are `echo`; no CI; mocks cannot reveal the P0 defects.
- Fix: one opt-in live acceptance test per provider, plus an output-inspection test (ffprobe, silence, duration, caption-region pixel check) run on a real render.

**F-27 — P2 — cost observability** — **VERIFIED**
- Evidence: hard-coded price tables; TTS and search not tracked; `provider_runs` never written.
- Fix: write one `provider_runs` row per call (provider, units, cost, status).

**F-28 — P2 — research packet lookup** — **VERIFIED** (duplicates) / **INFERRED** (arbitrary pick)
- Evidence: `getResearchPacket` uses `rows[0]` with no `ORDER BY`.
- Fix: `ORDER BY researched_at DESC LIMIT 1`, plus a uniqueness policy.

**F-29 — P2 — repetition and policy QA** — **VERIFIED** (code)
- Evidence: `previousScripts` is never passed (always PASS). Policy check is 4 phrases on the hook only.
- Fix: load prior scripts and topics from the DB; run policy checks on the full narration.

**F-30 — P2 — YouTube metadata limits** — **INFERRED**
- Evidence: title ≤100 and tags ≤500 chars are not enforced; no `#Shorts`; description is just the hook.
- Fix: validate with `PublishJobSchema` before upload.

### P3 — Low

- **F-31 — P3 — dev dependencies.** vitest 2.x chain advisories (1 critical, 1 high, 5 moderate), dev-only. **VERIFIED.** Upgrade vitest ≥ 4.1.11.
- **F-32 — P3 — repo hygiene.** `dev.sqlite` in history (`28f650a`); 36 uncommitted or untracked files. **VERIFIED.** Commit in small units.
- **F-33 — P3 — dead code.** `ImageProvider`/`VideoProvider`, unused templates, `@google/genai`, `getStorageProvider` always mock. **VERIFIED.** Remove or implement.
- **F-34 — P3 — documentation drift.** See the discrepancy table. **VERIFIED.** Rewrite docs to match reality.
- **F-35 — P3 — Gemini adapter.** Default model is likely retired; system prompt sent as a user turn; key in URL. **INFERRED / NOT VERIFIED.**

---

# Top 10 Issues

Ranked by impact × likelihood × difficulty of detection.

| # | ID | Issue | Shortest practical fix |
|---|---|---|---|
| 1 | F-02 | Stock audio silently replaces narration | `-an` on scene clips; `-map 0:v:0 -map 1:a:0` on mux |
| 2 | F-05 | QA cannot see audio, duration, or caption failures | ffprobe + silencedetect + duration-match gate; WARN blocks |
| 3 | F-03 | Timeline from word-rate estimate; narration truncated, drift | Derive scene times from ElevenLabs `wordTimestamps` |
| 4 | F-08 | Fabricated "verified" provenance, misattribution | Evidence must be a substring of a specific retrieved doc; no defaults |
| 5 | F-01 | Empty Pixabay adapter crashes every entry point | Rewrite the adapter; commit; CI typecheck |
| 6 | F-04 | Captions clipped / in unsafe zone | Switch to the existing ASS generator with 1920-space margins |
| 7 | F-06 | Pipeline mock-only, auto-approves, ignores gates | `--live` flag; enforce `passGate` / QA; persisted approvals |
| 8 | F-09 / F-24 | Defaults fabricate passing scores; missing keys silently go mock | Strict schemas, no defaults; throw on missing key in live mode |
| 9 | F-07 | Script length unenforced (15 s Shorts) | Word / duration bounds with one corrective re-prompt |
| 10 | F-15 | No idempotency or resume; state machine decorative | Per-topic job record with stage artifacts; enforce transitions |

---

# Verified vs Inferred vs Unknown

**VERIFIED (executed or directly inspected):**
- F-01: crash at load; typecheck, build, and test failures.
- OpenAI, Tavily, ElevenLabs, and the Pixabay key work.
- Real chain output (31-word script, 1 topic per discovery call, repeat topic, claim misattribution).
- Render outputs: silent audio (A), truncation (B), drift numbers, clipped captions.
- QA verdict on the broken render.
- Retry counts (OpenAI 9 / 3 / 3; ElevenLabs 1); ElevenLabs hang; empty-audio acceptance.
- Scoring defaults; pillar enum crash; state-machine bypass; duplicate research packets.
- Duplicate downloads (MD5); temp-dir leaks; dead env vars; commander `--mock` behavior.
- `pnpm audit`; git history clean of keys; loudness (−15.6 LUFS); render timings; LLM token usage and cost.
- The previous developer's Pixabay render is also silent.

**INFERRED (code-level, not executed):**
- Postgres syntax failure (F-17).
- API exposure (F-19); API cannot start.
- Prompt injection (F-23); SSRF; retriever body-read hang.
- Tavily, Pexels, and download timeouts.
- Subtitle-fallback captionless success; FFmpeg hang.
- YouTube title/tag limits; loudnorm failure swallowing.
- Arial font absence on Linux.

**UNKNOWN / NOT VERIFIED:**
- Pexels behavior (no key); Gemini behavior (no key); YouTube OAuth and upload (no credentials).
- Current YouTube upload quota cost.
- ElevenLabs plan tier and exact per-character price (key scope blocks the subscription endpoint).
- OpenAI account rate limits and current prices; Tavily credit price.
- Behavior of the lost Pixabay adapter beyond what its leftover JSON artifacts show.
- Memory and CPU peak during 4K renders (not instrumented).

---

# Scores

| Category | Score | Rationale |
|---|---:|---|
| Architecture | 40 / 100 | Clean package layering and provider interfaces; no orchestration, stateless state machine, silent mock fallback |
| Correctness | 8 / 100 | Entry points crash; output silent or truncated; provenance fabricated |
| Reliability | 10 / 100 | No timeouts, inconsistent retries, no resume or idempotency, failures converted to defaults |
| Provider integrations | 30 / 100 | OpenAI, Tavily, ElevenLabs verified working; Pixabay absent; YouTube unexercised; analytics stub |
| Testing | 12 / 100 | Mock-only, red suite, no output inspection, no provider or failure tests |
| Security | 55 / 100 | No secrets leaked, spawn safe, scoped TTS key; unauthenticated paid API, prompt injection, dev-dep vulns |
| Performance | 50 / 100 | Fast enough per Short; fully sequential; 4K downloads; ultrafast bloat |
| Cost efficiency | 45 / 100 | Cheap per call, but all current spend yields unusable output; billed retries; no caching |
| Maintainability | 35 / 100 | Readable code; ~30 silent-default sites, 13 dead config vars, docs out of sync, uncommitted work lost |
| Shorts output quality | 5 / 100 | 0 publishable Shorts produced |
| Production readiness | 3 / 100 | Cannot start; would publish broken videos if it could |

---

# Production Readiness Verdict

## Executive Verdict: **NO**

The system fails the basic question at every layer. It does not start (F-01). Once patched, its only end-to-end runner is locked to mocks and rubber-stamps every gate (F-06). The real-provider stages, which I ran individually, produce a Short that is too short (F-07), out of sync and truncated (F-03), possibly silent (F-02), and caption-clipped (F-04). The automated QA that is supposed to catch this marks it passed (F-05) while asserting facts are "verified" through a mechanism that verifies nothing (F-08).

With real credentials and no human, the expected result is a steady stream of defective videos, billed at about $0.20 each, with database records claiming they are fact-checked and QA-passed.

---

# Prioritized Remediation Plan

Targeted changes only; no rewrite required. The layering is good enough to fix in place.

### Phase 1 — Must fix before production (P0)
1. Rebuild `pixabay-asset.ts`: portrait-first ranking, `medium` rendition, duration ≥ scene length, ffprobe validation, content-addressed cache. Commit everything. Add CI (`pnpm typecheck && pnpm test`). (F-01)
2. Renderer: `-an` on scene clips, explicit `-map` on the final mux, timeline from `wordTimestamps`, video padded to audio length. (F-02, F-03)
3. Captions: switch to `generateAssFromScenes` driven by word timestamps, with 1920-space safe-area margins; caption failure is a hard error. (F-04)
4. QA: probe the actual output (stream presence, A/V duration match ±0.2 s, non-silent narration, loudness range, captions present). WARN blocks unattended publishing. (F-05)
5. Orchestrator: a live mode, enforced `passGate`, persisted approvals, no upload unless QA PASS. (F-06)

### Phase 2 — Should fix before scaling
6. Remove every fabricated default in agents; strict Zod output schemas; evidence-substring provenance with correct source mapping. (F-08, F-09)
7. Word and duration bounds on scripts; pillar enum single-sourced; discovery returns N topics with fuzzy dedupe. (F-07, F-10, F-11)
8. Timeouts on every fetch and FFmpeg call; a single, 429-aware retry layer per provider; reject empty TTS. (F-12, F-13, F-14)
9. Job table with per-stage artifact reuse, a `resume` command, enforced transitions. (F-15)
10. Throw on missing keys in live mode; fix or remove the Postgres path; lock down the API. (F-24, F-17, F-19)

### Phase 3 — Optimization
11. Run TTS in parallel with asset sourcing; bounded parallel downloads and encodes.
12. Asset cache plus temp cleanup and a retention policy. (F-21)
13. `provider_runs` cost ledger covering TTS and search. (F-27)
14. Encode settings (`veryfast`, CRF, High profile, faststart, bundled font). (F-25)
15. Evaluate cheaper models for discovery, scoring, and story against the provenance check; evaluate Tavily `basic`.

### Phase 4 — Nice-to-have
16. Text-card / typography scenes for formats stock cannot supply; background music with ducking (as the docs promise).
17. Real YouTube analytics; repetition QA against the channel corpus.
18. Dev-dependency upgrades; dead-code removal; documentation rewrite. (F-31, F-33, F-34)

---

# Conclusion

The repository has a reasonable skeleton: typed contracts, swappable providers, a working FFmpeg path to a correctly sized 9:16 container, and three of four real providers that authenticate and return usable data. Those parts earn their credit.

The parts that decide whether a Short is publishable, though, are either missing (stock-media sourcing), defective in ways no current test can see (audio mapping, timing, captions), or designed to hide failure (default-filled LLM outputs, auto-approval, existence-only QA). The previous validation artifacts in `output/artifacts/` show these defects were already present (a silent "validated" render) and went unnoticed. That is the strongest evidence that the verification approach, not just the code, needs to change.

Fix Phase 1 in order and re-run the real-provider harness in `output/audit_evidence/`. When it produces a 30–60 s Short with audible, complete, synchronized narration, readable captions, and on-topic footage, and QA can tell the difference between that and today's output, the system can be reconsidered for supervised production. Unattended operation should wait for Phase 2.

---

### Audit side effects (disclosure)
- **Real API spend during the audit:** about $0.05 OpenAI (6 discovery-sized calls plus 1 full chain), 1 Tavily advanced search, about 207 ElevenLabs characters, 3 Pixabay requests, plus 1 Tavily, 1 OpenAI, and 2 ElevenLabs calls with deliberately invalid keys.
- **Temporary files:** the `pnpm build` probe emitted stray build files (`packages/schemas/src/index.{js,d.ts,…}`, `packages/core/dist`, tsbuildinfo files). These were removed, and `git status` matches the pre-audit state.
- **Evidence retained** in `output/audit_evidence/` (gitignored; safe to delete).
- **No production source files were modified.** This report is the only new tracked-path file.
