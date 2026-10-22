// Idempotent schema catch-up, run once per isolate on the first request.
// `wrangler d1 migrations apply` is still the proper way; this exists so a dashboard-only deploy
// (no wrangler on the person's machine) does not need a console round-trip for every new column.
// Every statement is safe to re-run: CREATE IF NOT EXISTS, and ALTER ADD COLUMN whose "duplicate column" error is swallowed.
const STEPS = [
  `CREATE TABLE IF NOT EXISTS docs (project TEXT NOT NULL, path TEXT NOT NULL, size INTEGER, by TEXT, sha TEXT, updated_at TEXT, PRIMARY KEY (project, path))`,
  `ALTER TABLE projects ADD COLUMN plan_json TEXT`,
  `ALTER TABLE projects ADD COLUMN docs_json TEXT`,
  `ALTER TABLE projects ADD COLUMN drive_json TEXT`,
  `ALTER TABLE projects ADD COLUMN discussion_at TEXT`,
  `ALTER TABLE projects ADD COLUMN discussion_last TEXT`,
];
let done = null;
export function ensureSchema(env) {
  if (!done) done = (async () => {
    for (const sql of STEPS) {
      try { await env.DB.prepare(sql).run(); }
      catch (e) { if (!/duplicate column|already exists|no such table/i.test(e.message || "")) { done = null; throw e; } }   // no such table = 0001 not applied yet; diag says so
    }
  })();
  return done;
}
