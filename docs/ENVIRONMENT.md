# Environment variables

`.env.example` is the authoritative, commented list. Configuration is parsed by `packages/core/src/config.ts` (Zod); an invalid value is a `ConfigurationError`, and empty values are treated as unset. Paths are resolved against the repository root, not the working directory.

| Group | Variables | Notes |
|---|---|---|
| Mode | `PIPELINE_MODE` | `mock` or `live`; no default. Mock mode uses `output/mock` and `database/mock-*.sqlite`. |
| Providers | `LLM_PROVIDER`, `ASSET_PROVIDER`, `PUBLISH_TARGET`, `OPENAI_*`, `GEMINI_*`, `TAVILY_*`, `ELEVENLABS_*`, `PIXABAY_API_KEY`, `PEXELS_API_KEY`, `YOUTUBE_*` | Live mode requires every credential of the selected providers; missing ones are listed together and the run aborts. |
| Approvals | `APPROVAL_IDEA`, `APPROVAL_SCRIPT`, `APPROVAL_FINAL` | Default `manual`. |
| Content | `SCRIPT_MIN_WORDS`, `SCRIPT_MAX_WORDS`, `SCRIPT_HOOK_MAX_WORDS`, `SCRIPT_MAX_ATTEMPTS`, `SHORT_MIN_SECONDS`, `SHORT_MAX_SECONDS`, `MIN_VERIFIED_CLAIMS`, `TOPIC_MIN_SCORE`, `MEDIA_MIN_RELEVANCE`, `LOUDNESS_TARGET_LUFS`, `LOUDNESS_TOLERANCE_LU` | |
| Captions | `CAPTION_FONT_FILE`, `CAPTION_FONT_NAME` | Bundled Anton (OFL). Missing font is a configuration error. |
| Reliability | `HTTP_TIMEOUT_MS`, `LLM_TIMEOUT_MS`, `TTS_TIMEOUT_MS`, `DOWNLOAD_TIMEOUT_MS`, `FFMPEG_TIMEOUT_MS`, `MAX_DOWNLOAD_BYTES`, `PROVIDER_MAX_ATTEMPTS`, `JOB_LOCK_TTL_MINUTES` | |
| Cost ledger | `ELEVENLABS_USD_PER_1K_CHARS`, `TAVILY_USD_PER_CREDIT` | Estimates for `provider_runs`; LLM prices are a table in `llm-base.ts`. |
| Storage | `OUTPUT_DIR`, `USE_SQLITE_FALLBACK`, `SQLITE_DB_PATH`, `DATABASE_URL`, `FFMPEG_PATH`, `FFPROBE_PATH` | |
| API | `PORT`, `API_HOST`, `API_TOKEN`, `API_CORS_ORIGIN` | API refuses to start without a ≥16-char token. |
| Logging | `LOG_LEVEL`, `LOG_FORMAT` | Logs redact key-like values and query-string credentials. |
