# Architectural Decisions Log (ADR)

## ADR-001: Modular Monorepo Architecture with TypeScript & PNPM Workspaces
- **Status**: Accepted
- **Context**: The engine encompasses diverse responsibilities: agent reasoning, data contracts, media synthesis (FFmpeg), and API/CLI entrypoints.
- **Decision**: Use a lightweight PNPM workspace monorepo (`packages/schemas`, `packages/core`, `packages/providers`, `packages/agents`, `packages/rendering`, `apps/cli`, `apps/api`).
- **Consequences**: Strict separation of concerns; schemas remain pure TypeScript without external dependencies; providers are swappable without touching core logic.

## ADR-002: Provider Interface Abstraction with First-Class Mocks
- **Status**: Accepted
- **Context**: External services (ElevenLabs, OpenAI, Gemini, YouTube Data API, Tavily) require credentials and incur real-world costs. Development and testing must not be blocked by lack of credentials.
- **Decision**: Define typed provider interfaces (`LLMProvider`, `TTSProvider`, `AssetProvider`, `YouTubeProvider`, etc.) with comprehensive local mock implementations that output real, deterministic synthetic assets.
- **Consequences**: Automated testing and CI/CD can run 100% offline at zero cost while maintaining full test coverage.

## ADR-003: Native FFmpeg for Video Rendering
- **Status**: Accepted
- **Context**: Video rendering needs to produce high-quality 1080x1920 (9:16) MP4s deterministically, with exact timing, caption overlays, and audio mixing.
- **Decision**: Use native FFmpeg via safe parameter execution instead of heavy web browser canvas rendering or fragile external cloud video APIs.
- **Consequences**: Extremely fast local rendering, deterministic output, cross-platform reproducibility, zero cloud rendering fees.

## ADR-004: Dual Database Support (PostgreSQL + Local SQLite Fallback)
- **Status**: Accepted
- **Context**: Production mandates PostgreSQL for concurrent analytics and relational integrity, but local development and unit tests should execute without requiring a running Docker or cloud PostgreSQL instance.
- **Decision**: Provide database abstraction that defaults to local SQLite file for zero-config local test runs, and seamlessly connects to PostgreSQL in production via connection string.
- **Consequences**: Instant setup for engineers and CI without friction.
