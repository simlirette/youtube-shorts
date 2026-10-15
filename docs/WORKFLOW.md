# Workflow & Job State Machine

A **job** produces one Short. Its state is persisted in the `jobs` table and enforced by `JobStateMachine` (`packages/core/src/state-machine.ts`): illegal transitions throw, and every state update is a compare-and-set on the previous state (two processes cannot advance the same job).

```text
CREATED → SELECTING_TOPIC ─┬─> AWAITING_IDEA_APPROVAL ──> RESEARCHING      (APPROVAL_IDEA=manual)
                           └─────────────────────────────> RESEARCHING      (APPROVAL_IDEA=auto)
RESEARCHING → SCRIPTING ─┬─> AWAITING_SCRIPT_APPROVAL ──> SYNTHESIZING_VOICE (manual; or → SCRIPTING on revisions)
                         └──────────────────────────────> SYNTHESIZING_VOICE (auto)
SYNTHESIZING_VOICE → BUILDING_TIMELINE → SOURCING_MEDIA → RENDERING → QA
QA ─┬─> AWAITING_FINAL_APPROVAL ──> READY_TO_PUBLISH     (APPROVAL_FINAL=manual, or QA requires human review)
    └─────────────────────────────> READY_TO_PUBLISH     (auto_after_qa, only if publish-eligible AND no review flags)
READY_TO_PUBLISH → PUBLISHING → PUBLISHED
PUBLISHING → FAILED → READY_TO_PUBLISH   only via `publish --retry`, only if the upload provably never started

any working/awaiting state → FAILED   (classified error, failedStage recorded)
awaiting states / READY_TO_PUBLISH → REJECTED
FAILED → <failedStage or earlier work stage>   via `resume` (never into PUBLISHING)
```

## Gates

| Gate | Manual | Automatic policy (explicit opt-in) | Recorded as |
|---|---|---|---|
| IDEA | `shorts approve <job> IDEA [--reject]` | `APPROVAL_IDEA=auto` — topic passed the deterministic score gate | `approvals` row, `decided_by=policy:auto` |
| SCRIPT | `shorts approve <job> SCRIPT [--reject\|--revise --notes …]` | `APPROVAL_SCRIPT=auto` — script passed validation + fact review | `policy:auto` |
| FINAL_VIDEO | `shorts approve <job> FINAL_VIDEO` (refused if QA is not publish-eligible) | `APPROVAL_FINAL=auto_after_qa` — media and content QA publish-eligible **and** `requiresHumanReview=false` | `policy:auto_after_qa` |

Defaults are all **manual**. A gate never becomes approved because code ran.

### Human review (non-blocking but never auto-approvable)

Some QA findings are *uncertain* rather than *wrong*. They are recorded as `reviewRequired` checks; the QA result then has `requiresHumanReview=true` and `reviewReasons`. Such a job always stops at `AWAITING_FINAL_APPROVAL`, and the publish gate rejects any `policy:` approval for it — only `decided_by=human` covers it. Current review triggers:

- `content.sources.credibility` — a referenced claim's best supporting source is QUESTIONABLE.
- `content.media.semanticRelevance` — an asset was not confirmed by the vision check (verdict UNSURE, or vision unavailable), **or** a beat had no literal footage and fell back to the scene's subject or a broader subject (the asset is stored as `NEEDS_REVIEW` with the reason; nothing is substituted silently).
- `audio.pace` — narration outside `PACE_MIN_WPS`–`PACE_MAX_WPS` (2.6–3.0 words/s).
- `video.fullBleed` — fewer than `FULL_BLEED_MIN_RATIO` (90 %) of shots fill the frame (some were letterboxed to avoid a > `MAX_UPSCALE` upscale).

### Topic threshold

`TOPIC_MIN_SCORE` (default 65) is an **editorial selectivity knob, not an objective quality line**. The score is a deterministic weighted sum of LLM sub-scores; on 20 real topics it ranged 61.8–74.2 (65 admits ~75 %, 70 admits ~15 %). A topic above the threshold still has to pass every evidence, script, media and QA gate, so the threshold trades topic diversity against API spend on topics that later fail — it does not certify quality. Tune it per channel from campaign data.

## QA

