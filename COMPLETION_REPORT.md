# Completion Report — YouTube Shorts Automation

**Date:** 2026-10-06 · **Baseline:** `AUDIT_REPORT.md` (production readiness 3/100) · **Scope:** take the pipeline from "does not start" to a working, testable, fail-closed live pipeline.

Short version: the system now boots, builds and tests cleanly; a real job runs OpenAI → Tavily → claim verification → script → ElevenLabs → Pixabay → FFmpeg → objective QA without mocks; five real Shorts passed all blocking QA checks (one published to local export, four awaiting human final approval); every audit P0/P1 finding has a fix with a regression test. It is **not** ready for unattended publishing to a real channel — see *Remaining limitations* and the readiness assessment at the end.

---

## 1. Implemented

### Foundations (`packages/core`)
- **Build system:** TypeScript project references (`tsconfig.base.json`, composite packages, `tests/tsconfig.json`); `pnpm typecheck`/`build` = `tsc -b` over everything including tests. Fake `echo` lint scripts removed.
- **Typed errors** (`errors.ts`): `ConfigurationError`, `AuthenticationError`, `RateLimitError`, `TimeoutError`, `ProviderUnavailableError`, `InvalidResponseError`, `ValidationError`, `QAFailedError`, `InternalError`, each with `kind` + `retryable`.
- **HTTP policy** (`http.ts`): per-attempt timeout covering headers *and* body, bounded retries for transient errors only (5xx/408/429/network), `Retry-After` support with a wait budget, provider-specific classification hooks, streamed downloads with byte cap, content-type allow-list, truncation detection, atomic rename, sha256; URLs logged without query strings.
- **Media toolkit** (`media.ts`): ffprobe summary, full-decode error check, EBU R128 loudness, silence/black detection, two-pass loudnorm to WAV, audio RMS envelopes + correlation, binary-safe process runner, FFmpeg watchdog timeouts.
- **Config** (`config.ts`): Zod-validated, repo-root-relative paths, empty values = unset, explicit `PIPELINE_MODE` (no default), mode isolation (`configForMode`: mock gets its own DB and output tree), approval policies, content contract, timeouts.
- **Logger:** structured text/JSON, child contexts (`jobId`, `stage`), redaction of key-like fields and credential patterns.
- **Job state machine** (`state-machine.ts`): enforced transitions (`assertTransition` throws), resume rules (never into `PUBLISHING`).
- **Database** (`schema.sql` v2, `db.ts`, `repository.ts`): versioned schema with legacy-DB detection, portable `ON CONFLICT` upserts, `jobs` with compare-and-set state updates and execution locks, `job_events`, immutable `artifacts`, `approvals` (with `decided_by`), `publishes` with unique `(job_id)` and `(video_sha256, target)`, `provider_runs` cost/reliability ledger.

### Providers (`packages/providers`)
- **Pixabay** (the missing provider): video + vertical image search, Zod-validated normalization to `AssetCandidate`, rendition selection (smallest ≥1080 short side), 24 h search cache (Pixabay terms; API key never written), auth classification for Pixabay's HTTP 400 invalid-key response, streamed validated downloads.
- **OpenAI / Gemini** on a shared `StructuredLLMBase`: JSON → Zod → semantic validator, corrective re-prompts that include the previous response, bounded attempts, refusal/truncation handling, per-call cost ledger. Gemini key moved from URL to header; default model updated.
- **Tavily** (raw page content), **web retriever** (private-network refusal, size/time caps), **ElevenLabs** (character alignment required, empty/small audio rejected, configurable speed, settings in cache key), **Pexels** (conformed), **YouTube** (resumable upload, metadata validation; no auto-retry), **local export** publisher.
- **Factory:** `createProviders(cfg, 'mock'|'live')` — live mode lists *all* missing credentials and refuses; no per-provider mock fallback.
- **Mocks** for offline tests produce real media: stock clips with a loud stereo audio track, WAV narration with consistent alignment, task-routed LLM.

### Agents (`packages/agents`)
- **Discovery:** exactly-N contract with corrective retry, explicit `shortfall`, fuzzy near-duplicate detection against history and batch, quality filters (clickbait, length, pillar), concluded-stories-only prompt.
- **Scoring:** overall score and gate computed in code from LLM-rated dimensions (no defaults).
- **Research + verification:** sources only from retrieval (UGC domains and snippet-only sources excluded), extraction with source refs, deterministic quote location with re-attribution, numeric consistency, LLM entailment; `VERIFIED` requires all three; minimum verified claims enforced.
- **Script:** verified claims only (short refs), 5 scenes, 100–130 words, hook ≤7 words, sentence-based length guidance, per-scene number support, asset-keyword rules, near-duplicate title/hook rejection, in-loop LLM fact review (material vs. minor), bounded attempts.
- **Voice:** TTS cache, alignment→words must equal script tokens, monotonic timestamps, two-pass loudnorm, probe/codec/rate/channel/duration/loudness/true-peak/silence validation.
- **Visual director:** ranking (weighted relevance, orientation, resolution, duration, duplicates, production-asset exclusion), LLM visual-fit judge, keyword refinement, ffprobe + full-decode + black-segment validation, versioned media cache with hard links, shot merging when distinct media runs out.
- **Content QA** (described in `docs/WORKFLOW.md`).

