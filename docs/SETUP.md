# Setup

1. **Node.js ≥ 22.5** (the SQLite driver is `node:sqlite`; developed on Node 24), **pnpm ≥ 9**, **FFmpeg + ffprobe** on PATH (FFmpeg 7/8 with libx264, libass, libmp3lame).
2. `pnpm install`
3. `cp .env.example .env` and add credentials for live mode: `OPENAI_API_KEY`, `TAVILY_API_KEY`, `ELEVENLABS_API_KEY`, `PIXABAY_API_KEY` (plus YouTube OAuth only if `PUBLISH_TARGET=youtube`).
4. `pnpm typecheck && pnpm build && pnpm test` (offline; no API calls).
5. `pnpm cli doctor --mode live` — verifies tools, font, credentials, DB.
6. `pnpm cli run --mode mock` — full local run with mock providers (uses `output/mock` and `database/mock-dev.sqlite`).
7. `pnpm cli run --mode live` — real run; stops at `AWAITING_IDEA_APPROVAL` unless `APPROVAL_IDEA=auto`.

### Database

SQLite by default (`database/dev.sqlite`, created on first use). A database created by the old v1 schema is detected and refused with instructions; move it aside to start fresh. Postgres: set `USE_SQLITE_FALLBACK=false` and `DATABASE_URL` (SQL is Postgres-compatible but not yet exercised against a live server).

### Unattended operation

Run `pnpm cli schedule --mode live --max-per-day N` under a process supervisor (or `--once` from cron / Windows Task Scheduler). Only jobs whose approval policy allows it proceed past gates; with `APPROVAL_FINAL=manual` every Short waits for a human before publication.
