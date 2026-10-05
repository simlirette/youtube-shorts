# Workflow & Content Lifecycle State Machine

## Finite State Machine Definition

Every content item in the YouTube Shorts Engine transitions through a deterministic state machine:

```
[ DISCOVERED ]
      │
      ▼
  [ SCORED ]
      │
      ├── (Director Approval Gate 1: Idea)
      ▼
 [ RESEARCHING ]
      │
      ▼
 [ RESEARCHED ]
      │
      ▼
[ STORY_READY ]
      │
      ▼
  [ SCRIPTING ]
      │
      ▼
[ SCRIPT_REVIEW ]
      │
      ├── (Director Approval Gate 2: Script)
      ▼
[ SCRIPT_APPROVED ]
      │
      ▼
[ ASSET_PREPARATION ]
      │
      ▼
  [ RENDERING ]
      │
      ▼
   [ RENDERED ]
      │
      ▼
     [ QA ] ──────> [ QA_FAILED ] (Requires fix or discard)
      │
      ▼
[ QA_PASSED ]
      │
      ├── (Director Approval Gate 3: Final Video)
      ▼
  [ APPROVED ]
      │
      ▼
 [ UPLOADING ]
      │
      ▼
  [ PUBLISHED ] (Initially Private/Unlisted)
      │
      ▼
  [ ANALYZING ]
```

## Review Gates

1. **Idea Approval Gate**:
   - Inputs: Topic candidate, score report, curiosity hooks, visual potential notes.
   - Director can: `APPROVE`, `REJECT`, or `REQUEST_REVISIONS`.

2. **Script Approval Gate**:
   - Inputs: Full scene breakdown, voiceover lines, visual asset notes, claim-to-source provenance.
   - Director can: `APPROVE`, `REJECT`, or edit lines directly.

3. **Final Video Approval Gate**:
   - Inputs: 1080x1920 MP4 preview, caption readability, audio ducking, automated QA score.
   - Director can: `APPROVE` (stages upload to YouTube as Private), or `REJECT` (regenerate scene/render).