### Rendering (`packages/rendering`)
- **Timeline** from real word timestamps: scene cuts between words, frame-exact shots ≤6 s, caption cues (≤2 lines, ≤16 chars/line, ≤5 words, punctuation breaks).
- **Captions:** ASS with PlayRes 1080×1920, WrapStyle 2, safe-zone margins, bundled Anton font (OFL), over-long words compressed.
- **Renderer:** per-shot clips with `-an`, portrait cover-crop, landscape blurred fill (no stretching), image Ken Burns, TV-range BT.709 output, concat, final mux with explicit `-map` for video and narration, audio padded to timeline length (no `-shortest`), faststart.
- **Media QA:** 27 objective checks on the actual MP4 (see `docs/WORKFLOW.md`).

### Orchestration & apps
- **`PipelineRunner`** (`packages/pipeline`): idempotent stages, artifact reuse on resume, approvals (human + explicit policies), publish gate with sha256 re-verification, provider ledger per job, structured job reports, error files.
- **CLI:** `doctor`, `run`, `resume`, `approve`, `publish`, `jobs`, `job`, `discover`, `schedule`; mode banner; exit codes.
- **API:** token auth (timing-safe), localhost binding, optional CORS, input validation, background queue.
- **Docs** rewritten to match the implementation; `.env.example` updated.

---

## 2. Audit findings resolved

| Audit ID | Finding | Resolution | Regression test |
|---|---|---|---|
| F-01 (P0) | Empty Pixabay provider; nothing boots | Real `PixabayAssetProvider`; project references; empty test/script files removed | `pipeline.test.ts` "CLI starts"; `pixabay.test.ts` (14 tests) |
| F-02 (P0) | Stock audio replaced narration | `-an` on clips + explicit `-map`; QA `audio.isNarration` envelope correlation | `media.test.ts` "final audio is the narration…" (stock clips carry 880 Hz stereo) |
| F-03 (P0) | Estimated timing, truncation, drift | Single timeline from ElevenLabs alignment; audio padded, never truncated; QA truncation/timing checks | `media.test.ts` timeline + "video cut before narration ends" |
| F-04 (P0) | Captions clipped at top | ASS in 1080×1920 space, safe zone, pixel-measured layout QA | `media.test.ts` safe-zone PASS and outside-safe-zone FAIL |
| F-05 (P0) | QA couldn't see defects; WARN passed | Media QA on the real MP4; blocking WARNs; publish eligibility | `media.test.ts` silent/no-audio/malformed; `pipeline.test.ts` blocking WARN |
| F-06 (P0) | Mock-only pipeline, auto-approved gates, unconditional upload | Explicit live mode, persisted gates, policy approvals only after objective checks, publish gate | `pipeline.test.ts` lifecycle, manual gate, forged-state publish refusal |
| F-07 (P1) | Script length unenforced | Deterministic contract + bounded corrective retries | `script-and-discovery.test.ts` 99/100/130/131 words |
| F-08 (P1) | Fake verification, positional attribution, claim #0 back-fill | Evidence-based verification with re-attribution; no back-fill; provenance requires VERIFIED | `research.test.ts`, `provenance.test.ts`, script test "no claim #0" |
| F-09 (P1) | Scoring defaults → pass | Strict schema; computed score; gate enforced in selection | `script-and-discovery.test.ts` Scoring |
| F-10 (P1) | Pillar enum mismatch | Prompt enum generated from schema | `schemas.test.ts` |
| F-11 (P1) | Asked 3, got 1; duplicates | Exactly-N validation, explicit shortfall, fuzzy dedupe | Discovery tests (regressions 10, 11) |
| F-12 (P1) | No timeouts | HTTP policy timeouts incl. body; FFmpeg watchdog | `http.test.ts`, `pixabay.test.ts` timeout |
| F-13 (P1) | Inconsistent retries | One retry layer; no retry on auth/4xx; Retry-After | `http.test.ts` |
| F-14 (P1) | Empty TTS accepted | Audio size/alignment/silence/truncation validation | `media.test.ts` narration validation (4 tests) |
| F-15 (P1) | No idempotency/resume; decorative state machine | Enforced transitions, CAS updates, locks, resume, artifact reuse, TTS/media caches | `pipeline.test.ts` resume/lock/CAS; `state-machine.test.ts` |
| F-16 (P1) | Poor media relevance/suitability | Ranking, production-asset filter, visual-fit judge, refinement, validation | `pixabay.test.ts` ranking/validation; `visual.test.ts` |
| F-17 (P1) | Postgres syntax broken | `ON CONFLICT` upserts, `$n` placeholders | Not tested against a server (see limitations) |
| F-18 (P1) | Asset failure → empty path → crash | Download/validation failure tries next candidate; no asset → stage fails | `visual.test.ts` fail-closed |
| F-19 (P1) | Open, unauthenticated API | Token auth, localhost bind, CORS opt-in, async queue | Manual smoke test (§4) |
| F-20 (P1) | Fake analytics persisted | Analytics agent and mock metrics removed from the pipeline | — |
| F-21–F-30 (P2) | Disk growth, dead config, prompt injection, silent mock fallback, encode settings, CI/tests, cost ledger, research lookup, repetition QA, metadata limits | Content-addressed caches + per-job dirs; config consumed; untrusted-source delimiting + UGC exclusion; no fallback; CRF/High/faststart/BT.709; real test suite; `provider_runs`; artifacts by id; previous titles/hooks checked; `YouTubeMetadataSchema` | Various |
| F-31–F-35 (P3) | Dev-dep advisories, dead code, docs drift, Gemini adapter | Dead code removed, docs rewritten, Gemini fixed; **dev-dependency upgrade (vitest 2→4) not done** | — |

