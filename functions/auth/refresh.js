// POST /auth/refresh {refresh_token} → new access token (GitHub App user tokens only).
import { exchange, json } from "./_shared.js";

export async function onRequestPost({ request, env }) {
  let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!body.refresh_token) return json({ error: "refresh_token required" }, 400);
  try {
    const t = await exchange(env, { grant_type: "refresh_token", refresh_token: body.refresh_token });
    return json({ gh: t.access_token, exp: Date.now() + (t.expires_in || 8 * 3600) * 1000, ref: t.refresh_token || null });
  } catch (e) { return json({ error: e.message }, 502); }
}
