-- 자료실: files under docs/ in a data repo (tracked from push webhooks + resync) and per-project document links.
CREATE TABLE IF NOT EXISTS docs (
  project    TEXT NOT NULL,
  path       TEXT NOT NULL,              -- docs/<...> inside the data repo
  size       INTEGER,
  by         TEXT,                       -- GitHub login (or name) of the last commit touching it
  sha        TEXT,                       -- last commit
  updated_at TEXT,
  PRIMARY KEY (project, path)
);
ALTER TABLE projects ADD COLUMN docs_json TEXT;   -- {"drive": "<folder url>", "links": [{"name","url"}], "branch": "main"}
ALTER TABLE projects ADD COLUMN drive_json TEXT;  -- cached Google Drive folder listing {"folder","at","files":[…],"error"}
