// Web Push, per floor: a person turns the bell on for a floor they can read; the Worker pushes that floor's events
// (cohort done, stage done, failures, probe lost, milestone late, new discussion, new docs) to that person's devices.
// No external service: VAPID keys are generated once and kept in D1 (settings), payloads are encrypted here
// (RFC 8291 aes128gcm) with WebCrypto, and sent straight to the browser vendors' push endpoints.
import { b64url, b64urlDecode, b64urlText, json, nowIso } from "./util.js";

export const KINDS = ["cohort_done", "stage_done", "job_failed", "probe_lost", "milestone_late", "discussion", "docs"];
export const KIND_KO = { cohort_done: "코호트 완료", stage_done: "단계 완료", job_failed: "실패 발생", probe_lost: "프로브 끊김", milestone_late: "마일스톤 지연", discussion: "회의 새 글", docs: "새 자료" };
const enc = new TextEncoder();

// ---- VAPID keys (once, into D1 settings) ----------------------------------------------------------------
let vapidCache = null;
export async function vapid(env) {
  if (vapidCache) return vapidCache;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='vapid'").first();
  if (row) { vapidCache = JSON.parse(row.value); return vapidCache; }
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));        // 65 bytes, uncompressed
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const v = { publicKey: b64url(pub), privateJwk: jwk, subject: env.VAPID_SUBJECT || "mailto:agent-office@users.noreply.github.com", createdAt: nowIso() };
  await env.DB.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('vapid', ?)").bind(JSON.stringify(v)).run();
  const again = await env.DB.prepare("SELECT value FROM settings WHERE key='vapid'").first();   // another isolate may have won
  vapidCache = JSON.parse(again.value); return vapidCache;
}
async function vapidAuth(env, endpoint) {
  const v = await vapid(env); const aud = new URL(endpoint).origin;
  const head = b64urlText(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64urlText(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: v.subject }));
  const key = await crypto.subtle.importKey("jwk", v.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));   // raw r||s, as JWS wants
  return `vapid t=${head}.${claims}.${b64url(sig)}, k=${v.publicKey}`;
}

// ---- RFC 8291 / RFC 8188: aes128gcm content encryption ---------------------------------------------------------
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
export async function encryptPayload(sub, plaintext) {
  const ua = b64urlDecode(sub.keys.p256dh), auth = b64urlDecode(sub.keys.auth);
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prk = await hkdf(auth, shared, cat(enc.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, prk, enc.encode("Content-Encoding: nonce\0"), 12);
  const data = cat(enc.encode(plaintext), new Uint8Array([2]));                      // last record: delimiter 0x02
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, data));
  const rs = new Uint8Array([0, 0, 16, 0]);                                           // record size 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/** Deliver one message to one subscription. Returns the HTTP status (404/410 = gone). */
export async function sendPush(env, sub, payload, { ttl = 3600, urgency = "normal" } = {}) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const r = await fetch(sub.endpoint, { method: "POST", body,
    headers: { authorization: await vapidAuth(env, sub.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(ttl), urgency } });
  return r.status;
}

// ---- subscriptions & per-floor preferences ----------------------------------------------------------------------
export async function subscribe(env, login, sub, ua) {
  const id = await sha256b64(sub.endpoint);
  await env.DB.prepare(`INSERT INTO push_subs(id, login, endpoint, p256dh, auth, ua, created_at, fails) VALUES(?,?,?,?,?,?,?,0)
     ON CONFLICT(id) DO UPDATE SET login=excluded.login, p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua, fails=0`)
    .bind(id, login, sub.endpoint, sub.keys.p256dh, sub.keys.auth, (ua || "").slice(0, 200), nowIso()).run();
  return id;
}
export async function unsubscribe(env, login, endpoint) {
  await env.DB.prepare("DELETE FROM push_subs WHERE login=? AND endpoint=?").bind(login, endpoint).run();
}
export async function setPrefs(env, login, project, kinds) {
  const k = (kinds || []).filter(x => KINDS.includes(x));
  if (!k.length) { await env.DB.prepare("DELETE FROM push_prefs WHERE login=? AND project=?").bind(login, project).run(); return []; }
  await env.DB.prepare("INSERT INTO push_prefs(login, project, kinds_json, updated_at) VALUES(?,?,?,?) ON CONFLICT(login, project) DO UPDATE SET kinds_json=excluded.kinds_json, updated_at=excluded.updated_at")
    .bind(login, project, JSON.stringify(k), nowIso()).run();
  return k;
}
export async function getPrefs(env, login) {
  const rows = (await env.DB.prepare("SELECT project, kinds_json FROM push_prefs WHERE login=?").bind(login).all()).results || [];
  const out = {}; for (const r of rows) { try { out[r.project] = JSON.parse(r.kinds_json); } catch { /* skip */ } }
  const devices = (await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE login=?").bind(login).first()).n;
  return { prefs: out, devices };
}
async function sha256b64(s) { return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s))); }

