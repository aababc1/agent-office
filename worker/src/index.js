// Agent Office Worker: serves the viewer (static assets), GitHub login, read API, WebSocket, ingest.
import { callback, login, logout } from "./auth.js";
import { discussions, floors, me, project, sessionData, ws } from "./api.js";
import { direct, webhook } from "./ingest.js";
import { json } from "./util.js";
export { Floor } from "./floor.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    try {
      if (p === "/auth/login") return login(request, env);
      if (p === "/auth/callback") return callback(request, env);
      if (p === "/auth/logout") return logout(request);
      if (p === "/api/me") return me(request, env);
      if (p === "/api/floors") return floors(request, env);
      let x;
      if ((x = /^\/api\/projects\/([^/]+)$/.exec(p))) return project(request, env, decodeURIComponent(x[1]));
      if ((x = /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)$/.exec(p))) return sessionData(request, env, decodeURIComponent(x[1]), decodeURIComponent(x[2]));
      if ((x = /^\/api\/projects\/([^/]+)\/discussions$/.exec(p))) return discussions(request, env, decodeURIComponent(x[1]), null);
      if ((x = /^\/api\/projects\/([^/]+)\/discussions\/(\d+)\/comments$/.exec(p)) && m === "POST") return discussions(request, env, decodeURIComponent(x[1]), Number(x[2]));
      if ((x = /^\/api\/projects\/([^/]+)\/discussions\/(\d+)$/.exec(p))) return discussions(request, env, decodeURIComponent(x[1]), Number(x[2]));
      if ((x = /^\/ws\/([^/]+)$/.exec(p))) return ws(request, env, decodeURIComponent(x[1]));
      if (p === "/ingest/github" && m === "POST") return webhook(request, env, ctx);
      if (p === "/ingest/events" && m === "POST") return direct(request, env);
      if (p === "/api/health") return json({ ok: true, at: new Date().toISOString() });
      if (p.startsWith("/api/") || p.startsWith("/ingest/")) return json({ error: "not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(p, e);
      return json({ error: e.message || "internal error" }, 500);
    }
  },
};