### New defects found and fixed during implementation (each now has a test)
Live runs surfaced problems the audit did not list: gpt-4o persistently writing ~80-word scripts, model hallucinating facts from its own knowledge (e.g. a Nobel Prize year taken from an unverified claim), black-fade stock clips, green-screen stock clips, tag-coincidence media (wedding over "disease"), full-range JPEG colour leaking into the output (`yuvj420p`), Pixabay's 400 invalid-key response, cropdetect unable to measure captions, `blend` frame-pairing errors, copy-concat frame-index quirks, digits in names ("67P") treated as quantities, trailing alignment padding flagged as a speech gap, clickbait filter missing typographic apostrophes, silent TTS crashing loudnorm, empty env vars rejected, mock providers making network calls.

---

## 3. Tests

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ exit 0 |
| `pnpm typecheck` | ✅ exit 0 (packages, apps, tests) |
| `pnpm build` | ✅ exit 0 |
| `pnpm test` | ✅ **102/102 passed**, 11 files, ~170 s (real FFmpeg renders, in-memory DB, no network) |
| `pnpm test:live` providers | ✅ 10/10 (final runs; one test-fixture bug fixed along the way) |
| `pnpm test:live` pipeline | see §4 |

Offline coverage includes all 12 required regressions:

| # | Regression | Test |
|---|---|---|
| 1 | Broken provider import → boots | `pipeline.test.ts` › application boot |
| 2 | Silent narration → QA FAIL | `media.test.ts` › a silent Short fails QA |
| 3 | Stock audio replacing narration | `media.test.ts` › final audio is the narration… |
| 4 | TTS longer than video | `media.test.ts` › timeline covers full narration; truncation check |
| 5 | Caption outside frame | `media.test.ts` › detects captions outside the safe zone |
| 6 | WARN passing QA | `pipeline.test.ts` › blocking WARN / forged state cannot publish |
| 7 | Fabricated verification | `provenance.test.ts`, `research.test.ts` |
| 8 | Array-position source matching | `research.test.ts` › re-attributes a quote… |
| 9 | Invalid word count | `script-and-discovery.test.ts` › 99/131 rejected; retry/fail |
| 10 | 3 requested, 1 returned | Discovery › explicit shortfall |
| 11 | Duplicate topic | Discovery › near-duplicate titles / catalog |
| 12 | Missing production key | `factory.test.ts` › no mock fallback |

Other failure paths covered: auth failure, 4xx no-retry, 429 Retry-After, 5xx retry, timeout, network error, malformed/empty JSON, empty search, malformed hits, wrong content type, truncated download, corrupted media, black media, unsupported/mismatched media, silent/unaligned/truncated TTS, no audio stream, malformed MP4, render-vs-narration truncation, provider failure + resume, publish after failed QA, tampered video after QA, duplicate publication, job lock, concurrent state update, resume into PUBLISHING refused, judge rejecting all media, shot merging.

---

## 4. Real-provider acceptance

Providers verified live (`tests/live/providers.live.ts`): **OpenAI** gpt-4o structured output; **Tavily** search with raw content; **ElevenLabs** audio + alignment matching the text word for word; **Pixabay** search (30 candidates), ranking, a 45.7 MB 1080×1920 download passing ffprobe + full decode; vertical image search; and invalid-key → `AuthenticationError` for all four.

### Live jobs that passed every blocking QA check

| Job | Topic | Words | Verified claims | Narration | Video | Shots (portrait) | QA | Calls | Est. cost |
|---|---|---|---|---|---|---|---|---|---|
| 73e2e994 | Quasicrystals | 106 | 9/10, 5 sources | 52.76 s, −15.8 LUFS, TP −1.5 | 53.37 s | 12 (3) | WARN (non-blocking framing), eligible | 82* | $0.567* |
| 948db6c8 | Eradication of Smallpox | 107 | 11/11, 5 sources | 50.06 s, −15.5 LUFS | 50.67 s | 12 (4) | **PASS**, 36/36 | 46 | $0.231 |
| 82470e8f | Tunguska Event | 111 | 6/10, 5 sources | 49.37 s, −15.3 LUFS | 49.97 s | 12 (4) | WARN (framing), eligible | 46 | $0.268 |
| 974fffd1 | Tacoma Narrows Collapse | 112 | 8/10, 5 sources | 51.46 s, −15.6 LUFS | 52.07 s | 11 (2) | WARN (framing), eligible | 79 | $0.273 |
| 790b6abf | Kodak's Digital Camera Decision | 116 | 8/10, 4 sources | 52.43 s, −15.3 LUFS | 53.03 s | 11 (2) | WARN (framing), eligible | 63 | $0.258 |

\* includes repeated stages while fixes were developed.

All five: H.264 High, 1080×1920, 30 fps, yuv420p (TV range), AAC 48 kHz stereo, narration envelope correlation ≥0.9, no truncation, no interior speech gaps, captions measured inside the safe zone and verified burned-in, no black or frozen segments, scene timeline aligned to narration.

