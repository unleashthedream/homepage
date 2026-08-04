// Cloudflare Worker + Durable Object version.
//
// This lives at: homepage/worker/src/index.js
// It reuses `../lib/room.js` (i.e. homepage/worker/lib/room.js), the exact
// same logic the local Node server uses, and speaks the exact same
// JSON-over-WebSocket protocol as public/post.html and public/display.html.
//
// To try it later (from the `worker/` folder): `npx wrangler dev`
// To deploy: `npx wrangler deploy`

import { RoomState } from "../lib/room.js";

export class Room {
  constructor(state, env) {
    this.state = state;
    this.room = new RoomState();
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API: the Durable Object can go to sleep between
    // messages and still wake up to handle the next one.
    this.state.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const id = this._idFor(ws);

    if (data.type === "history") {
      ws.send(JSON.stringify({ type: "history", messages: this.room.getRecentHistory(40) }));
      return;
    }

    if (data.type === "post") {
      const result = this.room.addMessage(id, data.text, Date.now());

      if (!result.ok) {
        ws.send(JSON.stringify({ type: "rejected", reason: result.reason }));
        return;
      }

      ws.send(JSON.stringify({ type: "accepted", id: result.message.id }));

      const payload = JSON.stringify({ type: "message", message: result.message });
      for (const client of this.state.getWebSockets()) {
        client.send(payload);
      }
    }
  }

  async webSocketClose(ws) {
    this.room.forgetConnection(this._idFor(ws));
  }

  // Give each socket a stable id for rate-limiting, stored via the
  // hibernation-safe attachment API rather than an in-memory field.
  _idFor(ws) {
    let id = ws.deserializeAttachment?.();
    if (!id) {
      id = crypto.randomUUID();
      ws.serializeAttachment?.(id);
    }
    return id;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // One shared room for the whole event — a single Durable Object
      // instance handles every connection.
      const id = env.ROOM.idFromName("main-room");
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    // /post.html and /display.html are served automatically as static
    // assets (see wrangler.toml [assets]) before this fetch() ever runs.
    // Only requests that don't match a static file — and aren't /ws —
    // land here.
    return new Response("Not found", { status: 404 });
  },
};
