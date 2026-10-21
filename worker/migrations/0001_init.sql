-- Agent Office — D1 schema v1
-- One row per project (= one data repo); sessions and events mirror the data repo files.

CREATE TABLE IF NOT EXISTS projects (
  name         TEXT PRIMARY KEY,
  repo         TEXT UNIQUE,              -- owner/name of the data repo (membership source of truth)
  description  TEXT,
  status       TEXT,                     -- active | idle | empty
  last_at      TEXT,
  emitter_at   TEXT,
  summary_json TEXT,                     -- summary.json verbatim
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  title         TEXT,
  status        TEXT,
  started_at    TEXT,
  last_at       TEXT,
  user          TEXT,
  event_count   INTEGER DEFAULT 0,
  progress_json TEXT,                    -- progress.json verbatim
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_project_last ON sessions(project, last_at DESC);

CREATE TABLE IF NOT EXISTS events (
  session  TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  t        TEXT NOT NULL,
  actor    TEXT NOT NULL,
  kind     TEXT NOT NULL,
  tool     TEXT,
  room     TEXT,
  caption  TEXT,
  ref      TEXT,
  dur_ms   INTEGER,
  meta_json TEXT,
  PRIMARY KEY (session, seq)
);

-- (repo, login) → can this person read the repo? Checked against GitHub, cached 10 minutes.
CREATE TABLE IF NOT EXISTS members_cache (
  repo       TEXT NOT NULL,
  login      TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (repo, login)
);

-- Pipeline runs (KBDS / Nextflow) land here in v2; the column exists so the API shape is stable.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id            TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  started_at    TEXT,
  last_at       TEXT,
  status        TEXT,
  progress_json TEXT,
  updated_at    TEXT NOT NULL
);
