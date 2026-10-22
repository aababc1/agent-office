// Google Drive, read-only, through a service account (secret GDRIVE_SA_KEY = the downloaded JSON key file).
// The project's Drive folder is shared with the service account's e-mail as a viewer; the Worker lists it
// so the 자료실 card can show what is there. Opening a file goes to Drive with the person's own Google login,
// so Drive's sharing stays the only permission system. Nothing is ever written to Drive from here.
import { importPem } from "./github.js";
import { b64url, b64urlText } from "./util.js";

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
let cached = null;   // {token, exp} per isolate

export const driveEnabled = (env) => !!env.GDRIVE_SA_KEY;

export function folderIdOf(url) {
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(url || "") || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(url || "") || /^([A-Za-z0-9_-]{20,})$/.exec((url || "").trim());
  return m ? m[1] : null;
}

export function serviceAccount(env) {
  let sa; try { sa = JSON.parse(env.GDRIVE_SA_KEY); } catch { throw new Error("GDRIVE_SA_KEY is not the JSON key file"); }
  if (!sa.client_email || !sa.private_key) throw new Error("GDRIVE_SA_KEY lacks client_email/private_key");
  return sa;
}

async function accessToken(env) {
  if (cached && cached.exp > Date.now() + 60e3) return cached.token;
  const sa = serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlText(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const key = await importPem(sa.private_key);
  const sig = b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`)));
  const r = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }) });
  if (!r.ok) throw new Error(`google token ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

const FIELDS = "nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,lastModifyingUser(displayName,emailAddress),shortcutDetails(targetId,targetMimeType))";

/** Files of a folder (and one level of subfolders), newest first. Capped at `max` entries. */
export async function listFolder(env, folderId, { depth = 1, max = 400 } = {}) {
  const token = await accessToken(env);
  const out = [];
  async function walk(parent, path, d) {
    let pageToken = null;
    do {
      const u = new URL(`${(env.GDRIVE_API_BASE || "https://www.googleapis.com").replace(/\/$/, "")}/drive/v3/files`);   // GDRIVE_API_BASE: local tests only
      u.searchParams.set("q", `'${parent}' in parents and trashed=false`);
      u.searchParams.set("fields", FIELDS); u.searchParams.set("orderBy", "modifiedTime desc"); u.searchParams.set("pageSize", "200");
      u.searchParams.set("supportsAllDrives", "true"); u.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
      if (r.status === 404) throw new Error("folder not found or not shared with the service account");
      if (!r.ok) throw new Error(`drive list ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = await r.json();
      for (const f of j.files || []) {
        const dir = f.mimeType === "application/vnd.google-apps.folder";
        const p = path ? `${path}/${f.name}` : f.name;
        out.push({ id: f.id, name: f.name, path: p, mime: f.shortcutDetails ? f.shortcutDetails.targetMimeType : f.mimeType, dir, modifiedAt: f.modifiedTime, size: f.size ? Number(f.size) : null,
                   url: f.webViewLink || `https://drive.google.com/open?id=${f.id}`, by: (f.lastModifyingUser && (f.lastModifyingUser.displayName || f.lastModifyingUser.emailAddress)) || null });
        if (dir && d < depth && out.length < max) await walk(f.id, p, d + 1);
        if (out.length >= max) return;
      }
      pageToken = j.nextPageToken;
    } while (pageToken && out.length < max);
  }
  await walk(folderId, "", 0);
  out.sort((a, b) => (b.modifiedAt || "").localeCompare(a.modifiedAt || ""));
  return out;
}

/** Cached listing in projects.drive_json; refreshed when older than `maxAgeMs` (or forced). Errors keep the last good list. */
export async function driveListing(env, project, driveUrl, { force = false, maxAgeMs = 120e3 } = {}) {
  const fid = folderIdOf(driveUrl);
  if (!fid) return { folder: null, at: null, files: [], error: "no folder id in the drive url" };
  const row = await env.DB.prepare("SELECT drive_json FROM projects WHERE name=?").bind(project).first();
  let cache = null; try { cache = row && row.drive_json ? JSON.parse(row.drive_json) : null; } catch { cache = null; }
  const fresh = cache && cache.folder === fid && cache.at && Date.now() - Date.parse(cache.at) < maxAgeMs;
  if (fresh && !force) return cache;
  if (!driveEnabled(env)) return { folder: fid, at: null, files: (cache && cache.files) || [], error: "GDRIVE_SA_KEY not set" };
  let next;
  try { next = { folder: fid, at: new Date().toISOString(), files: await listFolder(env, fid), error: null }; }
  catch (e) { next = { folder: fid, at: new Date().toISOString(), files: (cache && cache.folder === fid && cache.files) || [], error: e.message }; }
  await env.DB.prepare("UPDATE projects SET drive_json=? WHERE name=?").bind(JSON.stringify(next), project).run();
  return next;
}
