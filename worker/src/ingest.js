// Two ways data gets in:
//   1. GitHub webhook (push to a data repo) → fetch the changed files with the App's installation token → D1
//      (cloud Claude sessions push to GitHub; no secret has to live inside a session container)
//   2. Direct POST /ingest/events with a per-project write token (a compute server, a Mac) → D1 at once, seconds of latency
// Both end with a broadcast to the project's Floor (WebSocket viewers).
import { hmacHex, json, nowIso, parseJSONL, text, timingSafeEqual } from "./util.js";
import { rawFile } from "./github.js";

const RE_PROGRESS = /^sessions\/([^/]+)\.progress\.json$/;
const RE_CHUNK = /^sessions\/([^/]+)\/events\.(\d{3})\.jsonl$/;
const RE_PIPE = /^pipeline\/([^/]+)\/progress\.json$/;
const RE_DOC = /^docs\/.+[^/]$/;

export async function webhook(request, env, ctx) {
  const body = await request.text();
  const sig = request.headers.get("x-hub-signature-256") || "";
  const expected = "sha256=" + await hmacHex(env.GH_WEBHOOK_SECRET || "", body);
  if (!env.GH_WEBHOOK_SECRET || !timingSafeEqual(sig, expected)) return text("bad signature", 401);
  const event = request.headers.get("x-github-event");
  if (event === "ping") return json({ ok: true, pong: true });
  if (event === "discussion" || event === "discussion_comment") {
    const p = JSON.parse(body); const repo = p.repository && p.repository.full_name;
    const project = repo ? await projectOfRepo(env, repo) : null;
    if (!project) return json({ ok: true, ignored: "unknown repo" });
    const d = p.discussion || {}; const by = (p.sender || {}).login || null;
    const last = { number: d.number, title: d.title, by, action: `${event}:${p.action}`, at: nowIso() };
    await env.DB.prepare("UPDATE projects SET discussion_at=?, discussion_last=? WHERE name=?").bind(last.at, JSON.stringify(last), project).run();
    ctx.waitUntil(broadcast(env, project, { kind: "discussion", project, ...last }));
    return json({ ok: true });
  }
  if (event !== "push") return json({ ok: true, ignored: event });
  const p = JSON.parse(body);
  const repo = p.repository && p.repository.full_name;
  const branch = p.repository && p.repository.default_branch;
  if (!repo || p.ref !== `refs/heads/${branch}`) return json({ ok: true, ignored: "not default branch" });
  const paths = new Set(); const docs = [];
  for (const c of p.commits || []) {
    for (const f of [...(c.added || []), ...(c.modified || [])]) { paths.add(f); if (RE_DOC.test(f)) docs.push({ path: f, at: c.timestamp, by: (c.author && (c.author.username || c.author.name)) || null, sha: c.id, removed: false }); }
    for (const f of c.removed || []) if (RE_DOC.test(f)) docs.push({ path: f, at: c.timestamp, sha: c.id, removed: true });
  }
  if (!paths.size && !docs.length) return json({ ok: true, ignored: "no files" });
  ctx.waitUntil((async () => {
    await processRepoPush(env, repo, p.after, [...paths].filter(f => !RE_DOC.test(f)), branch);
    if (docs.length) await applyDocs(env, repo, docs, branch);
  })().catch(e => console.error("ingest failed", repo, e.message)));
  return json({ ok: true, queued: paths.size });
}

/** docs/** inside a data repo = the floor's 자료실. Tracked from the push payload (no file fetch), listed by the viewer with GitHub links. */
export async function applyDocs(env, repo, changes, branch) {
  const project = await projectOfRepo(env, repo);
  if (!project) return;
  for (const d of changes) {
    if (d.removed) await env.DB.prepare("DELETE FROM docs WHERE project=? AND path=?").bind(project, d.path).run();
    else await env.DB.prepare(`INSERT INTO docs(project, path, by, sha, updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(project, path) DO UPDATE SET by=excluded.by, sha=excluded.sha, updated_at=excluded.updated_at`).bind(project, d.path, d.by || null, d.sha || null, d.at || nowIso()).run();
  }
  if (branch) await upsertDocsConfig(env, project, { branch });
  await broadcast(env, project, { kind: "docs", project, at: nowIso() });
}

