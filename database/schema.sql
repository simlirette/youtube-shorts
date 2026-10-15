-- =============================================================================
-- YouTube Shorts Engine — schema version 3 (v2 databases are migrated in place: v3 only adds tables)
-- Portable between SQLite (>= 3.24) and PostgreSQL: TEXT/REAL/INTEGER columns,
-- JSON documents stored as TEXT, upserts via ON CONFLICT.
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  premise TEXT NOT NULL,
  pillar TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  doc TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS topics_status_idx ON topics (status);
CREATE INDEX IF NOT EXISTS topics_dedupe_idx ON topics (dedupe_key);

CREATE TABLE IF NOT EXISTS topic_scores (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  overall_score REAL NOT NULL,
  pass_gate INTEGER NOT NULL,
  doc TEXT NOT NULL,
  scored_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS topic_scores_topic_idx ON topic_scores (topic_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  topic_id TEXT,
  failed_stage TEXT,
  error_kind TEXT,
  error_message TEXT,
  retryable INTEGER,
  artifacts TEXT NOT NULL,
  work_dir TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  locked_by TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs (state);
-- A topic can only be produced by one job at a time (and only once successfully).
CREATE UNIQUE INDEX IF NOT EXISTS jobs_topic_unique ON jobs (topic_id);

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id);

-- Generic, immutable artifact documents (research packets, scripts, narrations, assets, renders, QA).
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_job_idx ON artifacts (job_id, kind);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  notes TEXT,
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_job_idx ON approvals (job_id, stage);

CREATE TABLE IF NOT EXISTS publishes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  render_id TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  video_sha256 TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  doc TEXT NOT NULL,
  started_at TEXT NOT NULL,
  published_at TEXT,
  error TEXT
);
-- Duplicate-publication guards: one publication per job, one per (video, target).
CREATE UNIQUE INDEX IF NOT EXISTS publishes_job_unique ON publishes (job_id);
CREATE UNIQUE INDEX IF NOT EXISTS publishes_video_target_unique ON publishes (video_sha256, target);

CREATE TABLE IF NOT EXISTS provider_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  units TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_runs_job_idx ON provider_runs (job_id);

-- v3: measurements of published Shorts (YouTube Analytics API, Data API or public counters).
CREATE TABLE IF NOT EXISTS video_metrics (
  id TEXT PRIMARY KEY,
  publish_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  youtube_video_id TEXT NOT NULL,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS video_metrics_video_idx ON video_metrics (youtube_video_id, captured_at);
