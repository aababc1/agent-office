// One Durable Object per project: holds the open WebSockets of everyone watching that floor and
// relays "something changed" notices. Viewers then fetch the delta over the REST API, so the
// socket carries only tiny messages and the DO keeps no state worth losing.
export class Floor {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);                 // hibernatable: no CPU while idle
      server.send(JSON.stringify({ kind: "hello", viewers: this.ctx.getWebSockets().length }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const msg = await request.text();
      let n = 0;
      for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); n++; } catch { /* closing */ } }
      return new Response(JSON.stringify({ delivered: n }), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws, message) { if (message === "ping") ws.send("pong"); }
  webSocketClose(ws) { try { ws.close(); } catch { /* already closed */ } }
  webSocketError(ws) { try { ws.close(); } catch { /* already closed */ } }
}