`QA` runs two reports on the **actual MP4** and the persisted artifacts:

- **Media QA** (`packages/rendering/src/media-qa.ts`): container/decode, stream counts, H.264 1080×1920 30 fps yuv420p, AAC 48 kHz stereo, duration range, A/V duration match, narration not truncated, timeline integrity, non-silence, interior speech gaps / audible final word, loudness and true peak, **envelope correlation with the narration** (proves stock audio did not replace it), black and frozen segments, caption timing vs. word timestamps, caption pixel bounding boxes inside the safe zone (rendered with libass), captions actually burned in.
- **Media QA** also samples the final video at every shot midpoint and re-runs the frame checks below (`video.frameDefects`).
- **Media QA, micro-explainer checks:** `audio.speechStart` (first word ≤ 0.3 s), `audio.speechContinuity` (no gap > 0.4 s, measured on the **narration stem**, not the mix), `audio.pace`, `video.fullBleed`, `video.upscale` (any shot upscaled beyond `MAX_UPSCALE` fails), `titleCard.layout` (title-card pixels inside the safe area, rendered with libass), and with music: `audio.musicBed` (the bed is audible after the last word) and `audio.voiceDominant` (bed set ≥ 12 LU under the narration stem; `audio.isNarration` still correlates the mix with the stem). When the variant asked for music but no approved track exists, `audio.musicBed` is a **NOT MET** warning — never a pass.
- **Content QA** (`packages/agents/src/content-qa.ts`): script contract, verified-claim count, claim provenance (referenced claims exist, are VERIFIED, cite present sources), **source policy** (`sources.notRejected`, `sources.credibility`, `sources.published`), LLM fact review (material unsupported facts block; interpretive framing is a non-blocking WARN), media coverage/uniqueness/relevance/licensing, **visual validation** (`media.visualDefects`, `media.semanticReject`, `media.semanticRelevance`), YouTube metadata limits, and for MICRO_EXPLAINER `script.editor` (the recorded editor review passed its thresholds) plus sentence-length statistics.

## Source credibility policy (`packages/agents/src/source-policy.ts`)

"Is the claim supported?" and "may this source be cited publicly?" are separate questions. `verificationStatus` answers the first (quote located verbatim, numbers consistent, entailment). Each source additionally gets a tier:

| Tier | How assigned | Effect |
|---|---|---|
| HIGH | rule: `.gov/.mil/.edu/.int/.ac.uk…`, allow-listed institutions (NASA, Nature, Reuters, AP, BBC, Smithsonian…) | citable |
| ACCEPTABLE | rule: allow-listed references (Wikipedia, Britannica…); or one batched LLM *publisher category* call for unknown domains (government/academic/news/reference/specialist → ACCEPTABLE). A model-assessed domain can never be HIGH; a conflict of interest downgrades it to QUESTIONABLE. | citable |
| QUESTIONABLE | rule: self-publishing platforms (Medium, Substack, Blogspot, Forbes contributors…); LLM: commercial, personal blog, unknown; or any source without an assessment | usable as evidence, **not citable**; a claim whose best source is QUESTIONABLE requires human review |
| REJECTED | rule: deny-listed domains (creationist/pseudo-science/conspiracy outlets, social/UGC platforms, content farms); LLM: advocacy, religious advocacy, user-generated, content farm | excluded before extraction (`research/rejected-sources.json`); a claim supported only by REJECTED sources can never be referenced or published |

The YouTube description lists only HIGH/ACCEPTABLE sources supporting the claims actually used, and publication requires at least one. The tables are policy, not truth: review them for your channel.

## Visual validation (`packages/agents/src/visual-director-agent.ts`, `packages/core/src/frame-analysis.ts`)

1. Scripts carry, per scene, a concrete `visualSubject` (2–6 words, no numbers) and up to 4 `visualExclusions`. The ranker drops candidates whose tags match an exclusion; the text judge sees subject + exclusions.
2. After download: ffprobe, full decode, black-segment detection, then **deterministic frame checks** on 5 decoded frames (10/30/50/70/90 %): black, blank/flat, chroma-key green (≥2 frames), letterbox/pillarbox bars (≥2 frames), frozen "video". Any defect rejects the candidate.
3. Only candidates that pass everything above get a **vision check**: one 3-frame contact sheet (240 px, `detail:low`) sent to the verifier model with the scene's subject/exclusions → ACCEPT / REJECT / UNSURE (max `3` per shot). ACCEPT selects the asset; REJECT skips it; if nothing is ACCEPTed the best UNSURE candidate is kept as `NEEDS_REVIEW`. No confidence number is invented: the stored result is the verdict, issues and reason, plus the measured frame metrics.

