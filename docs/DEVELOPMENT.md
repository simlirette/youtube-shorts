# Development

## Commands

```bash
pnpm typecheck        # tsc -b over all project references (packages, apps, tests)
pnpm build            # same build graph; emits dist/ (gitignored)
pnpm test             # offline suite: unit + integration with real FFmpeg and mock providers
pnpm test:live        # real-provider acceptance (tests/live/*.live.ts) — costs money
```

The offline suite never reads `.env` (`SHORTS_SKIP_DOTENV=1`) and uses temp directories + in-memory SQLite.

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
