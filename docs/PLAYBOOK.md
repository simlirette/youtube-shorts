# Channel Playbook — running a Shorts channel with this engine

This is the operating manual: what the system does, what you do, and how to read the results.
The strategy behind it is in `research/2026-10-content-gap/` (data) and summarised below.

## 1. Strategy in one paragraph

Generic "science/history facts" Shorts are the most saturated cluster on YouTube (this year's
search results are flooded with uploads getting 5–30 views). The engine instead targets **real
questions people type into YouTube about planes, ships, trains, bridges, odd laws** — questions
that already have long-form answers with millions of views but **no good Short**. The default
format is a **micro-explainer** (see `research/2026-10-reference-analysis/REPORT.md`): the viewer's
question is the *topic*, but the spoken hook is a concrete statement or scene; the answer or stake
arrives by about 5 s; 2–4 verified causal facts follow, each with its own literal visual beat; the
last line is a concrete payoff. Narration is continuous (2.6–3.0 words/s), footage fills the
vertical frame, a short title card names the topic for the first 2.5 s, and a separate editor
model must score the script before any voice credits are spent. Topics, footage and wording
change per Short; variants are tested one factor at a time (`EXPERIMENT`) so the channel does not
settle into a fixed template (YouTube demonetizes "generic or repetitive content … made with a
template", July 2026).

## 2. One-time setup

> **$0 per Short except the voice:** use the free profile in `docs/FREE_WORKFLOW.md` (Gemini free
> tier, Tavily free plan, Blender graphics). Only ElevenLabs credits are spent.

1. `pnpm install`, FFmpeg on PATH, `pipx install yt-dlp` (free audience signals).
2. Copy `.env.example` to `.env` and fill: `OPENAI_API_KEY`, `TAVILY_API_KEY`, `ELEVENLABS_API_KEY`
   (+ `ELEVENLABS_VOICE_ID`), `PIXABAY_API_KEY`.
   - Give the ElevenLabs key the **user_read** permission so the engine can check your credit
     balance before every narration (otherwise that protection is skipped, with a warning).
3. `pnpm cli doctor --mode live` — everything should be ✓.
4. Connect YouTube (when you are ready to upload):
   1. Google Cloud console → new project → enable **YouTube Data API v3** and **YouTube Analytics API**.
   2. OAuth consent screen (External, add yourself as a test user) → Credentials → **OAuth client ID → Desktop app**.
   3. Put the client id/secret in `.env` as `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`.
   4. `pnpm cli youtube auth` → open the printed URL with the channel owner account → grant access.
      The refresh token is written to `.env` (never printed).
   5. `pnpm cli youtube status` → shows the channel and the constraints in effect.
   6. Set `PUBLISH_TARGET=youtube`.
5. **Important — the API audit.** Uploads from a Google Cloud project that has not passed YouTube's
   API compliance audit are **locked to private** (rule for projects created after 28 July 2020).
   Until audited: the engine uploads privately; you make each video public (or schedule it) in
   YouTube Studio — 30 seconds per video. After passing the audit (YouTube API Services audit form),
   set `YOUTUBE_PROJECT_AUDITED=true` and `YOUTUBE_DEFAULT_PRIVACY=public`: the engine then schedules
   public releases itself at `PUBLISH_SLOTS` in `PUBLISH_TIMEZONE`.

## 3. Daily routine (≈10 minutes of your time)

```bash
pnpm cli daily --mode live --new 3     # refill topics, continue approved jobs, start 3 new ones
pnpm cli review --mode live            # read each script BEFORE any voice credits are spent
pnpm cli approve <job> SCRIPT          # or: --revise --notes "..."  /  --reject
pnpm cli daily --mode live --new 0     # voice, footage, render, QA for approved scripts
pnpm cli review --mode live            # watch each final video (path printed)
pnpm cli approve <job> FINAL_VIDEO
pnpm cli daily --mode live --new 0     # uploads within MAX_UPLOADS_PER_DAY
```

Recommended policy (`.env`): `APPROVAL_IDEA=auto`, `APPROVAL_SCRIPT=manual`, `APPROVAL_FINAL=manual`.
Script review is the cheapest quality gate: it costs nothing to reject a script, while voice is the
most expensive step.

Cadence: start with **1 Short per day**, consistently, for the first 30 days. Volume without
quality triggers the "inauthentic content" rule; consistency matters more than bursts.

## 4. Weekly routine

```bash
pnpm cli analytics sync --mode live    # owner metrics (engaged views, % viewed) via the Analytics API
pnpm cli analytics report --mode live  # by format, topic cluster, length, release hour + recommendations
pnpm cli gaps --mode live --probes 20  # look at the new questions found; adjust GAP_SEEDS
```

The report needs ~6–10 Shorts older than 48 h before it draws conclusions. Once it can, format
rotation is automatically nudged toward what performs (never more than ±3 rotation positions, so
variety is kept). Cluster and release-time recommendations are applied by you (edit `GAP_SEEDS`,
`PUBLISH_SLOTS`).

### What to watch (YouTube Studio → Analytics → Content → Shorts)

| Metric | Meaning | Healthy for 25–45 s Shorts | If weak |
|---|---|---|---|
| Viewed vs swiped away | hook strength (first 2 s) | > 65–70 % viewed | first frame must show the subject of the question; shorten the hook |
| Average % viewed | payoff quality | > 40 % (strong > 55 %) | answer earlier; cut scene 3 filler |
| Engaged views / views | real watches | > 50 % | same as hook |
| Subscribers per 1k views | channel value | track the trend | end on the surprising fact, not a summary |

Benchmarks are from public 2026 creator analytics studies (see research folder); treat them as
direction, compare against your own last 10 Shorts.

## 5. Costs and credit protection

| Step | Cost | Protection |
|---|---|---|
| Topic discovery | free (autocomplete + yt-dlp) + ~$0.01 triage | — |
| Research + script | ~$0.08–0.11 (OpenAI, Tavily) | script review before voice |
| Voice | ElevenLabs credits ≈ characters × model rate | balance check before synthesis; cache (never re-billed on resume) |
| Footage | free (Pixabay) + ~$0.01–0.02 vision checks | **footage preflight before voice**: a script whose scenes lack stock footage is rewritten before any credits are spent |
| Render/QA | local CPU | — |

- Question formats are 55–95 words (~350–550 characters) instead of 100–118: **~35–45 % fewer
  voice credits per Short** than the STORY format.
- `ELEVENLABS_MODEL_ID=eleven_flash_v2_5` halves credits again (0.5 credit/char vs 1). Listen to
  one sample first: Flash is less expressive than Multilingual v2.
- Campaign runs stop on the first quota/auth/configuration failure.

## 6. Policy guardrails (built in)

- AI disclosure: uploads set `containsSyntheticMedia=true` (`YOUTUBE_CONTAINS_SYNTHETIC_MEDIA`).
  The label does not reduce reach or monetization for this kind of content.
- No health, finance, legal or political advice; no living people; no current tragedies
  (enforced by topic triage).
- Every fact is verified against retrieved sources; only reputable sources are cited in the description.
- Titles and hooks are de-duplicated against previous Shorts; banned filler phrases and generic
  endings are rejected before the editor pass.
- Background music only from tracks you approved with licence evidence (`assets/music/README.md`);
  without one, Shorts render without music and QA says so.

## 7. Honest expectations

- Shorts pay roughly **$0.03–0.20 per 1,000 views**; the Partner Program requires 1,000
  subscribers + 10M Shorts views in 90 days (or 4,000 long-form watch hours). Shorts build reach
  and subscribers; revenue comes later and mostly from long-form or sponsors.
- A comparable fully automated history-Shorts pipeline reported **942 YouTube views in its first 33
  days**. Expect a slow start; the gap strategy is designed to beat that by answering questions
  people already search for, but only your own analytics can confirm it.
- The engine cannot see "viewed vs swiped away" through the API; read it in YouTube Studio.
