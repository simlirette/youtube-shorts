# $0 workflow (only ElevenLabs is paid)

Every stage except the voice can run on free services or locally:

| Stage | Service | Cost | Guard |
|---|---|---|---|
| Topic discovery | YouTube autocomplete + yt-dlp | free | — |
| Research search | Tavily **free plan** (1,000 credits/month), `basic` depth = 1 credit | $0 | `TAVILY_MONTHLY_CREDITS` refuses a search before the month's credits run out |
| Claims, script, beats, editor, fact review, footage judging, vision | **Claude Code** on your claude.ai plan (recommended), falling back per request to the **Gemini free tier** | $0 per call | the plan's usage limits; for Gemini `GEMINI_FREE_RPD` / `GEMINI_FREE_RPM` |
| Stock footage | Pixabay API | free | 90 searches/min limiter |
| Graphics (numbers, comparisons, processes, key terms) | **Blender** (local, headless) | $0 | rendered on your GPU, cached |
| Captions, title card, mix, render, QA | FFmpeg + libass (local) | $0 | — |
| Voice | ElevenLabs | **paid (credits)** | credit preflight before every narration |

When a free budget is used up, the job stops with `QUOTA_EXCEEDED` *before* the call is sent. It resumes the next day or month with `shorts resume <job>`; nothing is billed. Counters are kept per machine in `~/.shorts-engine/free-tier-usage.json`. They only see this machine's usage, so keep the limits below the providers' published quotas.

## Recommended: Claude Code first, Gemini free tier as fallback

The pipeline can run its LLM calls through the Claude Code CLI (`claude -p`), which is billed to your claude.ai plan (Pro or Max) rather than per token:

- **Isolated calls.** Each call runs headless with no tools, no MCP servers, no user or project settings (so no hooks or plugins), no saved session and its own system prompt, from an empty temporary folder.
- **No API billing.** `ANTHROPIC_API_KEY` and similar variables are removed from the call's environment, so a call can only use the plan login, never API billing. `doctor` checks that Claude Code is logged in with a claude.ai account.
- **Fallback.** When Claude is rate-limited (the plan's 5-hour or weekly limit), overloaded or timing out, that request goes to the Gemini free tier instead. Claude is then skipped until its reset time. Invalid output and login problems are never hidden by the fallback.
- **Shared allowance.** The plan's allowance is shared with your interactive Claude Code use. Batches are best run when you're not coding (e.g. overnight).

```dotenv
LLM_PROVIDER=claude_code
CLAUDE_CODE_MODEL=sonnet            # writing and judging; e.g. haiku stretches the allowance
CLAUDE_CODE_VERIFIER_MODEL=         # optional separate model for fact review, editor, QA, footage/vision checks
LLM_FALLBACK_PROVIDER=gemini        # plus the Gemini free-tier settings below
```

Measured per call: about 4 s of CLI start-up and about 1,900 tokens of overhead (system prompt and schema).

## Setup (Gemini free tier, also used as the fallback)

1. **Gemini key (free):** go to Google AI Studio → *Get API key* and create a key in a project **without billing enabled**. A project without billing cannot be charged.
   - Note: on the free tier, Google may use prompts and responses to improve its products. Our prompts contain only public research and scripts.
2. **Tavily:** keep the existing key on the free plan.
3. **Blender:** install it with `winget install BlenderFoundation.Blender` (Windows) or from blender.org. It is detected automatically; otherwise set `BLENDER_PATH`.
4. Put this in `.env` (with `LLM_PROVIDER=claude_code` above, keep the Gemini lines as the fallback):

```dotenv
LLM_PROVIDER=gemini
GEMINI_API_KEY=<your free AI Studio key>
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FREE_TIER=true
GEMINI_THINKING_BUDGET=0      # Flash "thinking" eats the output limit and the quota
GEMINI_FREE_RPM=8             # below the free tier's per-minute limit
GEMINI_FREE_RPD=200           # below the free tier's daily limit; check AI Studio → Rate limits
TAVILY_SEARCH_DEPTH=basic     # 1 credit per search instead of 2
TAVILY_USD_PER_CREDIT=0
TAVILY_MONTHLY_CREDITS=1000   # free plan
GRAPHICS_ENABLED=true
GRAPHICS_MAX_SHARE=0.4        # at most 40 % of shots are graphics; the rest is real footage
```

5. Run `pnpm cli doctor --mode live`. It shows the cost profile: the Gemini requests left today, the Tavily credits left this month, and where Blender was found.

## Throughput on the free tier

A Short uses roughly 40–80 Gemini requests: research extraction, claim checks, the script with its retries, beats, the editor, footage judging and vision checks. At `GEMINI_FREE_RPD=200` that is about **3–4 Shorts per day**, which is enough for a daily upload. Tavily's 1,000 credits cover about **200+ Shorts a month** at basic depth.

The free limits are Google's and Tavily's to change: check AI Studio's rate-limit page and lower the budgets if they shrink.

## When Google's free capacity is busy

- **Overload.** Free-tier requests get the lowest priority. When Flash models are busy, calls return `503 … high demand` or no response within `LLM_TIMEOUT`, and the job fails as retryable. Wait and run `shorts resume <job>`; nothing is billed.
- **Flash-Lite.** `gemini-3.1-flash-lite` usually still answers, but its scripts are weaker. On 2026-10-12 one of its scripts scored 12/20 with the editor and was stopped before any voice credits were spent. Use Flash for scripts that you plan to publish.
- **Retired models.** Google retires older models for *new* keys: `gemini-2.5-flash` returns `404 … no longer available to new users`. The model metadata endpoint still lists such models, so only a real request reveals this.

## How the Blender graphics work

- **Choosing a graphic.** The beat planner may show a clause as a graphic instead of stock footage when its point is one of these:
  - a number → `stat`;
  - two or three values → `compare`;
  - a short cause-and-effect → `process`;
  - a technical term no camera can film → `keyword`.
- **Graphics can't add facts.** Every number in a graphic must be spoken in that clause, and every word must come from the narration. The planner rejects anything else, and content QA re-checks every rendered graphic (`media.generatedGraphics`). A graphic beat must have at least 5 words, so it is long enough to read.
- **Rendering.** Graphics are rendered by `packages/rendering/blender/graphic.py`, headless, with Eevee at 1080×1920 and 30 fps. That takes about 10–45 s per graphic on an RTX 3050. Results are cached by content, and frames are checked like stock clips (black, blank, frozen).
- **No paid checks.** Graphics skip the stock search and the vision check, which saves calls on the free tier too. They are not marked as "vision accepted": the asset records `generated: { tool: 'blender', … }` and is accepted on the deterministic checks above.
- **Without Blender.** The planner is told graphics are unavailable, and such clauses use stock footage (with the existing human-review fallbacks).

Style (colours, font) lives in the template script's `THEME` and in the caption font (`CAPTION_FONT_FILE`).
