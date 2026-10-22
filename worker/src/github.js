// GitHub App server-to-server access: an RS256 app JWT → installation token → read files of the data repos.
// Used by the webhook ingest. Nothing here touches a person's own token.
import { b64url, b64urlText } from "./util.js";

const UA = "agent-office-worker";

// PEM → CryptoKey. GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto wants PKCS#8, so wrap if needed.
export function normalizePem(pem) {
  let t = String(pem || "").trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(t);
  if (!m) return t;
  const body = m[2].replace(/\s+/g, "");
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END ${m[1]}-----\n`;
}
async function importPem(pemRaw) {
  const pem = normalizePem(pemRaw);
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  let der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  if (/RSA PRIVATE KEY/.test(pem)) der = pkcs1ToPkcs8(der);
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
function derLen(n) { if (n < 128) return [n]; if (n < 256) return [0x81, n]; return [0x82, n >> 8, n & 255]; }
function pkcs1ToPkcs8(pkcs1) {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  const total = inner.length + pkcs1.length;
  return new Uint8Array([0x30, ...derLen(total), ...inner, ...pkcs1]);
}

export async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64urlText(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GH_APP_ID }));
  const key = await importPem(env.GH_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const tokenCache = new Map();   // owner → {token, exp}  (per isolate; installation tokens live 1h)
export async function installationToken(env, owner) {
  const c = tokenCache.get(owner);
  if (c && c.exp - Date.now() > 60_000) return c.token;
  const jwt = await appJwt(env);
  const h = { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": UA, "x-github-api-version": "2022-11-28" };
  const inst = await (await fetch("https://api.github.com/app/installations?per_page=100", { headers: h })).json();
  const mine = (Array.isArray(inst) ? inst : []).find(i => i.account && i.account.login.toLowerCase() === owner.toLowerCase());
  if (!mine) throw new Error(`GitHub App is not installed on ${owner}`);
  const r = await fetch(`https://api.github.com/app/installations/${mine.id}/access_tokens`, { method: "POST", headers: h });
  const t = await r.json();
  if (!r.ok) throw new Error(`installation token: ${t.message || r.status}`);
  tokenCache.set(owner, { token: t.token, exp: Date.parse(t.expires_at) });
  return t.token;
}

export async function rawFile(env, repo, path, ref) {
  const token = await installationToken(env, repo.split("/")[0]);
  const url = `https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${ref}` : ""}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw+json", "user-agent": UA, "x-github-api-version": "2022-11-28" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`raw ${repo}/${path}: ${r.status}`);
  return await r.text();
}

// A person's own token: can they read this repo? (private repo → collaborator or owner)
export async function userCanRead(userToken, repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: { authorization: `Bearer ${userToken}`, accept: "application/vnd.github+json", "user-agent": UA, "x-github-api-version": "2022-11-28" } });
  return r.ok;
}
export async function userProfile(userToken) {
  const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${userToken}`, accept: "application/vnd.github+json", "user-agent": UA, "x-github-api-version": "2022-11-28" } });
  if (!r.ok) return null;
  const u = await r.json();
  return { login: u.login, avatar: u.avatar_url };
}

export async function repoTree(env, repo, ref = "HEAD") {
  const token = await installationToken(env, repo.split("/")[0]);
  const r = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": UA, "x-github-api-version": "2022-11-28" } });
  if (!r.ok) throw new Error(`tree ${repo}: ${r.status}`);
  const t = await r.json();
  return (t.tree || []).filter(x => x.type === "blob").map(x => x.path);
}
export async function repoBlobs(env, repo, ref = "HEAD") {          // same, with sizes (for the 자료실 resync)
  const token = await installationToken(env, repo.split("/")[0]);
  const r = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": UA, "x-github-api-version": "2022-11-28" } });
  if (!r.ok) throw new Error(`tree ${repo}: ${r.status}`);
  const t = await r.json();
  return (t.tree || []).filter(x => x.type === "blob").map(x => ({ path: x.path, size: x.size }));
}
