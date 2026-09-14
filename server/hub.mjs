/**
 * The hub owns the live socket registry and every mutation that both the REST
 * API and the websocket server need, so a message posted over HTTP is pushed to
 * websocket clients instantly (and vice versa).
 */
import {
  HISTORY_LIMIT,
  RateLimiter,
  publicMessage,
  publicRoom,
  validateMessage,
  validateRoomName,
  validateUsername,
} from "./util.mjs";

export class Hub {
  constructor(store) {
    this.store = store;
    /** @type {Map<string, Set<any>>} roomCode -> sockets */
    this.sockets = new Map();
    this.messageLimiter = new RateLimiter(20, 10_000);
    this.roomLimiter = new RateLimiter(15, 60_000);
  }

  /* ------------------------------ sockets ----------------------------- */

  register(code, socket) {
    if (!this.sockets.has(code)) this.sockets.set(code, new Set());
    this.sockets.get(code).add(socket);
  }

  unregister(code, socket) {
    const set = this.sockets.get(code);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(code);
  }

  localMembers(code) {
    const set = this.sockets.get(code);
    if (!set) return [];
    return [...set].map((socket) => socket.chatUsername).filter(Boolean);
  }

  broadcast(code, payload, { except } = {}) {
    const set = this.sockets.get(code);
    if (!set) return 0;
    const data = JSON.stringify(payload);
    let sent = 0;
    for (const socket of set) {
      if (socket === except) continue;
      if (socket.readyState !== 1) continue;
      socket.send(data);
      sent += 1;
    }
    return sent;
  }

  async broadcastPresence(code) {
    const members = await this.store.listMembers(code);
    this.broadcast(code, {
      type: "presence",
      room: code,
      count: members.length,
      members: members.map((member) => ({
        username: member.username,
        transport: member.transport,
        joinedAt: new Date(member.joinedAt).toISOString(),
      })),
      ts: new Date().toISOString(),
    });
  }

  /* ------------------------------- rooms ------------------------------ */

  async createRoom({ name, isPrivate, clientKey }) {
    if (clientKey && !this.roomLimiter.allow(clientKey)) {
      return { ok: false, status: 429, code: "RATE_LIMITED", message: "Too many rooms created, slow down." };
    }
    const room = await this.store.createRoom({
      name: validateRoomName(name),
      isPrivate: Boolean(isPrivate),
    });
    return { ok: true, room: publicRoom(room, 0) };
  }

  async getRoomOr404(code) {
    const room = await this.store.getRoom(code);
    if (!room) {
      return { ok: false, status: 404, code: "ROOM_NOT_FOUND", message: `Room ${code} does not exist.` };
    }
    return { ok: true, room };
  }

  /**
   * Claim a username inside a room. Fails with USERNAME_TAKEN (HTTP 409 /
   * ws close 4409) when somebody already holds that name.
   */
  async join({ code, username, transport = "ws" }) {
    const check = validateUsername(username);
    if (!check.ok) {
      return { ok: false, status: 400, code: "INVALID_USERNAME", message: check.error };
    }
    const found = await this.getRoomOr404(code);
    if (!found.ok) return found;

    const result = await this.store.addMember(code, check.value, transport);
    if (!result.ok) {
      if (result.reason === "ROOM_NOT_FOUND") {
        return { ok: false, status: 404, code: "ROOM_NOT_FOUND", message: `Room ${code} does not exist.` };
      }
      return {
        ok: false,
        status: 409,
        code: "USERNAME_TAKEN",
        message: `The username "${check.value}" is already in room ${code}. Pick another one.`,
      };
    }

    const member = result.member;
    const systemMessage = await this.store.addMessage({
      roomCode: code,
      username: member.username,
      text: `${member.username} joined the room`,
      kind: "system",
    });

    this.broadcast(code, publicMessage(systemMessage, code));
    // presence is broadcast by the caller after it registers its own socket
    return { ok: true, room: found.room, member, systemMessage };
  }

  async leave({ code, username, token, reason = "left the room" }) {
    const removed = await this.store.removeMember(code, username, token);
    if (!removed) return { ok: false, status: 404, code: "NOT_IN_ROOM", message: "Member not found in room." };
    const systemMessage = await this.store.addMessage({
      roomCode: code,
      username,
      text: `${username} ${reason}`,
      kind: "system",
    });
    this.broadcast(code, publicMessage(systemMessage, code));
    await this.broadcastPresence(code);
    return { ok: true };
  }

  /* ------------------------------ messages ---------------------------- */

  async postMessage({ code, username, text, token, requireMembership = true, except }) {
    const check = validateMessage(text);
    if (!check.ok) {
      return { ok: false, status: 400, code: "INVALID_MESSAGE", message: check.error };
    }
    const found = await this.getRoomOr404(code);
    if (!found.ok) return found;

    if (requireMembership) {
      const member = await this.store.getMember(code, username);
      if (!member) {
        return {
          ok: false,
          status: 403,
          code: "NOT_IN_ROOM",
          message: `Join room ${code} first (POST /api/rooms/${code}/join or a websocket join frame).`,
        };
      }
      if (token && member.token !== token) {
        return { ok: false, status: 403, code: "INVALID_TOKEN", message: "Token does not match this username." };
      }
      username = member.username;
      await this.store.touchMember(code, username);
    }

    if (!this.messageLimiter.allow(`${code}:${username.toLowerCase()}`)) {
      return { ok: false, status: 429, code: "RATE_LIMITED", message: "Slow down – too many messages." };
    }

    const stored = await this.store.addMessage({
      roomCode: code,
      username,
      text: check.value,
      kind: "chat",
    });
    const payload = publicMessage(stored, code);
    this.broadcast(code, payload, { except });
    return { ok: true, message: payload };
  }

  async history(code, { after = 0, limit = 50 } = {}) {
    const rows = await this.store.listMessages(code, {
      after,
      limit: Math.min(limit, HISTORY_LIMIT),
    });
    return rows.map((row) => publicMessage(row, code));
  }
}
