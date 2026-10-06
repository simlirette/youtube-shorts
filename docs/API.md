# CLI & REST API

## CLI (`pnpm cli <command>`)

Every command that touches jobs takes `--mode mock|live` (or `PIPELINE_MODE`). There is no default mode.

| Command | Purpose |
|---|---|
| `doctor` | Check ffmpeg/ffprobe, caption font, live credentials, approval policy, DB schema. No paid calls. |
| `run [--pillar P] [--topic ID]` | Create a job and advance it until it completes, waits at a gate, or fails. Alias: `pipeline`. Exit code 2 on FAILED. |
| `resume <job> [--from STAGE] [--steal-lock]` | Resume a failed/interrupted job. `--from` restarts at an earlier work stage (later artifacts are discarded). |
| `approve <job> IDEA\|SCRIPT\|FINAL_VIDEO [--reject] [--revise] [--notes …] [--continue]` | Record a human decision. |
| `publish <job>` | Publish a READY_TO_PUBLISH job (all gates re-checked). |
| `jobs [--state S]` / `job <job>` | List jobs / full JSON report (artifacts summary, QA checks, provider calls & estimated cost, events). |
| `discover [--pillar P] [--count N]` | Store N novel topics (reports shortfall explicitly). |
| `schedule [--interval-minutes 60] [--max-per-day 1] [--max-attempts 3] [--once]` | Unattended loop: resume retryable failures, then start new jobs under a daily cap. |

Job ids accept unique prefixes (e.g. `shorts job 73e2e994`).

## REST API (`pnpm api`)

Requires `PIPELINE_MODE` and `API_TOKEN` (≥16 chars); binds to `API_HOST` (default `127.0.0.1`). All `/api/*` routes require `Authorization: Bearer <API_TOKEN>`. Long-running work is queued in-process and the request returns `202`.

| Method & path | Body | Result |
|---|---|---|
| `GET /health` | — | `{status, mode}` (no auth) |
| `GET /api/topics` | — | topic catalog |
| `POST /api/topics/discover` | `{pillar?, count?}` | 202 |
| `GET /api/jobs?state=` | — | jobs |
| `GET /api/jobs/:id` | — | job report |
| `POST /api/jobs` | `{pillar?, topicId?}` | 202 `{jobId}` |
| `POST /api/jobs/:id/resume` | `{fromStage?}` | 202 |
| `POST /api/jobs/:id/approve` | `{stage, decision, notes?}` | updated job (continues in background) |
| `POST /api/jobs/:id/publish` | — | 202 (409 unless READY_TO_PUBLISH) |