Defects always block publication; `NEEDS_REVIEW` only blocks *unattended* publication.

`publishEligible` is false if any check FAILs or any WARN is marked blocking. A non-eligible QA result moves the job to `FAILED (QA_FAILED)`.

## Publishing

`assertPublishable` (`packages/pipeline/src/publish-gate.ts`) re-checks from persisted state: job state, all artifacts present, verified claims ≥ minimum, render COMPLETED, QA belongs to the current render and is publish-eligible, the file's sha256 equals the QA-ed sha256, a FINAL_VIDEO approval for this render exists (policy approvals only valid under `auto_after_qa`), metadata within limits, and the video was not already published. Unique indexes on `publishes(job_id)` and `publishes(video_sha256, target)` make duplicate publication impossible at the storage layer. A crash during `PUBLISHING` is never auto-retried (uncertain upload outcome).

Production invariants enforced by the gate itself (not only by QA): every referenced claim VERIFIED and not backed solely by REJECTED sources; every description URL a HIGH/ACCEPTABLE research source (and at least one); validated narration file present with unchanged sha256; every asset visually validated with no defects and no vision REJECT; `requiresHumanReview` or any `NEEDS_REVIEW` asset ⇒ the FINAL approval must be `human`.

### Publication failures

Publishers throw `PublishError` with `uploadStarted`:

- `false` — failed before any video byte left the machine (invalid metadata, missing file, OAuth refresh, session creation). The record is `FAILED, uploadAttempted=false`; `shorts publish <job> --retry` clears it and re-runs the gate and upload.
- `true` (or any unclassified error) — the upload may have reached the target. Never retried automatically; `--retry` refuses; reconcile on the channel manually.

The YouTube publisher (resumable upload, OAuth refresh token) is covered by transport-level tests only. **It has not been verified against a real channel.**

## Topic selection, formats and spend gates (growth system)

- `SELECTING_TOPIC` takes the highest gap-scored topic from the pool; when the pool is empty it runs gap discovery (`DISCOVERY_MODE=gap`), and falls back to model brainstorming only when no question clears `GAP_MIN_SCORE`. Gap topics are scored from measured evidence (no model score).
- `SCRIPTING` chooses a format with `chooseFormat` (question formats for gap topics, least recently used first, never three in a row, nudged by analytics) and validates it with the format's own rules. Before the script is accepted, a **footage preflight** runs the same stock searches and ranking as `SOURCING_MEDIA`; scenes without enough usable footage are sent back to the writer. Then the fact-checker runs.
- `SYNTHESIZING_VOICE` checks the ElevenLabs balance first (`ELEVENLABS_CREDIT_PREFLIGHT`) and fails with `QUOTA_EXCEEDED` before calling the API if it cannot cover the narration.
- `READY_TO_PUBLISH` waits (does not fail) when `MAX_UPLOADS_PER_DAY` uploads happened in the last 24 h. With an audited API project and public privacy, uploads are scheduled at the next free `PUBLISH_SLOTS` time (`publishAt`).

## Micro-explainer production path (default format)

`SHORT_FORMATS=MICRO_EXPLAINER` (default) produces a 30–45 s faceless explainer. The stages above are unchanged; this is what each one adds.