export async function processRepoPush(env, repo, sha, paths, branch) {
  // Order matters: summary/project first (they name the project), then progress (session → project), then event chunks.
  const order = (f) => f === "summary.json" ? 0 : f === "project.json" ? 1 : f === "plan.json" ? 1 : f === "office.json" ? 1 : RE_PROGRESS.test(f) ? 2 : RE_CHUNK.test(f) ? 3 : RE_PIPE.test(f) ? 3 : 9;
  const wanted = paths.filter(f => order(f) < 9).sort((a, b) => order(a) - order(b));
  let project = await projectOfRepo(env, repo);
  const changed = { sessions: new Set(), project: false };
  for (const path of wanted) {
    const content = await rawFile(env, repo, path, sha);
    if (content == null) continue;
    if (path === "summary.json") { project = await upsertSummary(env, repo, JSON.parse(content)); changed.project = true; continue; }
    if (path === "project.json") { const pj = JSON.parse(content); project = project || pj.name; await upsertProjectMeta(env, repo, pj); changed.project = true; continue; }
    if (path === "plan.json") { const pl = JSON.parse(content); project = project || pl.project; await upsertPlan(env, repo, pl); changed.project = true; continue; }
    if (path === "office.json") { const oj = JSON.parse(content); if (project && oj.docs) await upsertDocsConfig(env, project, { ...oj.docs, branch }); changed.project = true; continue; }
    if ((m = RE_PIPE.exec(path))) { const run = JSON.parse(content); await upsertPipeline(env, run.project || project, run); changed.project = true; continue; }
    let m;
    if ((m = RE_PROGRESS.exec(path))) { const pr = JSON.parse(content); await upsertSession(env, pr.project || project, pr); changed.sessions.add(m[1]); continue; }
    if ((m = RE_CHUNK.exec(path))) { const events = parseJSONL(content); await insertEvents(env, m[1], events); changed.sessions.add(m[1]); continue; }
  }
  if (project) await broadcast(env, project, { kind: "update", project, sessions: [...changed.sessions], projectChanged: changed.project, at: nowIso() });
}

export async function direct(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const project = body.project;
  let tokens = {}; try { tokens = JSON.parse(env.PROJECT_TOKENS || "{}"); } catch { /* unset */ }
  if (!project || !token || !tokens[project] || !timingSafeEqual(token, tokens[project])) return json({ error: "bad project token" }, 401);
  const touched = new Set();
  const repoHint = body.repo || (body.plan && body.plan.repo) || null;
  if (body.summary) await upsertSummary(env, repoHint, { ...body.summary, name: project });
  if (body.progress) { await upsertSession(env, project, body.progress); touched.add(body.progress.session); }
  if (Array.isArray(body.events) && body.session) { await insertEvents(env, body.session, body.events); touched.add(body.session); }
  if (body.plan) await upsertPlan(env, repoHint, { ...body.plan, project });     // plan.docs → docs_json inside
  if (body.pipeline) await upsertPipeline(env, project, body.pipeline);
  await broadcast(env, project, { kind: "update", project, sessions: [...touched], projectChanged: !!(body.summary || body.pipeline), at: nowIso() });
  return json({ ok: true });
}