**Job 73e2e994** was reviewed by me as the human gate (facts traced to verified claims, frames inspected) and **published to local export** (`output/exports/73e2e994-…/short.mp4` + `metadata.json`, sha256 `f55179f0…`). A second publish attempt was refused. The other four stop at `AWAITING_FINAL_APPROVAL` by design. **Nothing was uploaded to YouTube** (no OAuth credentials configured; `PUBLISH_TARGET=local_export`).

### Honest failure record
The acceptance runs were not uniformly green. In order:

| Run | Outcome | Cause | Action |
|---|---|---|---|
| Dev run 1 | Script rejected 3× (31/66/47 words) | Model ignores word totals | Per-scene budgets; feedback includes previous draft |
| Dev run 1 retry | Rejected by **me** at the script gate | Weak sources (Facebook post, 2009 announcement) | UGC/snippet exclusion; concluded-stories-only |
| Dev run 2 | QA FAIL | Real hallucination (Nobel Prize) + measurement bug | In-loop fact review; fixed measurement |
| Dev run 2 | QA FAIL | Black fade in a stock clip | Black-segment validation upstream |
| Accept. 1 | 0/2 | Score gate (3/20 topics pass at 70); no media for a scene | Calibrated gate (ADR-006); keyword refinement |
| Accept. 2 | 0/2 | Frame-extraction bug; "67P" read as a number | Fixed both |
| Accept. 3 | 1/2 + 1 after resume | Full-range JPEG → `yuvj420p` | TV-range output; job resumed from RENDERING, passed |
| Accept. 4 | 1/2 | Out of distinct "electronics store" clips | Shot merging; judge output format |
| Accept. 5 | 1/2 + 1 after resume | QA false positive on trailing alignment padding | Classifier fixed; job resumed at QA, passed |

Over the last three acceptance runs, 3 of 6 fresh jobs passed on the first attempt and 2 more passed after a code fix and `resume` (without re-running finished stages). That is too few runs to state a reliable success rate.

### Cost (estimated from the `provider_runs` ledger, 948db6c8)
ElevenLabs ≈ $0.147 · OpenAI ≈ $0.067 (extraction $0.028, scoring $0.010, entailment $0.008, script $0.008, discovery $0.007, review $0.004, story $0.003) · Tavily $0.016 · Pixabay $0 → **≈ $0.23 per Short**, rising to about $0.26–0.27 with the visual-fit judge and script retries. Prices are list-price estimates, not billing data.

---

## 5. Final artifact

The published Short: `output/exports/73e2e994-091f-4db2-be40-d9ae3ed41b75/short.mp4`
- "Quasicrystals: From Impossible to Nobel-Worthy" — 106 words, 5 scenes, 12 shots, 53.37 s, 34.99 MB
- H.264 High 1080×1920 30 fps yuv420p; AAC 48 kHz stereo; −15.8 LUFS integrated narration, true peak −1.5 dBFS
- 37 QA checks: 36 PASS, 1 non-blocking WARN (interpretive framing)
- Description lists source URLs and `#Shorts`; privacy `private`

The most recent clean render: `output/acceptance/2026-10-06T07-05-28-043Z/jobs/790b6abf-…/render/short.mp4` (frame sheets in the same directory).

---

## 6. Remaining limitations (not verified or not solved)

1. **YouTube upload is untested.** The resumable-upload publisher has never run against Google (no OAuth credentials). Default target is local export.
2. **Postgres is untested.** SQL is written to be compatible; only SQLite was exercised.
3. **Stock visuals are generic.** Relevance relies on Pixabay tags plus an LLM judging *tags*, not pixels. Footage is plausible b-roll, rarely the actual subject, and occasionally a loose fit (e.g. a Lady Justice statue under "fatal threat"). No vision model inspects the frames.
4. **Source credibility is recorded but not enforced.** Tiers are LLM-classified; a low-credibility site (icr.org) was cited in the published description. UGC domains are excluded, but there is no allow-list.
5. **Fact checking ends with an LLM judge.** Deterministic checks (quote location, numbers) are strong; the entailment and narration reviews are model judgments and can miss subtle errors. The human final gate remains the backstop.
6. **The yield is unproven at scale.** First-attempt success was ~50% in the final runs; failures are fail-closed but cost money (~$0.05–0.25 each, depending on stage).
7. **Pacing limits:** with this voice, about 1.9–2.1 words/s even at speed 1.1, so a 130-word script exceeds 60 s. Voice validation rejects that (fail closed), but the effective ceiling is about 120 words.
8. **Hard cuts only.** No crossfades, no music bed, no thumbnails, no analytics.
9. **Single-host concurrency.** Locks and compare-and-set work within one database; there is no distributed queue. SQLite is single-writer.
10. **Dev-only dependency advisories** (vitest 2.x) remain; there is no CI configuration in the repo.
11. **Cost figures are estimates** from list prices.
12. **Uncommitted work:** nothing has been committed. The whole implementation sits in the working tree (backup at session start).

---

## 7. Production-readiness assessment