/** Push one event of a floor to everyone who turned that kind on for that floor (except `skipLogin`, e.g. the author). */
export async function notify(env, project, kind, title, body, { url, skipLogin, tag } = {}) {
  const rows = (await env.DB.prepare(`SELECT s.id, s.login, s.endpoint, s.p256dh, s.auth, s.fails FROM push_prefs p JOIN push_subs s ON s.login=p.login
     WHERE p.project=? AND p.kinds_json LIKE ?`).bind(project, `%"${kind}"%`).all()).results || [];
  let sent = 0;
  for (const r of rows) {
    if (skipLogin && r.login === skipLogin) continue;
    const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      const st = await sendPush(env, sub, { title, body, url: url || `/#p=${encodeURIComponent(project)}`, tag: tag || `${project}:${kind}`, project, kind, at: nowIso() });
      if (st === 404 || st === 410) await env.DB.prepare("DELETE FROM push_subs WHERE id=?").bind(r.id).run();
      else if (st >= 400) await env.DB.prepare("UPDATE push_subs SET fails=fails+1 WHERE id=?").bind(r.id).run();
      else { sent++; await env.DB.prepare("UPDATE push_subs SET fails=0, last_ok=? WHERE id=?").bind(nowIso(), r.id).run(); }
    } catch (e) { console.error("push", r.endpoint.slice(0, 40), e.message); }
  }
  await env.DB.prepare("INSERT INTO notify_log(project, kind, title, body, sent, at) VALUES(?,?,?,?,?,?)").bind(project, kind, title, body, sent, nowIso()).run();
  return sent;
}

// ---- event detection: compare the new pipeline state with what we remembered ---------------------------------------
async function remembered(env, project) {
  const rows = (await env.DB.prepare("SELECT key, value FROM notify_state WHERE project=?").bind(project).all()).results || [];
  const m = {}; for (const r of rows) m[r.key] = r.value; return m;
}
async function remember(env, project, key, value) {
  await env.DB.prepare("INSERT INTO notify_state(project, key, value) VALUES(?,?,?) ON CONFLICT(project, key) DO UPDATE SET value=excluded.value").bind(project, key, String(value)).run();
}
const fmtN = n => Number(n || 0).toLocaleString("en-US");

/** Called after a pipeline state is stored. Emits cohort_done / stage_done / job_failed / milestone_late transitions. */
export async function detectPipelineEvents(env, project, state, plan) {
  if (!state || !state.stages) return;
  const mem = await remembered(env, project); const first = Object.keys(mem).length === 0;   // first sight: record, do not spam
  const site = state.site || state.id || "";
  for (const [name, st] of Object.entries(state.stages)) {
    // stage done
    if (st.total && st.done >= st.total) { const k = `stage:${name}:done`; if (mem[k] !== "1") { await remember(env, project, k, 1); if (!first) await notify(env, project, "stage_done", `${project} · ${name} 완료`, `${fmtN(st.done)} / ${fmtN(st.total)} ${st.unit || ""} 끝${site ? ` · ${site}` : ""}`); } }
    // failures grew
    const k2 = `stage:${name}:failed`; const prevF = Number(mem[k2] || 0); const f = Number(st.failed || 0);
    if (f !== prevF) { await remember(env, project, k2, f); if (!first && f > prevF) await notify(env, project, "job_failed", `${project} · ${name} 실패 +${f - prevF}`, `누적 ${f}건${site ? ` · ${site}` : ""} — 공장에서 단계를 누르면 사유가 보입니다`, { tag: `${project}:failed:${name}` }); }
    // cohorts done on this stage
    for (const [c, g] of Object.entries(st.groups || {})) {
      if (g.total && g.done >= g.total) { const k3 = `cohort:${name}:${c}`; if (mem[k3] !== "1") { await remember(env, project, k3, 1); if (!first) await notify(env, project, "cohort_done", `${project} · ${c} ${name} 완료`, `${fmtN(g.done)} / ${fmtN(g.total)}${g.failed ? ` · 실패 ${g.failed}` : ""}`, { tag: `${project}:cohort:${c}` }); } }
    }
  }
  // milestones: late / overdue transitions (same rule as the viewer's deadline board)
  for (const m of (plan && plan.milestones) || []) {
    const need = (m.stages || []).map(n => state.stages[n]).filter(Boolean); if (!need.length || !m.date) continue;
    const complete = need.every(s => s.total && s.done >= s.total);
    const etas = need.map(s => (s.total && s.done >= s.total) ? null : (s.eta && s.eta.at) || null); const unknown = etas.some((e, i) => e === null && !(need[i].total && need[i].done >= need[i].total));
    const eta = unknown ? null : etas.filter(Boolean).sort().pop();
    const date = Date.parse(m.date); let status = "ok";
    if (complete) status = "done"; else if (Date.now() > date) status = "overdue"; else if (eta && Date.parse(eta) > date) status = "late"; else if (!eta) status = "unknown";
    const k = `milestone:${m.name}`;
    if (mem[k] !== status) { await remember(env, project, k, status); if (!first && (status === "late" || status === "overdue") && mem[k] !== "overdue") await notify(env, project, "milestone_late", `${project} · 🏁 ${m.name} ${status === "overdue" ? "기한 지남" : "늦어질 예정"}`, `목표 ${m.date}${eta ? ` · 예상 ${eta.slice(0, 10)}` : ""}`, { tag: `${project}:ms:${m.name}` }); }
  }
  await remember(env, project, "probe:lastAt", state.probedAt || nowIso());
  if (mem["probe:lost"] === "1") { await remember(env, project, "probe:lost", 0); await notify(env, project, "probe_lost", `${project} · 프로브 복구`, `${site || "계산 서버"}에서 다시 신호가 옵니다`, { tag: `${project}:probe` }); }
}

