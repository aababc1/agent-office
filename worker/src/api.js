// Read API for the viewer. Every project read is gated by canRead(session, project.repo).
import { canRead, getSession, unauthorized } from "./auth.js";
import { json } from "./util.js";
import * as disc from "./discussions.js";

const withCookie = (res, setCookie) => { if (!setCookie) return res; const r = new Response(res.body, res); r.headers.append("set-cookie", setCookie); return r; };

export async function me(request, env) {
  const { session, setCookie } = await getSession(request, env);
  if (!session) return withCookie(unauthorized(), setCookie);
  return withCookie(json({ login: session.login, avatar: session.avatar }), setCookie);
}

export async function floors(request, env) {
  const { session, setCookie } = await getSession(request, env);
  if (!session) return withCookie(unauthorized(), setCookie);
  const rows = (await env.DB.prepare("SELECT name, repo, description, status, last_at, emitter_at, summary_json, discussion_at, discussion_last FROM projects ORDER BY last_at DESC").all()).results || [];
  const out = [];
  for (const r of rows) {
    const ok = await canRead(env, session, r.repo);
    if (!ok) { out.push({ name: r.name, locked: true }); continue; }
    const s = r.summary_json ? JSON.parse(r.summary_json) : {};
    out.push({ name: r.name, repo: r.repo, description: r.description, lastAt: r.last_at, emitterAt: r.emitter_at,
               sessions: (s.sessions || {}).total || 0, active: (s.sessions || {}).active || 0,
               latest: (s.sessions || {}).latest || null, alerts: s.alerts || [], progress: s.progress || null, pipeline: s.pipeline || null,
               discussionAt: r.discussion_at || null, discussionLast: r.discussion_last ? JSON.parse(r.discussion_last) : null });
  }
  return withCookie(json({ floors: out }), setCookie);
}

async function gate(request, env, name) {
  const { session, setCookie } = await getSession(request, env);
  if (!session) return { deny: withCookie(unauthorized(), setCookie) };
  const p = await env.DB.prepare("SELECT name, repo, description, last_at FROM projects WHERE name=?").bind(name).first();
  if (!p) return { deny: withCookie(json({ error: "no such project" }, 404), setCookie) };
  if (!(await canRead(env, session, p.repo))) return { deny: withCookie(json({ error: "not a collaborator" }, 403), setCookie) };
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

// ---- discussions (GitHub Discussions on the data repo, with the person's own token)
export async function discussions(request, env, name, number) {
  const g = await gate(request, env, name); if (g.deny) return g.deny;
  const repo = g.project.repo; if (!repo) return withCookie(json({ error: "project has no repo" }, 409), g.setCookie);
  const body = request.method === "POST" ? await request.json().catch(() => null) : null;
  try {
    if (number == null) return withCookie(request.method === "POST" ? await disc.create(env, g.session, repo, body) : await disc.list(env, g.session, repo), g.setCookie);
    return withCookie(request.method === "POST" ? await disc.comment(env, g.session, repo, number, body) : await disc.one(env, g.session, repo, number), g.setCookie);
  } catch (e) { return withCookie(json({ error: e.message }, 502), g.setCookie); }
}
