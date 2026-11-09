// Read API for the viewer. Every project read is gated by canRead(session, project.repo).
import { canRead, getSession, memberRole, unauthorized } from "./auth.js";
import { createAppFolder, driveEnabled, driveListing, ensureSubfolder, fileMeta, folderIdOf, listFolder, saEmail, saToken, share, startUpload, topicFolderName, uploadSmall } from "./gdrive.js";
import { googleAccount, googleDisconnect, googleEnabled, ownerToken } from "./google.js";
import { upsertDocsConfig } from "./ingest.js";
import { detectDocsEvents } from "./push.js";
import { nowIso } from "./util.js";
import { recentNotifications } from "./push.js";
import { json, timingSafeEqual } from "./util.js";
import * as disc from "./discussions.js";

const withCookie = (res, setCookie) => { if (!setCookie) return res; const r = new Response(res.body, res); r.headers.append("set-cookie", setCookie); return r; };

export async function me(request, env) {
  const { session, setCookie } = await getSession(request, env);
  if (!session) return withCookie(unauthorized(), setCookie);
  return withCookie(json({ login: session.login, avatar: session.avatar, admin: session.login === env.ADMIN_LOGIN }), setCookie);
}

/** One project may have a probe per site (local, kbds, …). Merge their latest stage reports into one picture. */
export async function mergedPipeline(env, name) {
  const rows = (await env.DB.prepare("SELECT id, status, last_at, progress_json, updated_at FROM pipeline_runs WHERE project=? ORDER BY updated_at DESC LIMIT 10").bind(name).all()).results || [];
  if (!rows.length) return null;
  const stages = {}; let running = 0, failed = 0, lastAt = null, probedAt = null; const sites = [];
  for (const r of rows) {
    const p = r.progress_json ? JSON.parse(r.progress_json) : {};
    sites.push({ id: r.id, site: p.site || r.id, probedAt: p.probedAt || r.updated_at, status: r.status, canSubmit: (p.cluster || {}).canSubmit ?? null });
    for (const [k, v] of Object.entries(p.stages || {})) if (!stages[k] || (v.updatedAt || "") > (stages[k].updatedAt || "")) stages[k] = { ...v, site: p.site || r.id };
    if (p.rollup) { running += p.rollup.running || 0; failed += p.rollup.failed || 0; }
    if (p.lastAt && (!lastAt || p.lastAt > lastAt)) lastAt = p.lastAt;
    if ((p.probedAt || r.updated_at) > (probedAt || "")) probedAt = p.probedAt || r.updated_at;
  }
  const total = Object.values(stages).reduce((a, s) => a + (s.total || 0), 0);
  const done = Object.values(stages).reduce((a, s) => a + (s.total ? (s.done || 0) : 0), 0);
  const etas = Object.values(stages).map(s => (s.eta && s.eta.hours) || 0);
  return { run: rows[0].id, sites, status: running ? "running" : "idle", lastAt, probedAt, done, total, ratio: total ? Math.round(done / total * 1000) / 1000 : null,
           running, failed, etaHours: etas.length ? Math.max(...etas) : null, stages };
}

