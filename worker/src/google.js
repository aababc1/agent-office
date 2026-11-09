// Google sign-in for the floor OWNER only: files uploaded through the app are created with the owner's Google
// account (owner = owner, quota = owner's) into an app-made folder in the owner's My Drive. Participants never
// touch Google — GitHub login gates the app, the Worker does the Drive calls with the owner's token.
// Scope drive.file (non-sensitive: no verification to publish; refresh tokens do not expire weekly): the app may
// only touch files/folders it created, which is why the floor's upload folder is created by the app itself.
import { cookie, json, nowIso, randomHex, readCookie, text } from "./util.js";
import { memberRole } from "./auth.js";

const STATE = "office_gstate";
const SCOPE = "openid email https://www.googleapis.com/auth/drive.file";
export const googleEnabled = env => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

async function projectRepo(env, project) { const r = await env.DB.prepare("SELECT repo FROM projects WHERE name=?").bind(project).first(); return r && r.repo; }

/** GET /auth/google?project=X — the owner (admin on the data repo) starts the consent flow. */
export async function googleLogin(request, env, session) {
  if (!googleEnabled(env)) return text("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is not configured", 500);
  const u = new URL(request.url); const project = u.searchParams.get("project") || "";
  const repo = await projectRepo(env, project); if (!repo) return text("unknown project", 404);
  if ((await memberRole(env, session, repo)) !== "admin") return text("소유자만 Google 계정을 연결할 수 있습니다", 403);
  const state = `${randomHex()}.${encodeURIComponent(project)}`;
  const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  g.searchParams.set("client_id", env.GOOGLE_CLIENT_ID); g.searchParams.set("redirect_uri", `${u.origin}/auth/google/callback`);
  g.searchParams.set("response_type", "code"); g.searchParams.set("scope", SCOPE); g.searchParams.set("access_type", "offline");
  g.searchParams.set("prompt", "consent"); g.searchParams.set("include_granted_scopes", "true"); g.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: g.toString(), "set-cookie": cookie(STATE, state, 600) } });
}

/** GET /auth/google/callback — stores the owner's tokens for that project and bounces back to the floor. */
export async function googleCallback(request, env, session) {
  const u = new URL(request.url); const code = u.searchParams.get("code"), state = u.searchParams.get("state");
  if (!code || !state || state !== readCookie(request, STATE)) return text("Google 연결 상태가 맞지 않습니다. 다시 시도해 주세요.", 400);
  const project = decodeURIComponent(state.split(".").slice(1).join("."));
  try {
    const t = await tokenRequest(env, { code, grant_type: "authorization_code", redirect_uri: `${u.origin}/auth/google/callback` });
    if (!t.refresh_token) return text("Google이 refresh token을 주지 않았습니다 — 연결 해제 후 다시 시도 (prompt=consent)", 502);
    const email = emailOf(t.id_token) || (await userinfo(t.access_token));
    await env.DB.prepare(`INSERT INTO google_accounts(project, login, email, refresh_token, access_token, expires_at, scope, updated_at) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(project) DO UPDATE SET login=excluded.login, email=excluded.email, refresh_token=excluded.refresh_token, access_token=excluded.access_token, expires_at=excluded.expires_at, scope=excluded.scope, updated_at=excluded.updated_at`)
      .bind(project, session.login, email || "", t.refresh_token, t.access_token, Date.now() + (t.expires_in || 3600) * 1000, t.scope || SCOPE, nowIso()).run();
    const headers = new Headers({ location: `${u.origin}/?project=${encodeURIComponent(project)}` }); headers.append("set-cookie", cookie(STATE, "", 0));
    return new Response(null, { status: 302, headers });
  } catch (e) { return text(`Google 연결 실패: ${e.message}`, 502); }
}

async function tokenRequest(env, params) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error_description || j.error || `google token ${r.status}`);
  return j;
}
function emailOf(idToken) { try { const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)))); return p.email || null; } catch { return null; } }
async function userinfo(token) { const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${token}` } }); return r.ok ? ((await r.json()).email || null) : null; }

/** The owner's account connected to this floor (no tokens), or null. */
export async function googleAccount(env, project) {
  const r = await env.DB.prepare("SELECT login, email, updated_at FROM google_accounts WHERE project=?").bind(project).first();
  return r ? { login: r.login, email: r.email, since: r.updated_at } : null;
}

/** A valid access token for the floor owner's Google account (refreshed when within a minute of expiry); null when not connected. */
export async function ownerToken(env, project) {
  const r = await env.DB.prepare("SELECT refresh_token, access_token, expires_at FROM google_accounts WHERE project=?").bind(project).first();
  if (!r) return null;
  if (r.access_token && r.expires_at - Date.now() > 60e3) return r.access_token;
  try {
    const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: r.refresh_token });
    await env.DB.prepare("UPDATE google_accounts SET access_token=?, expires_at=?, updated_at=? WHERE project=?").bind(t.access_token, Date.now() + (t.expires_in || 3600) * 1000, nowIso(), project).run();
    return t.access_token;
  } catch (e) {
    if (/invalid_grant/.test(e.message)) { await env.DB.prepare("DELETE FROM google_accounts WHERE project=?").bind(project).run(); throw new Error("Google 연결이 끊겼습니다(invalid_grant) — 자료실에서 다시 연결"); }
    throw e;
  }
}

export async function googleDisconnect(env, project) {
  const r = await env.DB.prepare("SELECT refresh_token FROM google_accounts WHERE project=?").bind(project).first();
  if (r) { try { await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: r.refresh_token }) }); } catch { /* best effort */ } }
  await env.DB.prepare("DELETE FROM google_accounts WHERE project=?").bind(project).run();
  return json({ ok: true });
}