/** Cron: probes silent for 2h+ (plan alerts heartbeat_lost_2h) → one notice; cleared by detectPipelineEvents when it returns. */
export async function checkLostProbes(env) {
  const rows = (await env.DB.prepare("SELECT project, MAX(updated_at) AS at FROM pipeline_runs GROUP BY project").all()).results || [];
  for (const r of rows) {
    const mem = await remembered(env, r.project); const last = Date.parse(mem["probe:lastAt"] || r.at || 0);
    if (Date.now() - last > 2 * 3600e3 && mem["probe:lost"] !== "1") {
      await remember(env, r.project, "probe:lost", 1);
      await notify(env, r.project, "probe_lost", `${r.project} · 프로브 끊김`, `마지막 신호 ${new Date(last).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} — 로그인 노드의 tmux office 루프를 확인`, { tag: `${r.project}:probe` });
    }
  }
}

/** New files in the Drive folder (cron-driven refresh) → docs notice. */
export async function detectDocsEvents(env, project, files, source) {
  const mem = await remembered(env, project); const k = `docs:${source}:latest`;
  const latest = (files || []).filter(f => !f.dir).map(f => f.modifiedAt || f.updatedAt || "").sort().pop() || "";
  if (!latest) return;
  if (mem[k] === undefined) { await remember(env, project, k, latest); return; }
  if (latest > mem[k]) {
    const fresh = (files || []).filter(f => !f.dir && (f.modifiedAt || f.updatedAt || "") > mem[k]);
    await remember(env, project, k, latest);
    await notify(env, project, "docs", `${project} · 새 자료 ${fresh.length}개`, fresh.slice(0, 3).map(f => f.name || f.path).join(", ") + (fresh.length > 3 ? " …" : ""), { tag: `${project}:docs` });
  }
}

// ---- HTTP handlers (login required; the floor must be readable by the person) ---------------------------------------
export async function pushApi(request, env, path, session, canReadProject) {
  if (path === "/api/push/key") return json({ key: (await vapid(env)).publicKey, kinds: KINDS, ko: KIND_KO });
  if (path === "/api/push/prefs") return json(await getPrefs(env, session.login));
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const body = await request.json().catch(() => ({}));
  if (path === "/api/push/subscribe") {
    if (!body.subscription || !body.subscription.endpoint || !body.subscription.keys) return json({ error: "subscription missing" }, 400);
    await subscribe(env, session.login, body.subscription, request.headers.get("user-agent"));
    let kinds = null;
    if (body.project) { if (!(await canReadProject(body.project))) return json({ error: "not a collaborator" }, 403); kinds = await setPrefs(env, session.login, body.project, body.kinds || KINDS); }
    return json({ ok: true, kinds });
  }
  if (path === "/api/push/prefs/set") {
    if (!body.project) return json({ error: "project missing" }, 400);
    if (!(await canReadProject(body.project))) return json({ error: "not a collaborator" }, 403);
    return json({ ok: true, kinds: await setPrefs(env, session.login, body.project, body.kinds || []) });
  }
  if (path === "/api/push/unsubscribe") { if (body.endpoint) await unsubscribe(env, session.login, body.endpoint); return json({ ok: true }); }
  if (path === "/api/push/test") {
    const rows = (await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE login=?").bind(session.login).all()).results || [];
    const out = [];
    for (const r of rows) { try { out.push(await sendPush(env, { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, { title: "Agent Office", body: "알림이 켜졌습니다 — 이 층의 일이 생기면 여기로 옵니다", url: "/", tag: "test" })); } catch (e) { out.push(e.message); } }
    return json({ ok: true, results: out });
  }
  return json({ error: "not found" }, 404);
}
