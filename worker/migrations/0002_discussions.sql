-- "새 글" badge on the floor guide: when did this project's discussions last change?
ALTER TABLE projects ADD COLUMN discussion_at TEXT;
ALTER TABLE projects ADD COLUMN discussion_last TEXT;   -- JSON {number, title, by, action}
