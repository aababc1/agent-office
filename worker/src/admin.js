// Admin-only helpers: see where the GitHub App path breaks, and re-read a data repo from scratch.
import { getSession } from "./auth.js";
import { appJwt, installationToken, rawFile, repoBlobs } from "./github.js";
import { applyDocs, processRepoPush } from "./ingest.js";
import { json } from "./util.js";
import { folderIdOf, listFolder, serviceAccount } from "./gdrive.js";

async function admin(request, env) {
  const { session } = await getSession(request, env);
  if (!session) return { deny: json({ error: "sign in required", login: "/auth/login" }, 401) };
  if (session.login !== env.ADMIN_LOGIN) return { deny: json({ error: `admin only (${env.ADMIN_LOGIN})` }, 403) };
  return { session };
}

export async function diag(request, env) {
  const g = await admin(request, env); if (g.deny) return g.deny;
  const repo = new URL(request.url).searchParams.get("repo") || `${env.GH_OWNER}/agent-office-data`;
  const out = { repo, secrets: {}, steps: [] };
  for (const k of ["GH_CLIENT_ID", "GH_CLIENT_SECRET", "GH_APP_ID", "GH_APP_PRIVATE_KEY", "GH_WEBHOOK_SECRET", "SESSION_SECRET", "PROJECT_TOKENS", "GDRIVE_SA_KEY"]) {
    const v = env[k]; out.secrets[k] = v ? (k === "GH_APP_PRIVATE_KEY" ? `set (${v.length} chars, ${/BEGIN/.test(v) ? "PEM" : "not PEM?"}, ${/\\n/.test(v) ? "has literal \\n" : "ok"})` : `set (${String(v).length} chars)`) : "MISSING";
  }
  const step = async (name, fn) => { try { const r = await fn(); out.steps.push({ step: name, ok: true, info: r }); return r; } catch (e) { out.steps.push({ step: name, ok: false, error: e.message }); throw e; } };
  try {
    await step("app jwt (GH_APP_ID + private key)", async () => (await appJwt(env)).length + " chars");
    await step("installation token for " + repo.split("/")[0], async () => "ok");
    await installationToken(env, repo.split("/")[0]);
    await step("read summary.json", async () => { const t = await rawFile(env, repo, "summary.json"); return t ? JSON.parse(t).name : "file missing"; });
    const rows = (await env.DB.prepare("SELECT name, repo, last_at FROM projects").all()).results || [];
    out.d1 = { projects: rows, sessions: (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n, events: (await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first()).n };
  } catch (e) { /* steps carry the failure */ }
  // Google Drive (optional): key parses → token → the first configured folder lists
  if (env.GDRIVE_SA_KEY) {
    try {
      const email = await step("drive: service account key", async () => serviceAccount(env).client_email);   // never echo the key itself
      out.drive = { serviceAccount: email, hint: "share each project's Drive folder with this e-mail (viewer)" };
      const rows = (await env.DB.prepare("SELECT name, docs_json FROM projects WHERE docs_json IS NOT NULL").all()).results || [];
      const withDrive = rows.map(r => { try { return { name: r.name, drive: JSON.parse(r.docs_json).drive }; } catch { return null; } }).filter(x => x && x.drive);
      if (!withDrive.length) out.steps.push({ step: "drive: a project with docs.drive", ok: false, error: "no project has a drive folder yet (office.json or plan.yaml docs.drive)" });
      else await step(`drive: list ${withDrive[0].name}'s folder`, async () => { const l = await listFolder(env, folderIdOf(withDrive[0].drive), { depth: 0, max: 5 }); return `${l.length} entries (first page)`; });
    } catch (e) { /* steps carry the failure */ }
  } else out.steps.push({ step: "drive", ok: false, error: "GDRIVE_SA_KEY not set (optional: Drive listing in the 자료실 card)" });
  return json(out);
}

export async function resync(request, env) {
  const g = await admin(request, env); if (g.deny) return g.deny;
  const repo = new URL(request.url).searchParams.get("repo") || `${env.GH_OWNER}/agent-office-data`;
  try {
    const blobs = await repoBlobs(env, repo); const paths = blobs.map(b => b.path);
    const wanted = paths.filter(p => p === "summary.json" || p === "project.json" || p === "plan.json" || p === "office.json" || /^pipeline\/[^/]+\/progress\.json$/.test(p) || /^sessions\/[^/]+\.progress\.json$/.test(p) || /^sessions\/[^/]+\/events\.\d{3}\.jsonl$/.test(p));
    await processRepoPush(env, repo, "HEAD", wanted);
    const docsNow = blobs.filter(b => /^docs\/.+[^/]$/.test(b.path));
    const project = (await env.DB.prepare("SELECT name FROM projects WHERE repo=?").bind(repo).first() || {}).name;
    if (project) {   // files gone from the tree leave the list; present ones keep their push-time author/date, gain their size
      const known = ((await env.DB.prepare("SELECT path FROM docs WHERE project=?").bind(project).all()).results || []).map(r => r.path);
      const have = new Set(docsNow.map(b => b.path));
      await applyDocs(env, repo, [...known.filter(p => !have.has(p)).map(p => ({ path: p, removed: true })), ...docsNow.filter(b => !known.includes(b.path)).map(b => ({ path: b.path, at: null }))]);
      for (const b of docsNow) await env.DB.prepare("UPDATE docs SET size=? WHERE project=? AND path=?").bind(b.size, project, b.path).run();
    }
    const rows = (await env.DB.prepare("SELECT name, repo, last_at FROM projects").all()).results || [];
    return json({ ok: true, repo, files: wanted.length, docs: docsNow.length, projects: rows, sessions: (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first()).n, events: (await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first()).n });
  } catch (e) { return json({ ok: false, repo, error: e.message, hint: "GET /api/admin/diag shows which step fails" }, 502); }
}