export async function floors(request, env) {
  const { session, setCookie } = await getSession(request, env);
  if (!session) return withCookie(unauthorized(), setCookie);
  const rows = (await env.DB.prepare("SELECT name, repo, description, status, last_at, emitter_at, summary_json, discussion_at, discussion_last, docs_json, drive_json, (plan_json IS NOT NULL) AS has_plan FROM projects ORDER BY last_at DESC").all()).results || [];
  const docsAt = {}; for (const d of (await env.DB.prepare("SELECT project, MAX(updated_at) AS at, COUNT(*) AS n FROM docs GROUP BY project").all()).results || []) docsAt[d.project] = { at: d.at, n: d.n };
  const out = [];
  for (const r of rows) {
    const role = await memberRole(env, session, r.repo);
    if (!role) { out.push({ name: r.name, locked: true }); continue; }
    const s = r.summary_json ? JSON.parse(r.summary_json) : {};
    const pipe = await mergedPipeline(env, r.name);
    out.push({ name: r.name, repo: r.repo, role, description: r.description, lastAt: r.last_at || (pipe && pipe.lastAt) || null, emitterAt: r.emitter_at || (pipe && pipe.probedAt) || null,
               sessions: (s.sessions || {}).total || 0, active: (s.sessions || {}).active || 0,
               latest: (s.sessions || {}).latest || null, alerts: s.alerts || [], progress: s.progress || null, pipeline: pipe ? { run: pipe.run, status: pipe.status, lastAt: pipe.lastAt, done: pipe.done, total: pipe.total, ratio: pipe.ratio, running: pipe.running, failed: pipe.failed, etaHours: pipe.etaHours, sites: pipe.sites } : (s.pipeline || null),
               discussionAt: r.discussion_at || null, discussionLast: r.discussion_last ? JSON.parse(r.discussion_last) : null, hasPlan: !!r.has_plan,
               ...docsBadge(r, docsAt[r.name]) });
  }
  return withCookie(json({ floors: out }), setCookie);
}

/** The per-project write token (PROJECT_TOKENS) may also read that one project — for scripts and the compute server itself. */
function tokenSession(request, env, name) {
  const auth = request.headers.get("authorization") || ""; const tok = auth.replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  let tokens = {}; try { tokens = JSON.parse(env.PROJECT_TOKENS || "{}"); } catch { return null; }
  return tokens[name] && timingSafeEqual(tok, tokens[name]) ? { login: `token:${name}`, token: true } : null;
}
async function gate(request, env, name) {
  const t = tokenSession(request, env, name);
  const { session, setCookie } = t ? { session: t, setCookie: null } : await getSession(request, env);
  if (!session) return { deny: withCookie(unauthorized(), setCookie) };
  const p = await env.DB.prepare("SELECT name, repo, description, last_at FROM projects WHERE name=?").bind(name).first();
  if (!p) return { deny: withCookie(json({ error: "no such project" }, 404), setCookie) };
  if (!session.token && !(await canRead(env, session, p.repo))) return { deny: withCookie(json({ error: "not a collaborator" }, 403), setCookie) };
  return { session, setCookie, project: p };
}

export async function project(request, env, name) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  const rows = (await env.DB.prepare("SELECT id, title, status, started_at, last_at, user, event_count, progress_json FROM sessions WHERE project=? ORDER BY last_at DESC LIMIT 200").bind(name).all()).results || [];
  const sessions = rows.map(r => { const pr = r.progress_json ? JSON.parse(r.progress_json) : {};
    return { session: r.id, title: r.title, status: r.status, startedAt: r.started_at, lastAt: r.last_at, user: r.user, progress: pr.progress || null, counters: pr.counters || null, last: (pr.last || {}).caption || null }; });
  return withCookie(json({ v: 1, name: g.project.name, description: g.project.description, lastAt: g.project.last_at, sessions }), g.setCookie);
}

export async function sessionData(request, env, name, id) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  const since = Number(new URL(request.url).searchParams.get("since") ?? -1);
  const row = await env.DB.prepare("SELECT progress_json FROM sessions WHERE id=? AND project=?").bind(id, name).first();
  if (!row) return withCookie(json({ error: "no such session" }, 404), g.setCookie);
  const evs = (await env.DB.prepare("SELECT seq, t, actor, kind, tool, room, caption, ref, dur_ms, meta_json FROM events WHERE session=? AND seq>? ORDER BY seq LIMIT 5000").bind(id, since).all()).results || [];
  const events = evs.map(e => { const o = { v: 1, seq: e.seq, t: e.t, ses: id, actor: e.actor, kind: e.kind };
    if (e.tool) o.tool = e.tool; if (e.room) o.room = e.room; if (e.caption) o.caption = e.caption; if (e.ref) o.ref = e.ref;
    if (e.dur_ms != null) o.dur_ms = e.dur_ms; if (e.meta_json) o.meta = JSON.parse(e.meta_json); return o; });
  return withCookie(json({ progress: JSON.parse(row.progress_json || "{}"), events, more: events.length === 5000 }), g.setCookie);
}

