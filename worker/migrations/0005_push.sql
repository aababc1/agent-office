-- Web Push per floor: VAPID keys (settings), device subscriptions, per-(person, floor) kinds, event memory, log.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs (id TEXT PRIMARY KEY, login TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ua TEXT, created_at TEXT, last_ok TEXT, fails INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS push_subs_login ON push_subs(login);
CREATE TABLE IF NOT EXISTS push_prefs (login TEXT NOT NULL, project TEXT NOT NULL, kinds_json TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (login, project));
CREATE TABLE IF NOT EXISTS notify_state (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (project, key));
CREATE TABLE IF NOT EXISTS notify_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, kind TEXT, title TEXT, body TEXT, sent INTEGER, at TEXT);
