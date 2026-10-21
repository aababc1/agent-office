// Shared helpers for the Pages Functions. Secrets live only in Pages env vars (GH_CLIENT_ID, GH_CLIENT_SECRET).
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

export const randomState = () => {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
};

export const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

export const readCookie = (request, name) => {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
};

export async function exchange(env, body) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "agent-office" },
    body: JSON.stringify({ client_id: env.GH_CLIENT_ID, client_secret: env.GH_CLIENT_SECRET, ...body }),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error_description || data.error || `github ${r.status}`);
  return data;   // {access_token, expires_in?, refresh_token?, refresh_token_expires_in?, token_type, scope}
}
