# Setup & Installation Guide

## System Requirements

1. **Node.js**: Version 20.0.0 or higher (Node 24 LTS recommended).
2. **pnpm**: Version 9.0.0 or higher.
3. **FFmpeg**: Version 6.0+ (FFmpeg 7/8 recommended) installed and available in your system `PATH`.
   - Verify by running `ffmpeg -version`.
4. **Git**: Installed and configured.

## Step-by-Step Installation

### 1. Clone & Enter Project
```bash
git clone https://github.com/simlirette/youtube-shorts.git
cd youtube-shorts
```

### 2. Install Dependencies
```bash
pnpm install
```

### 3. Configure Environment
```bash
# Copy template
cp .env.example .env
```
By default, `.env.example` has all mock flags enabled (`MOCK_LLM=true`, `MOCK_TTS=true`, `MOCK_ASSETS=true`, `MOCK_YOUTUBE=true`). This allows the entire pipeline to execute without external API accounts.

### 4. Database Setup
The system defaults to a zero-config local SQLite database (`./database/dev.sqlite`) when `USE_SQLITE_FALLBACK=true`.

For production with PostgreSQL:
```bash
# If using Docker
docker run --name shorts-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=youtube_shorts -p 5432:5432 -d postgres:16
```
Then set `USE_SQLITE_FALLBACK=false` and configure `DATABASE_URL` in `.env`.

### 5. Verify Build & Tests
```bash
pnpm build
pnpm test
```

### 6. Run Mock Pipeline
```bash
pnpm run pipeline:mock
```
This generates a complete Short from discovery through rendering in `./output/renders/`.