1. **Variant (job creation).** `createJob` freezes a *production variant* in `job.artifacts.variant`: hook type, duration band, caption style, title card, music, voice id and speed, CTA (off), and — when `EXPERIMENT="id|factor|valueA,valueB"` is set — the experiment id, factor and arm (round-robin by the number of jobs already in the experiment; the assignment reason is recorded). Every later stage reads the variant from the job, so `resume` and config changes never alter it. Jobs created before variants existed get a recorded "legacy backfill" variant on first read.
2. **Script contract (`SCRIPTING`).** `packages/agents/src/editorial.ts` + `formats.ts`: 5–7 scenes; hook by type (statement = concrete claim with a verified claim reference, scene = action in progress, question = experiments only); the answer or stake within the first 16 words; 2–4 body facts each tied to a verified claim; the last scene is a concrete payoff with a claim; no banned filler phrases ("pivotal moment", "next time you…", …), no generic endings or unsupported drama; sentences ≤ 22 words (6–14 is the target, reported). The narration is written and validated (including the fact-checker) in one call; a **second call** then splits the frozen narration into **visual beats** — exact clauses (3–12 words) with a literal, distinct subject — and the footage preflight runs per beat (`MEDIA_PREFLIGHT_MIN_BEAT_CANDIDATES`, default 2 clips; a failing subject comes back with the tags stock actually uses). Beat defects are retried without rewriting the narration; too-short beats and repeated subjects are joined deterministically with a neighbour inside the same sentence. A short title card (≤ 60 chars) is written when the variant enables it. Weak-script fixtures from earlier output are kept as regression tests and must fail.
3. **Script editor (`SCRIPTING`).** A separate model pass (`script-editor.ts`, temperature 0) scores hook, clarity, specificity and payoff 0–5 with notes for every low score. Approval requires total ≥ `EDITOR_MIN_TOTAL` (15), hook ≥ 4, payoff ≥ 4. A failing script goes back to the writer with the notes (all writer validators run again) up to `EDITOR_MAX_REVISIONS`; then the job **fails closed** (`VALIDATION`). Every pass is stored (`script_review` artifact + `script/review-N.json`) and the editor's calls are in the cost ledger.
4. **Narration (`SYNTHESIZING_VOICE`).** After loudness normalisation the narration is tightened: leading silence cut to ~0.08 s, inter-word gaps longer than `NARRATION_GAP_TARGET_SECONDS` cut to it (5 ms crossfades), tail held at 0.4 s; word timestamps are shifted to match the edited audio. The voice stage itself rejects a narration whose speech starts after 0.3 s or that still has a gap > 0.4 s. The processing applied is recorded with the narration.
5. **Timeline (`BUILDING_TIMELINE`).** Shots cut on beat boundaries (midpoint of the pause between beats); beats shorter than `MIN_SHOT_SECONDS` merge into a neighbour, longer than `MAX_SHOT_SECONDS` split.
6. **Media (`SOURCING_MEDIA`).** Footage is searched and vision-checked **per beat** with the beat's literal subject. If none fits, the scene's subject and then a broader subject are tried — each fallback marks the asset `NEEDS_REVIEW` with the reason (human review required). Each accepted clip gets a deterministic **framing** decision from a column-energy saliency map of 3 frames: `cover` (portrait), `crop_pan` (landscape cropped to 9:16 with a slow ≤ 25 % pan between the start and end saliency centres), or `letterbox` only when filling would upscale more than `MAX_UPSCALE` or keep < 25 % of the width. The ranker scores landscape resolution by height (≥ 1080 p preferred).
7. **Render (`RENDERING`).** Full-bleed shots, word captions (`CAPTION_STYLE` plain or highlight), the title card burned in for 0–2.5 s inside the safe area, and — when an approved track exists in `MUSIC_LIBRARY` — a music bed `MUSIC_BED_LU` under the narration with sidechain ducking, fades and a limiter. The render records the track, licence, gain and measured track loudness, or `music: null` with the reason.
8. **Analytics.** `shorts analytics` groups performance by every variant factor; `shorts analytics experiment <id>` reports per-arm medians and interquartile ranges of engaged views/day (views/day if engaged views are missing) and average % viewed. With < 8 Shorts older than 72 h per arm it says "insufficient data"; a ≥ 20 % median lift with no loss in % viewed and non-overlapping ranges is reported only as a **provisional leader** (a screening signal, not significance). No metric that the API does not return (e.g. "viewed vs swiped") is invented.

All thresholds are configuration (`.env.example`, "Production variant", "Script editor", "Narration continuity", "Visual beats & framing", "Music bed"). The older formats (QUESTION_ANSWER, THREE_REASONS, STORY) still work with their previous rules; scenes without beats render per scene as before, and assets without a framing record are centre-cropped.
