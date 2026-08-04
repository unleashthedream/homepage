// Room logic shared between the local Node.js server (server.js) and the
// future Cloudflare Durable Object (worker/src/index.js).
//
// This file intentionally avoids any Node.js-only APIs (no `fs`, no
// `require`, no Buffer, etc.) and any Cloudflare-only APIs, so it can run
// unchanged in both environments. Keep it that way when editing.

export const MAX_MESSAGE_LENGTH = 60; // characters per message
export const MIN_SEND_INTERVAL_MS = 3000; // per-connection cooldown
export const HISTORY_LIMIT = 300; // how many messages to keep in memory

export class RoomState {
  constructor() {
    this.history = []; // oldest -> newest
    this.lastSentAt = new Map(); // connectionId -> timestamp
  }

  /**
   * Attempt to post a message on behalf of a connection.
   * @param {string} connectionId - unique id for the sending connection
   * @param {unknown} rawText - whatever the client sent
   * @param {number} now - Date.now(), passed in so this stays pure/testable
   * @returns {{ok: true, message: {id:string, text:string, ts:number}} | {ok: false, reason: string}}
   */
  addMessage(connectionId, rawText, now) {
    const last = this.lastSentAt.get(connectionId) || 0;
    if (now - last < MIN_SEND_INTERVAL_MS) {
      return { ok: false, reason: "too-fast" };
    }

    if (typeof rawText !== "string") {
      return { ok: false, reason: "invalid" };
    }

    const text = rawText.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (text.length === 0) {
      return { ok: false, reason: "empty" };
    }

    this.lastSentAt.set(connectionId, now);

    const message = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      ts: now,
    };

    this.history.push(message);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();

    return { ok: true, message };
  }

  /** Most recent `limit` messages, oldest first. */
  getRecentHistory(limit = 40) {
    return this.history.slice(-limit);
  }

  /** Call when a connection closes, to stop leaking rate-limit entries. */
  forgetConnection(connectionId) {
    this.lastSentAt.delete(connectionId);
  }
}