// ---- D1 writes -----------------------------------------------------------
async function projectOfRepo(env, repo) {
  const row = await env.DB.prepare("SELECT name FROM projects WHERE repo=?").bind(repo).first();
  return row ? row.name : null;
}
async function upsertSummary(env, repo, s) {
  await env.DB.prepare(`INSERT INTO projects(name, repo, description, status, last_at, emitter_at, summary_json, updated_at)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET repo=COALESCE(excluded.repo, projects.repo), description=excluded.description,
     status=excluded.status, last_at=excluded.last_at, emitter_at=excluded.emitter_at, summary_json=excluded.summary_json, updated_at=excluded.updated_at`)
    .bind(s.name, repo, s.description || null, s.status || null, s.lastAt || null, s.emitterAt || null, JSON.stringify(s), nowIso()).run();
  return s.name;
}
async function upsertProjectMeta(env, repo, pj) {
  await env.DB.prepare(`INSERT INTO projects(name, repo, description, last_at, updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET repo=COALESCE(excluded.repo, projects.repo), description=COALESCE(excluded.description, projects.description),
     last_at=COALESCE(excluded.last_at, projects.last_at), updated_at=excluded.updated_at`)
    .bind(pj.name, repo, pj.description || null, pj.lastAt || null, nowIso()).run();
}
async function upsertSession(env, project, pr) {
  await env.DB.prepare(`INSERT INTO sessions(id, project, title, status, started_at, last_at, user, event_count, progress_json, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=excluded.project, title=excluded.title, status=excluded.status,
     started_at=excluded.started_at, last_at=excluded.last_at, user=excluded.user, event_count=excluded.event_count,
     progress_json=excluded.progress_json, updated_at=excluded.updated_at`)
    .bind(pr.session, project, pr.title || null, pr.status || null, pr.startedAt || null, pr.lastAt || null, pr.user || null,
          (pr.events && pr.events.count) || 0, JSON.stringify(pr), nowIso()).run();
}
async function insertEvents(env, session, events) {
  const stmt = env.DB.prepare(`INSERT INTO events(session, seq, t, actor, kind, tool, room, caption, ref, dur_ms, meta_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session, seq) DO NOTHING`);
  const batch = events.filter(e => e && Number.isInteger(e.seq) && e.t && e.actor && e.kind)
    .map(e => stmt.bind(session, e.seq, e.t, e.actor, e.kind, e.tool || null, e.room || null, e.caption || null, e.ref || null,
                        e.dur_ms == null ? null : e.dur_ms, e.meta ? JSON.stringify(e.meta) : null));
  for (let i = 0; i < batch.length; i += 100) await env.DB.batch(batch.slice(i, i + 100));
}
async function upsertPlan(env, repo, plan) {
  await env.DB.prepare(`INSERT INTO projects(name, repo, description, plan_json, updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET repo=COALESCE(excluded.repo, projects.repo), description=COALESCE(projects.description, excluded.description),
     plan_json=excluded.plan_json, updated_at=excluded.updated_at`)
    .bind(plan.project, repo || plan.repo || null, plan.description || null, JSON.stringify(plan), nowIso()).run();
  if (plan.docs) await upsertDocsConfig(env, plan.project, plan.docs);
}
/** Merge document settings (Drive folder, pinned links, default branch) into projects.docs_json. */
export async function upsertDocsConfig(env, project, cfg) {
  const row = await env.DB.prepare("SELECT docs_json FROM projects WHERE name=?").bind(project).first();
  if (!row) return;
  let cur = {}; try { cur = row.docs_json ? JSON.parse(row.docs_json) : {}; } catch { cur = {}; }
  const next = { ...cur };
  for (const [k, v] of Object.entries(cfg || {})) if (v !== undefined && v !== null) next[k] = v;
  await env.DB.prepare("UPDATE projects SET docs_json=?, updated_at=? WHERE name=?").bind(JSON.stringify(next), nowIso(), project).run();
}
async function upsertPipeline(env, project, run) {
  await env.DB.prepare(`INSERT INTO pipeline_runs(id, project, started_at, last_at, status, progress_json, updated_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET last_at=excluded.last_at, status=excluded.status, progress_json=excluded.progress_json, updated_at=excluded.updated_at`)
    .bind(run.id, project, run.startedAt || null, run.lastAt || null, run.status || null, JSON.stringify(run), nowIso()).run();
}

export async function broadcast(env, project, payload) {
  const stub = env.FLOOR.get(env.FLOOR.idFromName(project));
  await stub.fetch("https://floor/broadcast", { method: "POST", body: JSON.stringify(payload) });
}