| Question (from the brief's self-audit) | Answer now |
|---|---|
| Generate a video without mocks? | **Yes:** five live Shorts passed QA. |
| Accidentally publish a silent video? | **No:** media QA fails silence and non-narration audio; the publish gate requires eligible QA for the exact file. |
| Narration cut off? | **No:** audio is padded to the timeline; truncation is checked. |
| Captions leave the frame? | **No:** caption pixels are measured against the safe zone on every cue. |
| Unverified claim marked verified? | **No:** verification requires located evidence, matching numbers, and entailment; scripts can only cite VERIFIED claims. |
| Missing key → silent mock? | **No:** ConfigurationError listing every missing key. |
| Failed QA reaching publication? | **No:** enforced by state machine, approval check, and publish gate (tested with forged state). |
| Same job publishing twice? | **No:** state machine, gate, and unique indexes. |
| Interrupted job resumes? | **Yes:** demonstrated on two real jobs. |
| Malformed LLM output passes? | **No:** schema and semantic validation, bounded retries, then failure. |
| Unusable Pixabay media reaching FFmpeg? | **No:** ffprobe, full decode, black-frame, aspect, and production-asset checks. |
| Stock audio replacing narration? | **No:** `-an`, explicit `-map`, and envelope correlation in QA. |
| Success reported for a broken MP4? | **No:** QA inspects the actual file; a malformed MP4 fails. |

**Assessment:** the pipeline is now **production-capable for supervised operation**. It reliably produces technically valid, fact-gated Shorts or fails closed with a clear, resumable error. A human reviews each final video (the default), and publishing goes to local export or a private YouTube upload once OAuth is configured and tested.

It is **not yet ready for fully unattended public publishing.** Three reasons: the YouTube path is unverified, visual relevance is judged from tags only, and first-attempt yield over a meaningful number of runs is unknown.

Recommended next steps, in order:
1. Configure YouTube OAuth and run one private upload.
2. Run `schedule --once` for 20–30 jobs and measure yield, cost, and failure modes from `provider_runs` and `job_events`.
3. Add a frame-level vision check for media relevance.
4. Enforce a source credibility policy.
5. Add CI (`pnpm typecheck && pnpm test`) and upgrade vitest.
6. Commit the work in reviewable units.


---

## 8. FINAL PRODUCTION HARDENING (2026-10-06)

Scope: targeted hardening on branch `feat/production-pipeline`. No rebuild, no broad rewrite. Everything below is uncommitted working-tree changes.

### 8.1 Changes

| Area | Change | Where |
|---|---|---|
| Source credibility | 4 tiers (HIGH/ACCEPTABLE/QUESTIONABLE/REJECTED). Deterministic domain rules apply first; unknown domains get one batched LLM *publisher-category* call (it can never yield HIGH). REJECTED sources are dropped before extraction and logged to `research/rejected-sources.json`. Claim support (`verificationStatus`) is kept separate from publishability (`claimSourceStatus`). | `packages/agents/src/source-policy.ts`, `research-agent.ts` |
| Description sources | Lists only HIGH/ACCEPTABLE sources behind the claims actually used. At least one is required. | `scriptwriter-agent.ts` (`citableSourceUrls`) |
| Scene visual requirements | Every scene gets `visualSubject` (2–6 words, no numbers, nothing stock footage cannot show) and up to 4 `visualExclusions`, used by the ranker, the text judge and the vision check. | `script-validation.ts`, `media-ranker.ts` |
| Frame checks | Five decoded frames per candidate, checked for black, blank, chroma-key green, letterbox and static (frozen) frames. The final video is re-checked at every shot midpoint. | `packages/core/src/frame-analysis.ts`, `visual-director-agent.ts`, `rendering/src/media-qa.ts` |
| Vision check | Finalists only, at most 3 per shot. One 3-frame contact sheet at low detail returns ACCEPT, REJECT or UNSURE. The stored result is the frame metrics plus the categorical verdict, issues and reason. **No confidence number is fabricated.** | `visual-director-agent.ts`, `runner.ts` (`media_vision`) |
| Human-review channel | QA checks can be `reviewRequired`, which sets `requiresHumanReview` and `reviewReasons`. `auto_after_qa` never auto-approves such a job. | `content-qa.ts`, `media-qa.ts`, `runner.ts` |
| Publish-gate invariants | Enforced in code: referenced claims VERIFIED and not backed only by REJECTED sources; description URLs ⊆ HIGH/ACCEPTABLE sources (at least one); narration file present and its sha256 unchanged; every asset visually validated with no defects and no REJECT; review-required or NEEDS_REVIEW requires `decided_by=human`; script and topic must be the job's own. | `packages/pipeline/src/publish-gate.ts` |
| YouTube boundary | `PublishError.uploadStarted`. Failures before any byte is sent (metadata, file, OAuth, session) are safe to retry. Failures after the PUT starts (or unclassified failures) are never retried. Upload records persist `uploadAttempted`. New `shorts publish <job> --retry` clears the failed record and re-arms the job in one transaction. | `youtube-official.ts`, `local-export.ts`, `runner.ts` (`retryPublish`), CLI |
| Bug fixed | **A publish failure left the job stuck in `PUBLISHING`.** The failure handler did a compare-and-set against the stale pre-stage state, so it threw "Concurrent modification" instead of recording FAILED. Found by the new retry tests. | `runner.ts` (`fail`) |
| PostgreSQL | Real transactions on a dedicated client (AsyncLocalStorage). Job create + event, CAS + event, and topic claim are atomic. Schema init runs under an advisory lock. Connection failures raise `DatabaseUnavailableError` (retryable, clear message); `DB_CONNECT_TIMEOUT_MS` sets the connection timeout. In SQLite mode, transactions are serialized in-process. | `packages/core/src/database/db.ts`, `repository.ts` |
| Voice constraint | `SCRIPT_MAX_WORDS` is now 118 (was 130), derived from the slowest measured pace (~2.0 words/s). Config validation rejects any budget where `max/VOICE_MIN_WORDS_PER_SECOND + 0.6 > SHORT_MAX_SECONDS − 0.4`. | `config.ts`, `.env.example` |
| Topic threshold | Still 65 and still configurable. Documented as an editorial selectivity knob, not an objective quality line. | `config.ts`, `docs/WORKFLOW.md`, ADR-006 |
| Error taxonomy | New `QUOTA_EXCEEDED`. ElevenLabs reports exhausted credits as HTTP 401, which was misreported as AUTHENTICATION during the live campaign. It is now non-retryable and also propagates out of media sourcing. | `errors.ts`, `elevenlabs-tts.ts` |
| Script convergence | The writer now receives every statement the fact-checker rejected in earlier attempts, plus an explicit "no rounding / generalizing / unsupported conclusions" rule. Visual subjects that stock footage cannot provide (maps, animations, diagrams, …) are rejected. Both changes respond to live failures (§8.4). | `scriptwriter-agent.ts`, `script-validation.ts` |
| CI | `.github/workflows/ci.yml`: Node 24, pnpm, apt FFmpeg, PostgreSQL 16 service, typecheck (now including `tests/`), build, CLI boot smoke, full suite, all provider keys blank. `acceptance.yml` is `workflow_dispatch` only, with secrets in a protected environment. The empty-provider failure class is caught by typecheck, boot smoke and a source-hygiene test. | `.github/workflows/` |
| Campaign tooling | `pnpm acceptance:campaign --jobs N [--stop-at STATE]`: isolated DB/output, unattended policy, local export only. Records per-job JSON, `first_pass_success_rate` and `failure_rate_by_stage`, and resumes once only on retryable errors (recorded separately). | `scripts/acceptance-campaign.ts` |

### 8.2 Tests

**Last complete run: 143/143 passed** (13 files, including the real-PostgreSQL suite against Docker `postgres:16`; `pnpm typecheck` clean). New coverage:

- Source policy: acceptable, rejected (deny-listed and model-classified), all-rejected fails closed, questionable-only (supported but not citable, so review), mixed (best tier decides; only citable URLs listed), supported-but-failing-policy, missing assessment treated as QUESTIONABLE.
- Frame defects on real FFmpeg-generated clips: normal (no defect), green screen, black, blank, letterbox, frozen still, corrupt file.
- YouTube transport: missing credentials, token failure, session failure, mid-upload HTTP and socket failures (exactly one PUT, `uploadStarted=true`), 200 without an id, no secrets in error text.
- Publish gate: policy approval refused for review-required jobs, human approval accepted, then blocked again by defects, missing validation, rejected sources and modified narration.
- Retry safety: pre-upload failure → `--retry` publishes exactly once; mid-upload failure → retry and resume both refused.
- PostgreSQL: unavailable server, concurrent schema init, rollback, CAS race, lease exclusivity, uniqueness, atomic topic claim, and a full job that is interrupted, resumed from a new pool, and published once.
- Invalid LLM output: non-JSON, truncated JSON, wrong type, out-of-range value; bounded re-prompts.
- Voice and length: 100/118 boundaries, 119 rejected, unachievable config rejected.
- Quota classification, unsourceable visual subjects, convergence of fact-checker feedback, source hygiene.

**Not re-run after the final edits:** a final full-suite run was **killed by the host for low memory**. Edits made after the last green full run: script convergence, unsourceable-subject rule, quota classification, gate script/topic identity check, campaign `stopAt`. Each has its own targeted tests, which passed (script suite 14/14, quota test), and `pnpm typecheck` passes. **A full `pnpm test` must be re-run before merging.**

### 8.3 Positions on the brief's specific questions

- **YouTube: NOT VERIFIED.** No OAuth credentials exist in this environment, and none were invented. The boundary is tested with an injected transport only. No upload to any real channel was attempted.
- **PostgreSQL:** verified against a real server (Docker locally; service container in CI). Supported modes: SQLite = single process; PostgreSQL = multiple workers.
- **Topic threshold 65:** a selectivity knob. The data (20 topics, 61.8–74.2) does not show that 65 separates good topics from bad ones. Every downstream gate still applies.
- **Cost:** measured per live call. Vision ≈ $0.0011/call (5 calls in the media-stage job), source assessment ≈ $0.005/job, research + scripting $0.08–0.11/job. Projected full Short ≈ $0.24–0.26 (ElevenLabs ≈ $0.15–0.165 dominates), within the $0.23–0.27 target. **This is a projection, not a measured full-campaign average** (see 8.4).

### 8.4 Live acceptance campaign: results, including failures

The 10-job full campaign **could not be completed**:

1. After 2 full jobs, ElevenLabs returned `quota_exceeded` (457 of 10,000 credits left; ~700 needed per Short). No further Short can be voiced until credits are added.
2. A second, partial campaign (stopping before voice) was **stopped by the host for low memory** after 3 jobs. Its orphaned process was then killed manually, so it did not keep spending.

**Run A: full pipeline, unattended policy, pre-fix code** (1 smoke job + `output/acceptance/campaign-2026-10-06T08-44-49-406Z`):

| # | Topic | First pass | Failed stage | Cause → action |
|---|---|---|---|---|
| smoke | The Mysterious Tunguska Event | FAILED | SCRIPTING | Fact-checker caught added conclusions ("remains unsolved") on attempt 4/4 → cumulative feedback + precision rule |
| 1 | Tunguska event (new discovery) | FAILED | SOURCING_MEDIA | Script requested "animated map of Siberia"; vision correctly REJECTed landscapes and explosions → unsourceable-subject rule |
| 2 | (topic stored, voice failed) | FAILED | SYNTHESIZING_VOICE | ElevenLabs quota exhausted, misreported as AUTHENTICATION → `QUOTA_EXCEEDED` |
| 3 | The Invention of the Bullet Train | FAILED | SCRIPTING | Writer rounded "two hours and twenty minutes" to "just over two hours"; fact-checker blocked it 4 times → cumulative feedback + precision rule |

- first_pass_success_rate: **0/4 (0%)**
- failure_rate_by_stage: SCRIPTING 2/4, SOURCING_MEDIA 1/4, SYNTHESIZING_VOICE 1/4 (quota)
- Spend: $0.58

**Run B: post-fix code, `--stop-at SYNTHESIZING_VOICE`** (`output/acceptance/campaign-2026-10-06T08-50-57-418Z`):

| # | Topic | Result | Words | Source tiers | Cost |
|---|---|---|---|---|---|
| 1 | The Discovery of Penicillin | research + script first pass ✔ | 107 | 5× HIGH | $0.102 |
| 2 | The Great Emu War | first pass ✔ | 115 | 3× ACCEPTABLE, 1× QUESTIONABLE | $0.081 |
| 3 | The Miracle on the Hudson | first pass ✔ | 108 | 2× HIGH, 2× ACCEPTABLE | $0.109 |

- first_pass_success_rate **through scripting**: 3/3
- All scripts were inside the 100–118 word band.
- Spend: $0.29

Three jobs are far too few to infer a rate, and Run B says nothing about voice, media, render or QA.

**Total live spend this phase: ≈ $0.87.** No Short completed end to end on the hardened code. The vision check ran live only inside run A, job 1: 1 ACCEPT and several correct REJECTs.

### 8.5 Limitations

- YouTube publishing is unverified against a real channel.
- There is no measured end-to-end yield on the hardened pipeline. The 0% first-pass rate in run A is pre-fix; the 3/3 in run B covers only pre-voice stages.
- Frame-defect thresholds (`FRAME_THRESHOLDS`) are validated on synthetic clips, not on a corpus of real stock footage. Very dark legitimate footage (night, space) may be rejected as "black": a false positive that fails closed.
- The vision check uses `detail:low` on 240 px frames. It can miss small watermarks and text, and its verdicts were observed live on only a handful of candidates.
- The domain tables in the source policy are editorial and finite. Unknown domains rely on an LLM publisher classification (bounded to ≤ ACCEPTABLE). Subdomains inherit their parent's tier (e.g. `graphics8.nytimes.com` → HIGH).
- SQLite mode is single-process by design.
- The final full test run after the last edits was not completed (host memory). Targeted tests and typecheck passed.

### 8.6 Final verdict

## NOT READY FOR UNATTENDED PUBLICATION

**Blocking reasons, by evidence:**

1. **No end-to-end evidence on the hardened code.** The required ~10-job live campaign could not run: ElevenLabs credits are exhausted (457 of 10,000 left, ~700 needed per Short). The last measured full-pipeline first-pass rate is 0/4 (pre-fix). The post-fix improvement is shown only for research and scripting (3/3).
2. **YouTube upload is NOT VERIFIED.** No OAuth credentials exist; only the transport is tested. An unattended system whose publish step has never run cannot be called ready.
3. **Visual validation has not been calibrated on real footage at scale** (frame thresholds and vision verdicts were observed on a handful of live candidates).

What *is* in place: every brief invariant is enforced in code, so the pipeline fails closed rather than publishing bad output. That makes it suitable for **supervised operation** (`APPROVAL_FINAL=manual`, local export or private upload).

**To move toward READY:**

1. Top up ElevenLabs and run `pnpm acceptance:campaign --jobs 10`, then 20–30. Require a stable first-pass rate and review every `requiresHumanReview` reason.
2. Configure YouTube OAuth and run one **private** upload plus one forced pre-upload failure followed by `publish --retry`.
3. Calibrate the frame thresholds and vision verdicts on the campaign's real candidates.
4. Re-run the full `pnpm test` (with `TEST_DATABASE_URL`) and let CI run on push.


---

## 9. GROWTH SYSTEM (2026-10-10)

Goal: turn the validated renderer into a system for growing a Shorts channel. It covers what to make, how to make it cheaply, how to publish it, and how to learn from results. The operating manual is `docs/PLAYBOOK.md`; the research data is in `research/2026-10-content-gap/`.

### 9.1 Research that drove the design
- Generic science/history fact Shorts are the most saturated cluster: this year's search results are flooded with uploads getting 5–30 views.
- Real search questions about planes, ships, trains and infrastructure have multi-million-view long-form answers and almost no Shorts. Example: "why do planes turn after takeoff" has a 6.8M-view long-form answer and no Short in the top 20 results.
- In July 2026 YouTube clarified that "generic or repetitive content … made with a template" cannot be monetized. Shorts pay roughly $0.03–0.20 per 1,000 views.
- Uploads from unaudited Google API projects are locked to private.
- ElevenLabs Flash/Turbo models cost 0.5 credit per character through the API (Multilingual v2 costs 1).

### 9.2 What was built

| Component | Where |
|---|---|
| Free audience signals (YouTube autocomplete + yt-dlp search and counters) | `providers/real/youtube-signals.ts`, mock |
| Gap discovery: autocomplete expansion → filters → batched triage → demand/supply measurement (relevance-filtered) → deterministic gap score | `agents/gap-discovery.ts`, `shorts gaps` |
| Rotated formats: QUESTION_ANSWER (55–85 words), THREE_REASONS (65–95), STORY (100–118); question hooks; no format three times in a row; analytics nudges | `agents/formats.ts` |
| Footage preflight before voice (strict subject match) | `visualPreflight` |
| ElevenLabs credit preflight; credits per model; `QUOTA_EXCEEDED` | `voice-agent.ts`, `elevenlabs-tts.ts` |
| Media fallbacks: subject follows refinement; broad b-roll; main-subject b-roll, judged in context and flagged for review | `visual-director-agent.ts` |
| Footage rework from final review without new voice cost (`approve FINAL_VIDEO --revise --notes "scenes: 4"`) | runner, state machine |
| YouTube: OAuth loopback + PKCE (`shorts youtube auth`, token written to `.env`, never printed), `youtube status`, AI disclosure, category, language, scheduled `publishAt` (audited projects), daily upload cap | `youtube-auth.ts`, `youtube-official.ts`, `schedule.ts` |
| Analytics: Analytics API owner metrics (engaged views, % viewed, subscribers) with fallbacks; schema v3 `video_metrics` (v2 migrated in place); analyzer by format/cluster/length/release hour with recommendations and bounded format weights | `youtube-analytics.ts`, `performance-analyzer.ts`, `shorts analytics sync\|report` |
| Daily workflow (`shorts daily`) and reviewer digest (`shorts review`: script, sources, gap evidence, voice-credit cost, video, review reasons) | CLI |
| Playbook, ADR-012..015, `.env.example`, README, WORKFLOW | docs |

### 9.3 Tests
**176/176 pass** (14 files, including PostgreSQL), and `pnpm typecheck` is clean. The new `tests/growth.test.ts` covers:
- gap scoring and its monotonicity, relevance filtering, discovery end to end
- format rotation and question hooks
- exclusion validation and the writer re-prompting on missing footage
- strict preflight and broad-subject choice
- the credit preflight (refuses before billing)
- Flash credits, DST-correct release slots, the PKCE URL, the `.env` writer
- the analytics client fallback and the analyzer
- the v2→v3 migration
- a mock end-to-end run (gap topic → question format → publish → analytics) and a footage-rework end-to-end run

### 9.4 Live evidence (real providers, local export only)
- **Gap discovery (4 runs):**
  - 1,581 autocomplete suggestions → 276 after filters → 39–46 after triage → 14–16 probed → 7–10 topics per run.
  - Examples after the relevance fix: "why do ships have flat bottoms" (4.0M long-form views, 0 Shorts), "why do skyscrapers sway" (2.4M, best Short 173 views), "why are bridges important" (10.5M, 0 Shorts).
  - "Why is it illegal to…" questions measure low (5k–16k) once unrelated results are excluded.
- **Two live Shorts:**
  - "Why You Can't Keep a Crow as a Pet": QUESTION_ANSWER, 63 words, 23.7 s, about 355 voice credits.
  - "Why Planes Seem Slow in the Sky": THREE_REASONS, 72 words, 28.2 s, about 384 voice credits.
  - Both first failed at media sourcing. Root causes, all fixed and tested:
    - the footage preflight was too lenient
    - refinement kept judging clips against the old subject
    - the writer put shot preferences in exclusions
    - the broad fallback judged a bare word out of context, which produced a circuit-board shot
  - Both were then salvaged by resuming, with **zero additional voice credits** (narration cache), and are at `AWAITING_FINAL_APPROVAL` with review flags for their fallback shots.
  - Videos: `output/acceptance/campaign-2026-10-10T02-30-45-387Z/jobs/{015cce2d…,20f44cf5…}/render/short.mp4`
- **ElevenLabs:**
  - The key lacks `user_read`, so the balance check is skipped with a warning (as designed).
  - Narration used about 740 credits for both Shorts, against about 1,300 for two STORY-format Shorts.
- **Spend this phase:** about $0.65 (OpenAI/Tavily) plus about 740 ElevenLabs credits.

### 9.5 Not verified / limitations
- **No real channel upload yet.** YouTube OAuth, upload, scheduling and the Analytics API are tested against an injected transport only. The first real run needs your Google Cloud OAuth client and `shorts youtube auth`.
- **Views are not known yet.** The gap strategy is a measured hypothesis; only a few weeks of published Shorts and `analytics report` can confirm it.
- **Stock coverage limits topics.** Lines about laws, permits or documents have no literal footage. The fallbacks avoid wasted credits but produce b-roll that needs human review.
- **The triage model often omits items on its first attempt,** so re-prompts are needed (small extra cost).
- **Gap demand uses the top 20 search results,** filtered for relevance by title words. Phrasing differences can still under- or over-count.

### 9.6 Verdict for this phase
The system is **ready for supervised daily use**: gap topics, script review before voice, automatic production, final review, upload (private until the API audit), then analytics. It is **not yet proven to generate views**; that needs real publishing (see PLAYBOOK §2 and §3).
