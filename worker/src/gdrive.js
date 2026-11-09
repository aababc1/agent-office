// Google Drive, read-only, through a service account (secret GDRIVE_SA_KEY = the downloaded JSON key file).
// The project's Drive folder is shared with the service account's e-mail as a viewer; the Worker lists it
// so the 자료실 card can show what is there. Opening a file goes to Drive with the person's own Google login,
// so Drive's sharing stays the only permission system. Nothing is ever written to Drive from here.
import { importPem } from "./github.js";
import { b64url, b64urlText } from "./util.js";

// read for the listing, write for uploads into the Shared Drive folder (the service account must be a member of that Shared Drive, Contributor or above)
const SCOPE = "https://www.googleapis.com/auth/drive";
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

export const saToken = env => accessToken(env);
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
export async function listFolder(env, folderId, { depth = 1, max = 400, token } = {}) {
  token = token || await accessToken(env);
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

const API = env => (env.GDRIVE_API_BASE || "https://www.googleapis.com").replace(/\/$/, "");
const META = "id,name,mimeType,size,modifiedTime,webViewLink,parents,driveId";

/** Start a resumable upload into `folderId`; returns the session URI the browser PUTs the bytes to (no token needed on that URI). */
// `origin` = the browser's Origin: Google answers CORS on the session URI only for the origin that opened the session
export async function startUpload(env, folderId, { name, mime, size, origin, token }) {
  token = token || await accessToken(env);
  const r = await fetch(`${API(env)}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(META)}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mime || "application/octet-stream", ...(size ? { "x-upload-content-length": String(size) } : {}), ...(origin ? { origin } : {}) },
    body: JSON.stringify({ name, parents: [folderId] }) });
  if (!r.ok) throw new Error(`drive upload start ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const uri = r.headers.get("location"); if (!uri) throw new Error("drive upload start: no session uri");
  return uri;
}
/** Small files through the Worker (browser → Worker → Drive, one multipart request). */
export async function uploadSmall(env, folderId, { name, mime, token }, bytes) {
  token = token || await accessToken(env); const boundary = "office" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder(); const head = enc.encode(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\ncontent-type: ${mime || "application/octet-stream"}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`); const body = new Uint8Array(head.length + bytes.byteLength + tail.length); body.set(head, 0); body.set(new Uint8Array(bytes), head.length); body.set(tail, head.length + bytes.byteLength);
  const r = await fetch(`${API(env)}/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(META)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body });
  if (!r.ok) throw new Error(`drive upload ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
/** Sub-folder `name` directly under `parentId` (a topic's folder); created when missing. */
export async function ensureSubfolder(env, parentId, name, token) {
  token = token || await accessToken(env); const H = { authorization: `Bearer ${token}` };
  const q = `'${parentId}' in parents and name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const u = new URL(`${API(env)}/drive/v3/files`); u.searchParams.set("q", q); u.searchParams.set("fields", "files(id,name,webViewLink)"); u.searchParams.set("supportsAllDrives", "true"); u.searchParams.set("includeItemsFromAllDrives", "true"); u.searchParams.set("pageSize", "5");
  const r = await fetch(u, { headers: H }); if (!r.ok) throw new Error(`drive folder lookup ${r.status}`);
  const hit = ((await r.json()).files || [])[0]; if (hit) return { id: hit.id, name: hit.name, url: hit.webViewLink || `https://drive.google.com/drive/folders/${hit.id}`, created: false };
  const c = await fetch(`${API(env)}/drive/v3/files?supportsAllDrives=true&fields=id,name,webViewLink`, { method: "POST", headers: { ...H, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }) });
  if (!c.ok) throw new Error(`drive folder create ${c.status}: ${(await c.text()).slice(0, 160)}`);
  const f = await c.json(); return { id: f.id, name: f.name, url: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`, created: true };
}
/** Give `email` access to the floor's folder (in a Shared Drive this is folder-level sharing; the service account needs Manager/Content manager rights). */
export async function addMember(env, folderId, email, role, token) {
  token = token || await accessToken(env);
  const r = await fetch(`${API(env)}/drive/v3/files/${encodeURIComponent(folderId)}/permissions?supportsAllDrives=true&sendNotificationEmail=true&fields=id,role,emailAddress`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ type: "user", role, emailAddress: email }) });
  if (!r.ok) throw new Error(`drive permission ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
/** Folder name for a discussion topic: "#12 제목", filesystem-safe, ≤ 80 chars. */
export const topicFolderName = (number, title) => `${number ? `#${number} ` : ""}${String(title || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim()}`.slice(0, 80).trim() || (number ? `#${number}` : "주제");
export async function fileMeta(env, id, token) {
  token = token || await accessToken(env);
  const r = await fetch(`${API(env)}/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent(META)}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`drive file ${r.status}`);
  return r.json();
}

/** The service account's e-mail (shared into folders so the Worker can list them). */
export function saEmail(env) { try { return JSON.parse(env.GDRIVE_SA_KEY || "{}").client_email || null; } catch { return null; } }
/** The app-made upload folder in the owner's My Drive (drive.file can only use folders the app created). */
export async function createAppFolder(env, token, name) {
  const r = await fetch(`${API(env)}/drive/v3/files?supportsAllDrives=true&fields=id,name,webViewLink`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }) });
  if (!r.ok) throw new Error(`drive folder create ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const f = await r.json(); return { id: f.id, name: f.name, url: f.webViewLink || `https://drive.google.com/drive/folders/${f.id}` };
}
/** Share a file/folder (anyone-with-link when `email` is null). */
export async function share(env, token, fileId, { email, role, anyone }) {
  const body = anyone ? { type: "anyone", role: role || "reader" } : { type: "user", role: role || "reader", emailAddress: email };
  const r = await fetch(`${API(env)}/drive/v3/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true&sendNotificationEmail=${anyone ? "false" : "true"}&fields=id,role,type,emailAddress`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`drive permission ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Cached listing in projects.drive_json; refreshed when older than `maxAgeMs` (or forced). Errors keep the last good list. */
export async function driveListing(env, project, driveUrl, { force = false, maxAgeMs = 120e3, token = null } = {}) {
  const fid = folderIdOf(driveUrl);
  if (!fid) return { folder: null, at: null, files: [], error: "no folder id in the drive url" };
  const row = await env.DB.prepare("SELECT drive_json FROM projects WHERE name=?").bind(project).first();
  let cache = null; try { cache = row && row.drive_json ? JSON.parse(row.drive_json) : null; } catch { cache = null; }
  const fresh = cache && cache.folder === fid && cache.at && Date.now() - Date.parse(cache.at) < maxAgeMs;
  if (fresh && !force) return cache;
  if (!driveEnabled(env) && !token) return { folder: fid, at: null, files: (cache && cache.files) || [], error: "GDRIVE_SA_KEY not set" };
  let next;
  try { next = { folder: fid, at: new Date().toISOString(), files: await listFolder(env, fid, { token: driveEnabled(env) ? null : token }), error: null }; }
  catch (e) { next = { folder: fid, at: new Date().toISOString(), files: (cache && cache.folder === fid && cache.files) || [], error: e.message }; }
  await env.DB.prepare("UPDATE projects SET drive_json=? WHERE name=?").bind(JSON.stringify(next), project).run();
  return next;
}
