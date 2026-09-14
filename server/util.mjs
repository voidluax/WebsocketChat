import { randomBytes, randomUUID } from "node:crypto";

/** Unambiguous alphabet (no 0/O/1/I) so codes are easy to read out loud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const ROOM_CODE_LENGTH = 6;
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_USERNAME_LENGTH = 24;
export const MIN_USERNAME_LENGTH = 2;
export const HISTORY_LIMIT = 200;

export function generateRoomCode(length = ROOM_CODE_LENGTH) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function generateToken() {
  return randomUUID().replace(/-/g, "");
}

export function normalizeCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return null;
  return code;
}

/**
 * Usernames: 2-24 chars, letters/numbers/space/._- only. Returns
 * `{ ok, value, error }`.
 */
export function validateUsername(value) {
  if (typeof value !== "string") {
    return { ok: false, error: "username must be a string" };
  }
  const username = value.trim().replace(/\s+/g, " ");
  if (username.length < MIN_USERNAME_LENGTH) {
    return { ok: false, error: `username must be at least ${MIN_USERNAME_LENGTH} characters` };
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    return { ok: false, error: `username must be at most ${MAX_USERNAME_LENGTH} characters` };
  }
  if (!/^[A-Za-z0-9 ._-]+$/.test(username)) {
    return { ok: false, error: "username may only contain letters, numbers, spaces, dot, dash, underscore" };
  }
  return { ok: true, value: username };
}

export function validateRoomName(value, fallback = "Untitled room") {
  if (typeof value !== "string") return fallback;
  const name = value.trim().replace(/\s+/g, " ").slice(0, 60);
  return name.length > 0 ? name : fallback;
}

export function validateMessage(value) {
  if (typeof value !== "string") {
    return { ok: false, error: "text must be a string" };
  }
  const text = value.replace(/\s+$/g, "");
  if (text.trim().length === 0) {
    return { ok: false, error: "text must not be empty" };
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `text must be at most ${MAX_MESSAGE_LENGTH} characters` };
  }
  return { ok: true, value: text };
}

export function clampLimit(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function publicRoom(room, memberCount = 0) {
  if (!room) return null;
  return {
    code: room.code,
    name: room.name,
    isPrivate: Boolean(room.isPrivate),
    createdAt: new Date(room.createdAt).toISOString(),
    lastActiveAt: new Date(room.lastActiveAt).toISOString(),
    memberCount,
  };
}

export function publicMessage(message, roomCode) {
  return {
    // `type` is what websocket clients switch on; `kind` distinguishes chat
    // messages from system join/leave notices.
    type: message.kind === "system" ? "system" : "message",
    id: Number(message.id),
    room: roomCode,
    kind: message.kind,
    username: message.username,
    text: message.body,
    ts: new Date(message.createdAt).toISOString(),
  };
}

/** Simple sliding-window rate limiter used for websocket + REST sends. */
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  allow(key) {
    const now = Date.now();
    const bucket = (this.hits.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    if (bucket.length >= this.limit) {
      this.hits.set(key, bucket);
      return false;
    }
    bucket.push(now);
    this.hits.set(key, bucket);
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.hits.entries()) {
      const fresh = bucket.filter((ts) => now - ts < this.windowMs);
      if (fresh.length === 0) this.hits.delete(key);
      else this.hits.set(key, fresh);
    }
  }
}
