// Agent Office Worker: serves the viewer (static assets), GitHub login, read API, WebSocket, ingest.
import { callback, login, logout } from "./auth.js";
import { discussions, docs, floors, me, notifications, pipeline, plan, project, sessionData, ws } from "./api.js";
import { direct, webhook } from "./ingest.js";
import { json } from "./util.js";
import { diag, resync } from "./admin.js";
import { ensureSchema } from "./schema.js";
import { checkLostProbes, detectDocsEvents, pushApi } from "./push.js";
import { getSession, canRead } from "./auth.js";
import { driveListing } from "./gdrive.js";
export { Floor } from "./floor.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    try {
      if (p.startsWith("/api/") || p.startsWith("/ingest/") || p.startsWith("/ws/")) await ensureSchema(env);   // once per isolate; idempotent
      if (p === "/auth/login") return login(request, env);
      if (p === "/auth/callback") return callback(request, env);
      if (p === "/auth/logout") return logout(request);
      if (p === "/api/me") return me(request, env);
      if (p === "/api/floors") return floors(request, env);
      let x;
      if ((x = /^\/api\/projects\/([^/]+)$/.exec(p))) return project(request, env, decodeURIComponent(x[1]));
      if ((x = /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)$/.exec(p))) return sessionData(request, env, decodeURIComponent(x[1]), decodeURIComponent(x[2]));
      if ((x = /^\/api\/projects\/([^/]+)\/plan$/.exec(p))) return plan(request, env, decodeURIComponent(x[1]));
      if ((x = /^\/api\/projects\/([^/]+)\/pipeline$/.exec(p))) return pipeline(request, env, decodeURIComponent(x[1]));
      if ((x = /^\/api\/projects\/([^/]+)\/docs$/.exec(p))) return docs(request, env, decodeURIComponent(x[1]));
      if ((x = /^\/api\/projects\/([^/]+)\/notifications$/.exec(p))) return notifications(request, env, decodeURIComponent(x[1]));
      if ((x = /^\/api\/projects\/([^/]+)\/discussions$/.exec(p))) return discussions(request, env, decodeURIComponent(x[1]), null);
      if ((x = /^\/api\/projects\/([^/]+)\/discussions\/(\d+)\/comments$/.exec(p)) && m === "POST") return discussions(request, env, decodeURIComponent(x[1]), Number(x[2]));
      if ((x = /^\/api\/projects\/([^/]+)\/discussions\/(\d+)$/.exec(p))) return discussions(request, env, decodeURIComponent(x[1]), Number(x[2]));
      if ((x = /^\/ws\/([^/]+)$/.exec(p))) return ws(request, env, decodeURIComponent(x[1]));
      if (p === "/ingest/github" && m === "POST") return webhook(request, env, ctx);
      if (p === "/ingest/events" && m === "POST") return direct(request, env);
      if (p.startsWith("/api/push/")) {
        const { session } = await getSession(request, env); if (!session) return json({ error: "sign in required", login: "/auth/login" }, 401);
        return pushApi(request, env, p, session, async (name) => { const r = await env.DB.prepare("SELECT repo FROM projects WHERE name=?").bind(name).first(); return !!r && await canRead(env, session, r.repo); });
      }
      if (p === "/api/admin/diag") return diag(request, env);
      if (p === "/api/admin/resync") return resync(request, env);
      if (p === "/api/health") return json({ ok: true, at: new Date().toISOString() });
      if (p.startsWith("/api/") || p.startsWith("/ingest/")) return json({ error: "not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(p, e);
      return json({ error: e.message || "internal error" }, 500);
    }
  },
  // Cron (wrangler.toml [triggers]): probes silent for 2h, new Drive files.
  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    await checkLostProbes(env).catch(e => console.error("cron probes", e.message));
    const rows = (await env.DB.prepare("SELECT name, docs_json FROM projects WHERE docs_json IS NOT NULL").all()).results || [];
    for (const r of rows) {
      try { const cfg = JSON.parse(r.docs_json); if (cfg.drive && env.GDRIVE_SA_KEY) { const d = await driveListing(env, r.name, cfg.drive, { maxAgeMs: 10 * 60e3 }); if (!d.error) await detectDocsEvents(env, r.name, d.files, "drive"); } }
      catch (e) { console.error("cron drive", r.name, e.message); }
    }
  },
};
