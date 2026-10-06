# Workflow & Job State Machine

A **job** produces one Short. Its state is persisted in the `jobs` table and enforced by `JobStateMachine` (`packages/core/src/state-machine.ts`): illegal transitions throw, and every state update is a compare-and-set on the previous state (two processes cannot advance the same job).

```text
CREATED → SELECTING_TOPIC ─┬─> AWAITING_IDEA_APPROVAL ──> RESEARCHING      (APPROVAL_IDEA=manual)
                           └─────────────────────────────> RESEARCHING      (APPROVAL_IDEA=auto)
RESEARCHING → SCRIPTING ─┬─> AWAITING_SCRIPT_APPROVAL ──> SYNTHESIZING_VOICE (manual; or → SCRIPTING on revisions)
                         └──────────────────────────────> SYNTHESIZING_VOICE (auto)
SYNTHESIZING_VOICE → BUILDING_TIMELINE → SOURCING_MEDIA → RENDERING → QA
QA ─┬─> AWAITING_FINAL_APPROVAL ──> READY_TO_PUBLISH     (APPROVAL_FINAL=manual)
    └─────────────────────────────> READY_TO_PUBLISH     (auto_after_qa, only if publish-eligible)
READY_TO_PUBLISH → PUBLISHING → PUBLISHED

any working/awaiting state → FAILED   (classified error, failedStage recorded)
awaiting states / READY_TO_PUBLISH → REJECTED
FAILED → <failedStage or earlier work stage>   via `resume` (never into PUBLISHING)
```

## Gates

| Gate | Manual | Automatic policy (explicit opt-in) | Recorded as |
|---|---|---|---|
| IDEA | `shorts approve <job> IDEA [--reject]` | `APPROVAL_IDEA=auto` — topic passed the deterministic score gate | `approvals` row, `decided_by=policy:auto` |
| SCRIPT | `shorts approve <job> SCRIPT [--reject\|--revise --notes …]` | `APPROVAL_SCRIPT=auto` — script passed validation + fact review | `policy:auto` |
| FINAL_VIDEO | `shorts approve <job> FINAL_VIDEO` (refused if QA is not publish-eligible) | `APPROVAL_FINAL=auto_after_qa` — media and content QA publish-eligible | `policy:auto_after_qa` |

Defaults are all **manual**. A gate never becomes approved because code ran.

## QA

`QA` runs two reports on the **actual MP4** and the persisted artifacts:

- **Media QA** (`packages/rendering/src/media-qa.ts`): container/decode, stream counts, H.264 1080×1920 30 fps yuv420p, AAC 48 kHz stereo, duration range, A/V duration match, narration not truncated, timeline integrity, non-silence, interior speech gaps / audible final word, loudness and true peak, **envelope correlation with the narration** (proves stock audio did not replace it), black and frozen segments, caption timing vs. word timestamps, caption pixel bounding boxes inside the safe zone (rendered with libass), captions actually burned in.
- **Content QA** (`packages/agents/src/content-qa.ts`): script contract, verified-claim count, claim provenance (referenced claims exist, are VERIFIED, cite present sources), LLM fact review (material unsupported facts block; interpretive framing is a non-blocking WARN), media coverage/uniqueness/relevance/licensing, YouTube metadata limits.

`publishEligible` is false if any check FAILs or any WARN is marked blocking. A non-eligible QA result moves the job to `FAILED (QA_FAILED)`.

## Publishing

`assertPublishable` (`packages/pipeline/src/publish-gate.ts`) re-checks from persisted state: job state, all artifacts present, verified claims ≥ minimum, render COMPLETED, QA belongs to the current render and is publish-eligible, the file's sha256 equals the QA-ed sha256, a FINAL_VIDEO approval for this render exists (policy approvals only valid under `auto_after_qa`), metadata within limits, and the video was not already published. Unique indexes on `publishes(job_id)` and `publishes(video_sha256, target)` make duplicate publication impossible at the storage layer. A crash during `PUBLISHING` is never auto-retried (uncertain upload outcome).
