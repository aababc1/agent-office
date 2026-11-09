-- The floor owner's Google account (OAuth, scope drive.file): uploads through the app are made with it.
CREATE TABLE IF NOT EXISTS google_accounts (project TEXT PRIMARY KEY, login TEXT NOT NULL, email TEXT, refresh_token TEXT NOT NULL, access_token TEXT, expires_at INTEGER, scope TEXT, updated_at TEXT);