export async function ws(request, env, name) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  if (request.headers.get("upgrade") !== "websocket") return json({ error: "websocket upgrade expected" }, 426);
  const stub = env.FLOOR.get(env.FLOOR.idFromName(name));
  return stub.fetch(request);
}

/** docsAt/docsN for the floor guide: newest of GitHub docs/ and the cached Drive listing. */
function docsBadge(r, gh) {
  let at = (gh || {}).at || null, n = (gh || {}).n || 0, hasDrive = false;
  try { hasDrive = !!(r.docs_json && (JSON.parse(r.docs_json) || {}).drive); } catch { /* bad json */ }
  try { const d = r.drive_json ? JSON.parse(r.drive_json) : null; if (d && Array.isArray(d.files)) { const files = d.files.filter(f => !f.dir); n += files.length; const m = files.map(f => f.modifiedAt || "").sort().pop(); if (m && (!at || m > at)) at = m; } } catch { /* bad json */ }
  return { docsAt: at, docsN: n, hasDrive };
}

// ---- 자료실 업로드 ------------------------------------------------------------------------------------------------
// Two ways a floor can take uploads from any collaborator (Read on the data repo is enough):
//   owner mode — the floor owner connected a Google account (/auth/google); the Worker creates files with THAT account
//                (owner = owner, quota = owner's) inside an app-made folder in the owner's My Drive (docs_json.appFolder);
//   sa mode    — the floor folder is in a Shared Drive where the service account is a member (quota belongs to the drive).
//   POST …/drive/status           → who/where uploads go, for the 자료실 header
//   POST …/drive/connect-folder   (owner) make "<project> 자료실" in the owner's Drive, share it read-only with the service account (listing)
//   POST …/drive/disconnect       (owner) forget the Google account
//   POST …/drive/upload   {name, mime, size, topic?} → {sessionUri, folder}: the browser PUTs the bytes straight to Google
//   POST …/drive/upload?proxy=1   raw body ≤ 90 MB → {file}: fallback when the browser cannot reach Google
//   POST …/drive/uploaded {id}    → confirm, refresh listing, ring "새 자료"
//   POST …/drive/folder   {topic} → the topic's sub-folder "#n 제목" (created on demand)
//   POST …/drive/member   (owner) {email, role} | {anyone: true} → share the upload folder
export async function driveUpload(request, env, name, step) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  const row = await env.DB.prepare("SELECT docs_json FROM projects WHERE name=?").bind(name).first();
  let cfg = {}; try { cfg = row && row.docs_json ? JSON.parse(row.docs_json) : {}; } catch { cfg = {}; }
  const url = new URL(request.url); const isAdmin = async () => (await memberRole(env, g.session, g.project.repo)) === "admin";
  const acct = googleEnabled(env) ? await googleAccount(env, name) : null;
  // where uploads go
  let mode = null, fid = null, token = null;
  if (acct && cfg.appFolder && cfg.appFolder.id) { mode = "owner"; fid = cfg.appFolder.id; }
  else if (driveEnabled(env) && folderIdOf(cfg.drive)) { mode = "sa"; fid = folderIdOf(cfg.drive); }
  const reply = (o, st = 200) => withCookie(json(o, st), g.setCookie);
  try {
    if (step === "status") return reply({ google: { enabled: googleEnabled(env), account: acct }, appFolder: cfg.appFolder || null, saEmail: saEmail(env), mode, legacyDrive: cfg.drive || null });
    if (step === "disconnect") { if (!(await isAdmin())) return reply({ error: "소유자만" }, 403); await googleDisconnect(env, name); return reply({ ok: true }); }
    if (step === "connect-folder") {
      if (!(await isAdmin())) return reply({ error: "소유자만" }, 403);
      if (!acct) return reply({ error: "먼저 Google 계정을 연결하세요" }, 400);
      const t = await ownerToken(env, name);
      const folder = await createAppFolder(env, t, `${name} 자료실`);
      const sa = saEmail(env); let shared = false; if (sa) { try { await share(env, t, folder.id, { email: sa, role: "reader" }); shared = true; } catch (e) { folder.shareError = e.message; } }
      await upsertDocsConfig(env, name, { appFolder: { ...folder, by: acct.email, at: nowIso(), saShared: shared } });
      return reply({ ok: true, appFolder: folder, saShared: shared });
    }
    if (!mode) return reply({ error: acct ? "자료실 폴더가 아직 없습니다 — '폴더 만들기'를 누르세요" : "업로드 경로가 없습니다: 소유자가 Google 계정을 연결하거나(자료실 → Google 연결) 폴더가 공유 드라이브여야 합니다" }, 400);
    if (mode === "owner") token = await ownerToken(env, name);
    const topicFolder = async t => (t && (t.number || t.title)) ? ensureSubfolder(env, fid, topicFolderName(t.number, t.title), token) : null;
    const listUrl = mode === "owner" ? cfg.appFolder.url : cfg.drive;
    if (step === "member") {
      if (!(await isAdmin())) return reply({ error: "소유자만 멤버를 추가할 수 있습니다" }, 403);
      const body = await request.json().catch(() => ({})); const role = ["reader", "commenter", "writer"].includes(body.role) ? body.role : "reader";
      if (body.anyone) return reply({ ok: true, permission: await share(env, token, fid, { anyone: true, role: "reader" }) });
      const email = String(body.email || "").trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply({ error: "이메일 형식이 아닙니다" }, 400);
      return reply({ ok: true, permission: await share(env, token, fid, { email, role }) });
    }
    if (step === "upload" && url.searchParams.has("proxy")) {
      const fname = decodeURIComponent(request.headers.get("x-file-name") || "upload.bin"); const len = Number(request.headers.get("content-length") || 0);
      if (len > 90 * 1024 * 1024) return reply({ error: "90 MB까지만 서버 경유 업로드가 됩니다" }, 413);
      const tf = await topicFolder({ number: url.searchParams.get("topic_n"), title: url.searchParams.get("topic") });
      const file = await uploadSmall(env, tf ? tf.id : fid, { name: fname, mime: request.headers.get("content-type"), token }, await request.arrayBuffer());
      await afterUpload(env, name, listUrl, token); return reply({ file: slim(file), folder: tf });
    }
    const body = await request.json().catch(() => ({}));
    if (step === "upload") {
      if (!body.name) return reply({ error: "name missing" }, 400);
      const tf = await topicFolder(body.topic);
      return reply({ sessionUri: await startUpload(env, tf ? tf.id : fid, { name: String(body.name).slice(0, 200), mime: body.mime, size: Number(body.size) || 0, origin: request.headers.get("origin") || url.origin, token }), folder: tf });
    }
    if (step === "folder") { const tf = await topicFolder(body.topic); const root = await fileMeta(env, fid, token); return reply({ folder: tf, root: { id: root.id, name: root.name, driveId: root.driveId || null, sharedDrive: !!root.driveId }, mode }); }
    if (step === "uploaded") {
      if (!body.id) return reply({ error: "id missing" }, 400);
      const file = await fileMeta(env, body.id, token); const parent = (file.parents || [])[0];
      const inside = parent === fid || (parent && ((await fileMeta(env, parent, token).catch(() => ({}))).parents || []).includes(fid));
      if (!inside) return reply({ error: "그 파일은 이 층의 폴더에 없습니다" }, 400);
      await afterUpload(env, name, listUrl, token); return reply({ file: slim(file) });
    }
    return reply({ error: "unknown step" }, 404);
  } catch (e) { return reply({ error: e.message }, 502); }
}
// GET …/drive/file/<id>[?dl=1] — the file's bytes through the Worker (service account first, then the owner's token), so a
// participant opens/downloads it with just the GitHub login: no Google account needed. Google Docs/Sheets/Slides come out as PDF.
// Only files inside the floor's folders (app folder / office.json folder, one level of sub-folders) are served.
export async function driveFile(request, env, name, id) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  const row = await env.DB.prepare("SELECT docs_json FROM projects WHERE name=?").bind(name).first();
  let cfg = {}; try { cfg = row && row.docs_json ? JSON.parse(row.docs_json) : {}; } catch { cfg = {}; }
  const roots = new Set([cfg.appFolder && cfg.appFolder.id, folderIdOf(cfg.drive)].filter(Boolean)); if (!roots.size) return withCookie(json({ error: "no drive folder" }, 404), g.setCookie);
  const dl = new URL(request.url).searchParams.has("dl"); const API = (env.GDRIVE_API_BASE || "https://www.googleapis.com").replace(/\/$/, "");
  const tokens = []; if (driveEnabled(env)) { try { tokens.push(await saToken(env)); } catch { /* no sa */ } } if (googleEnabled(env) && await googleAccount(env, name)) { try { tokens.push(await ownerToken(env, name)); } catch { /* not connected */ } }
  let last = "no token";
  for (const token of tokens) {
    const H = { authorization: `Bearer ${token}` };
    const mr = await fetch(`${API}/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,mimeType,size,parents`, { headers: H }); if (!mr.ok) { last = `meta ${mr.status}`; continue; }
    const m = await mr.json(); const parent = (m.parents || [])[0];
    let inside = roots.has(parent);
    if (!inside && parent) { const pr = await fetch(`${API}/drive/v3/files/${encodeURIComponent(parent)}?supportsAllDrives=true&fields=parents`, { headers: H }); if (pr.ok) inside = ((await pr.json()).parents || []).some(p => roots.has(p)); }
    if (!inside) return withCookie(json({ error: "이 층의 폴더 밖 파일" }, 403), g.setCookie);
    const gdoc = /^application\/vnd\.google-apps\./.test(m.mimeType || "") && m.mimeType !== "application/vnd.google-apps.folder";
    const url = gdoc ? `${API}/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=application/pdf` : `${API}/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
    const r = await fetch(url, { headers: H }); if (!r.ok) { last = `media ${r.status}`; continue; }
    const h = new Headers(); const ct = gdoc ? "application/pdf" : (r.headers.get("content-type") || m.mimeType || "application/octet-stream"); h.set("content-type", ct);
    if (r.headers.get("content-length")) h.set("content-length", r.headers.get("content-length"));
    const fname = gdoc ? `${m.name}.pdf` : m.name; h.set("content-disposition", `${dl ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(fname)}`);
    h.set("cache-control", "private, max-age=300"); h.set("x-content-type-options", "nosniff"); if (g.setCookie) h.append("set-cookie", g.setCookie);
    return new Response(r.body, { status: 200, headers: h });
  }
  return withCookie(json({ error: `파일을 읽지 못했습니다 (${last}) — 폴더가 서비스 계정에 공유돼 있는지 확인` }, 404), g.setCookie);
}
const slim = f => ({ id: f.id, name: f.name, mime: f.mimeType, size: f.size ? Number(f.size) : null, modifiedAt: f.modifiedTime, url: f.webViewLink || `https://drive.google.com/open?id=${f.id}` });
async function afterUpload(env, name, driveUrl, token) { const d = await driveListing(env, name, driveUrl, { force: true, token }); if (!d.error) await detectDocsEvents(env, name, d.files, "drive"); }

// ---- 자료실: docs/** of the data repo (tracked from pushes) + Drive (app folder and/or the office.json folder) / pinned links
export async function docs(request, env, name) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  const row = await env.DB.prepare("SELECT docs_json FROM projects WHERE name=?").bind(name).first();
  let cfg = {}; try { cfg = row && row.docs_json ? JSON.parse(row.docs_json) : {}; } catch { cfg = {}; }
  const repo = g.project.repo; const branch = cfg.branch || "main"; const force = new URL(request.url).searchParams.has("refresh");
  const acct = googleEnabled(env) ? await googleAccount(env, name) : null;
  const app = acct && cfg.appFolder && cfg.appFolder.id ? cfg.appFolder : null;
  // primary listing: the app folder (owner mode) else the office.json folder; a differing office.json folder is listed too, marked legacy
  let token = null; if (app && !driveEnabled(env)) { try { token = await ownerToken(env, name); } catch { token = null; } }
  const primaryUrl = app ? app.url : cfg.drive;
  const drive = primaryUrl ? await driveListing(env, name, primaryUrl, { force, token }) : null;
  let legacy = null; if (app && cfg.drive && folderIdOf(cfg.drive) !== app.id && driveEnabled(env)) { try { legacy = { files: await listFolder(env, folderIdOf(cfg.drive)) }; } catch (e) { legacy = { files: [], error: e.message }; } }
  const files = ((await env.DB.prepare("SELECT path, size, by, sha, updated_at FROM docs WHERE project=? ORDER BY updated_at DESC, path").bind(name).all()).results || [])
    .map(d => ({ path: d.path, name: d.path.replace(/^docs\//, ""), size: d.size, by: d.by, updatedAt: d.updated_at,
                 url: repo ? `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${d.path.split("/").map(encodeURIComponent).join("/")}` : null }));
  const clean = u => u ? String(u).replace(/\/drive\/u\/\d+\//, "/drive/") : null;   // "/u/2/" is the author's account slot; others open it with their own
  const mode = app ? "owner" : (driveEnabled(env) && folderIdOf(cfg.drive) ? "sa" : null);
  return withCookie(json({ drive: clean(primaryUrl), legacyDrive: app ? clean(cfg.drive) : null, legacyFiles: legacy ? legacy.files : [], legacyError: legacy ? legacy.error : null,
                           driveEnabled: driveEnabled(env) || !!token, driveFiles: drive ? drive.files : [], driveAt: drive ? drive.at : null, driveError: drive ? drive.error : null,
                           upload: { mode, email: acct ? acct.email : null, folder: app ? app.name : null }, google: { enabled: googleEnabled(env), account: acct }, appFolder: app,
                           links: Array.isArray(cfg.links) ? cfg.links : [], branch, repo,
                           uploadUrl: repo ? `https://github.com/${repo}/upload/${encodeURIComponent(branch)}/docs` : null,
                           folderUrl: repo ? `https://github.com/${repo}/tree/${encodeURIComponent(branch)}/docs` : null, files }), g.setCookie);
}

export async function notifications(request, env, name) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  return withCookie(json({ notifications: await recentNotifications(env, name) }), g.setCookie);
}

// ---- discussions (GitHub Discussions on the data repo, with the person's own token)
export async function discussions(request, env, name, number) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  if (g.session.token) return json({ error: "discussions need a GitHub login (they are read and written as you)" }, 403);
  const repo = g.project.repo; if (!repo) return withCookie(json({ error: "project has no repo" }, 409), g.setCookie);
  const body = request.method === "POST" ? await request.json().catch(() => null) : null;
  try {
    if (number == null) return withCookie(request.method === "POST" ? await disc.create(env, g.session, repo, body) : await disc.list(env, g.session, repo), g.setCookie);
    return withCookie(request.method === "POST" ? await disc.comment(env, g.session, repo, number, body) : await disc.one(env, g.session, repo, number), g.setCookie);
  } catch (e) { return withCookie(json({ error: e.message }, 502), g.setCookie); }
}

// ---- plan + pipeline (compute-site progress)
export async function plan(request, env, name) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  const row = await env.DB.prepare("SELECT plan_json FROM projects WHERE name=?").bind(name).first();
  return withCookie(json(row && row.plan_json ? JSON.parse(row.plan_json) : { project: name, stages: [] }), g.setCookie);
}
export async function pipeline(request, env, name) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  const rows = (await env.DB.prepare("SELECT id, status, started_at, last_at, progress_json, updated_at FROM pipeline_runs WHERE project=? ORDER BY last_at DESC LIMIT 10").bind(name).all()).results || [];
  const runs = rows.map(r => ({ id: r.id, status: r.status, startedAt: r.started_at, lastAt: r.last_at, updatedAt: r.updated_at, ...(r.progress_json ? JSON.parse(r.progress_json) : {}) }));
  return withCookie(json({ runs, merged: await mergedPipeline(env, name) }), g.setCookie);
}
