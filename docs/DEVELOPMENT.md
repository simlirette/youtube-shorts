# Developer & Contributor Guide

## Development Philosophy
- **Deterministic Code First**: LLMs make decisions only where human-like intelligence is required (topic ideation, claim evaluation, narrative structuring). All state management, validation, video rendering, and API communication are handled by deterministic code.
- **Fail Fast & Trace Everything**: Unhandled errors must produce actionable log messages. Every media asset and factual claim must record full provenance.
- **Zero Hallucination Tolerance**: In the research and script phases, any factual claim that cannot point to a source is flagged and rejected by QA.

## Project Structure
```text
youtube-shorts/
├── apps/
│   ├── api/          # Express/Fastify REST API server
│   └── cli/          # Interactive & automated CLI tool
├── packages/
│   ├── schemas/      # Pure Zod schemas & TypeScript contracts
│   ├── core/         # Workflow engine, db repository, logger, provenance
│   ├── providers/    # Abstract interfaces + Mock & real provider adapters
│   ├── agents/       # Discovery, Scoring, Research, Story, Script, QA agents
│   └── rendering/    # FFmpeg renderer, templates, caption generator
├── database/         # SQL migration scripts and schema definitions
├── templates/        # Video layouts (Documentary, Tech, Timeline, etc.)
├── tests/            # Integration & end-to-end tests
└── docs/             # Technical specifications & ADRs
```

## Running Tests
```bash
# Run all unit and integration tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Run TypeScript typechecker across all packages
pnpm typecheck
```

## Creating a New Provider
1. Implement the interface defined in `packages/providers/src/types.ts`.
2. Provide a concrete implementation in `packages/providers/src/concrete/`.
3. Register the provider in `packages/providers/src/factory.ts` backed by environment variable toggles.
4. Add unit tests verifying both real and fallback error handling.
