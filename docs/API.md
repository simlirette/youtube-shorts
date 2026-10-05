# API Reference & Programmatic Contracts

## CLI Commands

The engine provides an interactive and scriptable CLI via `pnpm`:

```bash
# Full end-to-end dry run (discovery -> render -> QA -> mock publish)
pnpm run pipeline:mock

# Individual pipeline execution commands
pnpm run cli discover    # Discover candidate topics
pnpm run cli score       # Score discovered topics
pnpm run cli research    # Run research on approved topic
pnpm run cli script      # Generate structured scene script
pnpm run cli render      # Render Short from script
pnpm run cli qa          # Run automated QA evaluation
pnpm run cli approve     # Approve an idea, script, or render
pnpm run cli publish     # Stage or publish approved video
```

## REST API Endpoints (Local Dashboard / Services)

The API service (`apps/api`) runs on `http://localhost:3000`:

### Workflow & Content Endpoints
- `GET /api/topics`: List candidate topics, scores, and review status.
- `POST /api/topics/discover`: Trigger topic discovery run.
- `POST /api/topics/:id/approve`: Approve a topic for research and development.
- `GET /api/scripts/:id`: Retrieve structured script and scenes with provenance.
- `POST /api/scripts/:id/approve`: Approve script for asset generation and rendering.
- `POST /api/render/:scriptId`: Trigger rendering pipeline for a script.
- `GET /api/qa/:renderId`: Fetch multi-stage QA report.
- `POST /api/render/:renderId/approve`: Approve final video for YouTube upload.
- `POST /api/publish/:renderId`: Publish video to YouTube (Private/Unlisted).
- `GET /api/analytics`: Fetch YouTube performance and content pillar metrics.
