// GET /auth/callback?code=&state= → exchange the code for a user token and hand it to the page.
// The token goes back in the URL *fragment* (never sent to a server, never logged) and the page
// keeps it in localStorage until it expires. GitHub App user tokens expire in 8h; see refresh.js.
import { cookie, exchange, readCookie } from "./_shared.js";

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const code = u.searchParams.get("code"), state = u.searchParams.get("state");
  if (!code || !state || state !== readCookie(request, "office_state")) {
    return new Response("로그인 상태가 맞지 않습니다. 다시 시도해 주세요.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  try {
    const t = await exchange(env, { code, redirect_uri: `${u.origin}/auth/callback` });
    const frag = new URLSearchParams({
      gh: t.access_token,
      exp: String(Date.now() + (t.expires_in ? t.expires_in * 1000 : 30 * 24 * 3600 * 1000)),
      ...(t.refresh_token ? { ref: t.refresh_token } : {}),
    });
    return new Response(null, { status: 302, headers: { location: `${u.origin}/#${frag}`, "set-cookie": cookie("office_state", "", 0) } });
  } catch (e) {
    return new Response(`GitHub 로그인 실패: ${e.message}`, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
