// GET /auth/login → send the viewer to GitHub to authorize the Agent Office app.
import { cookie, randomState } from "./_shared.js";

export async function onRequestGet({ request, env }) {
  if (!env.GH_CLIENT_ID) return new Response("GH_CLIENT_ID is not set on this Pages project", { status: 500 });
  const origin = new URL(request.url).origin;
  const state = randomState();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GH_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${origin}/auth/callback`);
  url.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: url.toString(), "set-cookie": cookie("office_state", state, 600) } });
}
