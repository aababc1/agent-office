// GitHub login for viewers. The person's GitHub token never reaches the browser: it lives inside an
// HttpOnly signed cookie and is only used server-side to answer "can this person read repo X?".
import { cookie, json, randomHex, readCookie, signJwt, text, verifyJwt } from "./util.js";
import { userCanRead, userProfile } from "./github.js";

const COOKIE = "office";
const STATE = "office_state";

async function exchange(env, body) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "agent-office-worker" },
    body: JSON.stringify({ client_id: env.GH_CLIENT_ID, client_secret: env.GH_CLIENT_SECRET, ...body }),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error_description || data.error || `github ${r.status}`);
  return data;
}

export function login(request, env) {
  if (!env.GH_CLIENT_ID) return text("GH_CLIENT_ID is not configured", 500);
  const origin = new URL(request.url).origin;
  const state = randomHex();
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GH_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${origin}/auth/callback`);
  u.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: u.toString(), "set-cookie": cookie(STATE, state, 600) } });
}

export async function callback(request, env) {
  const u = new URL(request.url);
  const code = u.searchParams.get("code"), state = u.searchParams.get("state");
  if (!code || !state || state !== readCookie(request, STATE)) return text("로그인 상태가 맞지 않습니다. 다시 시도해 주세요.", 400);
  try {
    const t = await exchange(env, { code, redirect_uri: `${u.origin}/auth/callback` });
    const me = await userProfile(t.access_token);
    if (!me) return text("GitHub 사용자 정보를 읽지 못했습니다", 502);
    const headers = new Headers({ location: `${u.origin}/` });
    headers.append("set-cookie", await sessionCookie(env, { ...me, gh: t.access_token, ghExp: Date.now() + (t.expires_in ? t.expires_in * 1000 : 30 * 86400e3), ref: t.refresh_token || null }));
    headers.append("set-cookie", cookie(STATE, "", 0));
    return new Response(null, { status: 302, headers });
  } catch (e) { return text(`GitHub 로그인 실패: ${e.message}`, 502); }
}

export function logout(request) {
  const origin = new URL(request.url).origin;
  return new Response(null, { status: 302, headers: { location: `${origin}/`, "set-cookie": cookie(COOKIE, "", 0) } });
}

async function sessionCookie(env, sess) {
  const days = Number(env.SESSION_TTL_DAYS || 30);
  const token = await signJwt(env.SESSION_SECRET, { ...sess, exp: Math.floor(Date.now() / 1000) + days * 86400 });
  return cookie(COOKIE, token, days * 86400);
}

/** Returns {session, setCookie?} — refreshes an expiring GitHub token transparently. */
export async function getSession(request, env) {
  const sess = await verifyJwt(env.SESSION_SECRET, readCookie(request, COOKIE));
  if (!sess) return { session: null };
  if (sess.ghExp && sess.ghExp - Date.now() < 5 * 60e3 && sess.ref) {
    try {
      const t = await exchange(env, { grant_type: "refresh_token", refresh_token: sess.ref });
      const fresh = { ...sess, gh: t.access_token, ghExp: Date.now() + (t.expires_in || 8 * 3600) * 1000, ref: t.refresh_token || sess.ref };
      return { session: fresh, setCookie: await sessionCookie(env, fresh) };
    } catch { return { session: null, setCookie: cookie(COOKIE, "", 0) }; }
  }
  if (sess.ghExp && sess.ghExp < Date.now()) return { session: null, setCookie: cookie(COOKIE, "", 0) };
  return { session: sess };
}

export const unauthorized = () => json({ error: "sign in required", login: "/auth/login" }, 401);

/** Membership = "GitHub lets this person read the data repo". Cached 10 minutes per (repo, login). */
export async function canRead(env, session, repo) {
  if (env.DEV_ALLOW_ALL === "1") return true;          // local `wrangler dev` only (.dev.vars); never set in production
  if (!repo) return false;
  const row = await env.DB.prepare("SELECT ok, checked_at FROM members_cache WHERE repo=? AND login=?").bind(repo, session.login).first();
  const now = Date.now();
  if (row && now - row.checked_at < 10 * 60e3) return !!row.ok;
  const ok = await userCanRead(session.gh, repo);
  await env.DB.prepare("INSERT INTO members_cache(repo, login, ok, checked_at) VALUES(?,?,?,?) ON CONFLICT(repo, login) DO UPDATE SET ok=excluded.ok, checked_at=excluded.checked_at")
    .bind(repo, session.login, ok ? 1 : 0, now).run();
  return ok;
}
