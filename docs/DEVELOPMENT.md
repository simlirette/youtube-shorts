# Development

## Commands

```bash
pnpm typecheck        # tsc -b over packages/apps + tsc over tests/
pnpm build            # same build graph; emits dist/ (gitignored)
pnpm test             # offline suite: unit + integration with real FFmpeg and mock providers
TEST_DATABASE_URL=<postgres url> pnpm test   # also runs the PostgreSQL suite (own schema per run)
pnpm test:live        # real-provider acceptance (tests/live/*.live.ts) — costs money
pnpm acceptance:campaign --jobs 10   # N full live jobs, unattended policy, local export only — costs money
```

The offline suite never reads `.env` (`SHORTS_SKIP_DOTENV=1`) and uses temp directories + in-memory SQLite.

## CI

- `.github/workflows/ci.yml` (push/PR): Node 24, pnpm, apt FFmpeg, a throwaway PostgreSQL 16 service; typecheck (incl. tests), build, `pnpm cli --help` boot smoke, full offline suite. All provider keys are blanked, so no paid API can be reached. An empty source file, a broken import or a module that fails to load fails typecheck, the boot smoke and `tests/hardening.test.ts` (source hygiene).
- `.github/workflows/acceptance.yml` (manual `workflow_dispatch` only, protected `acceptance` environment secrets): live tests or a live campaign; uploads JSON/Markdown reports. Never runs on pull requests and never uploads to YouTube.

## Adding a provider

1. Implement the interface in `packages/providers/src/interfaces.ts` (`LLMProvider` via `StructuredLLMBase`, `SearchProvider`, `PageRetriever`, `TTSProvider`, `AssetProvider`, `Publisher`).
2. Use `httpJson` / `httpDownload` from `@shorts/core` for every network call (timeouts, retries, classification, redacted logging). Add a `classify` hook if the provider reports auth failures with non-401 codes (Pixabay uses 400).
3. Return normalized data (`AssetCandidate`, `TTSResult` with real alignment, …). Never fabricate missing fields.
4. Register it in `createProviders` (`factory.ts`) and add its credentials to `missingLiveCredentials`.
5. Add unit tests with an injected `fetchImpl` (success, empty, malformed, auth, timeout, retry) and a live acceptance test.

## Conventions

- Agents are stateless stage logic; persistence and state transitions live in `PipelineRunner`.
- Anything an LLM produces goes through `generateStructured` with a Zod schema and, where relevant, a deterministic `validate`.
- Throw typed `PipelineError`s (`ValidationError`, `InvalidResponseError`, …); never return a fake success.
