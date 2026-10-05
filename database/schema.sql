-- =============================================================================
-- YouTube Shorts Engine Database Schema
-- Compatible with SQLite and PostgreSQL
-- =============================================================================

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  premise TEXT NOT NULL,
  pillar TEXT NOT NULL,
  source_urls TEXT NOT NULL, -- JSON array
  tags TEXT NOT NULL,        -- JSON array
  state TEXT NOT NULL,
  similarity_hash TEXT,
  discovered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_scores (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  overall_score REAL NOT NULL,
  curiosity REAL NOT NULL,
  audience_potential REAL NOT NULL,
  originality REAL NOT NULL,
  story_depth REAL NOT NULL,
  visual_potential REAL NOT NULL,
  source_availability REAL NOT NULL,
  freshness REAL NOT NULL,
  production_complexity REAL NOT NULL,
  copyright_risk REAL NOT NULL,
  repetition_risk REAL NOT NULL,
  monetization_risk REAL NOT NULL,
  reasoning TEXT NOT NULL,
  pass_gate INTEGER NOT NULL, -- 0 or 1
  scored_at TEXT NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES topics (id)
);

CREATE TABLE IF NOT EXISTS research_packets (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_entities TEXT NOT NULL, -- JSON array
  uncertainty_notes TEXT NOT NULL, -- JSON array
  researched_at TEXT NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES topics (id)
);

CREATE TABLE IF NOT EXISTS source_references (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT NOT NULL,
  publish_date TEXT,
  credibility_tier TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  archive_url TEXT,
  FOREIGN KEY (research_id) REFERENCES research_packets (id)
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  text TEXT NOT NULL,
  entity TEXT NOT NULL,
  source_citation TEXT NOT NULL,
  confidence REAL NOT NULL,
  is_key_fact INTEGER NOT NULL,
  verified INTEGER NOT NULL,
  FOREIGN KEY (research_id) REFERENCES research_packets (id),
  FOREIGN KEY (source_id) REFERENCES source_references (id)
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  logline TEXT NOT NULL,
  central_conflict TEXT NOT NULL,
  hook_concept TEXT NOT NULL,
  narrative_arc TEXT NOT NULL, -- JSON object
  target_duration_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES topics (id)
);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  title TEXT NOT NULL,
  hook_text TEXT NOT NULL,
  target_duration_seconds INTEGER NOT NULL,
  total_words INTEGER NOT NULL,
  estimated_duration_seconds REAL NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (story_id) REFERENCES stories (id),
  FOREIGN KEY (topic_id) REFERENCES topics (id)
);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  scene_number INTEGER NOT NULL,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  duration_seconds REAL NOT NULL,
  narration TEXT NOT NULL,
  visual_objective TEXT NOT NULL,
  media_format TEXT NOT NULL,
  asset_keywords TEXT NOT NULL, -- JSON array
  visual_prompt TEXT,
  text_overlay TEXT,
  transition_intent TEXT NOT NULL,
  claim_ids TEXT NOT NULL, -- JSON array
  FOREIGN KEY (script_id) REFERENCES scripts (id)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  asset_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  provider TEXT NOT NULL,
  license TEXT NOT NULL,
  commercial_use_allowed INTEGER NOT NULL,
  attribution_required INTEGER NOT NULL,
  retrieved_at TEXT NOT NULL,
  local_path TEXT NOT NULL,
  storage_key TEXT,
  scene_number INTEGER,
  metadata TEXT NOT NULL -- JSON object
);

CREATE TABLE IF NOT EXISTS voice_narrations (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  audio_path TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  word_timestamps TEXT NOT NULL, -- JSON array
  synthesized_at TEXT NOT NULL,
  FOREIGN KEY (script_id) REFERENCES scripts (id)
);

CREATE TABLE IF NOT EXISTS renders (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  template_type TEXT NOT NULL,
  video_path TEXT NOT NULL,
  duration_seconds REAL NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  fps INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  rendered_at TEXT NOT NULL,
  FOREIGN KEY (script_id) REFERENCES scripts (id)
);

CREATE TABLE IF NOT EXISTS qa_results (
  id TEXT PRIMARY KEY,
  render_id TEXT NOT NULL,
  script_id TEXT NOT NULL,
  overall_status TEXT NOT NULL,
  factual_qa TEXT NOT NULL,    -- JSON object
  story_qa TEXT NOT NULL,      -- JSON object
  visual_qa TEXT NOT NULL,     -- JSON object
  audio_qa TEXT NOT NULL,      -- JSON object
  copyright_qa TEXT NOT NULL,  -- JSON object
  repetition_qa TEXT NOT NULL,  -- JSON object
  policy_qa TEXT NOT NULL,     -- JSON object
  recommendation TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  FOREIGN KEY (render_id) REFERENCES renders (id),
  FOREIGN KEY (script_id) REFERENCES scripts (id)
);

CREATE TABLE IF NOT EXISTS approval_events (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  director_notes TEXT,
  decided_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publishes (
  id TEXT PRIMARY KEY,
  render_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  youtube_video_id TEXT,
  privacy_status TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL, -- JSON array
  status TEXT NOT NULL,
  scheduled_time TEXT,
  published_at TEXT,
  error TEXT,
  FOREIGN KEY (render_id) REFERENCES renders (id)
);

CREATE TABLE IF NOT EXISTS analytics (
  id TEXT PRIMARY KEY,
  youtube_video_id TEXT NOT NULL,
  render_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  pillar TEXT NOT NULL,
  template_type TEXT NOT NULL,
  views INTEGER NOT NULL,
  likes INTEGER NOT NULL,
  comments INTEGER NOT NULL,
  shares INTEGER NOT NULL,
  subscribers_gained INTEGER NOT NULL,
  retention_rate REAL NOT NULL,
  average_view_duration_seconds REAL NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_runs (
  id TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  metadata TEXT NOT NULL, -- JSON object
  created_at TEXT NOT NULL
);
