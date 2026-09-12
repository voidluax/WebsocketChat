import { randomBytes, randomUUID } from "node:crypto";

/** Seconds a member row survives without a heartbeat before it is reclaimed. */
export const PRESENCE_TTL_SECONDS = 45;

/** Max characters allowed in a single chat message. */
export const MAX_MESSAGE_LENGTH = 2000;

/** Postgres NOTIFY channel used to fan messages out to the websocket hub. */
export const CHAT_EVENT_CHANNEL = "chat_events";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9 _.-]{0,30}[a-zA-Z0-9])?$/;

export function generateRoomCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

export function newSessionId(): string {
  return randomUUID();
}

export function normalizeRoomCode(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

export type UsernameResult =
  | { ok: true; username: string; key: string }
  | { ok: false; error: string };

export function validateUsername(raw: unknown): UsernameResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "username must be a string" };
  }
  const username = raw.trim().replace(/\s+/g, " ");
  if (username.length < 2 || username.length > 32) {
    return { ok: false, error: "username must be between 2 and 32 characters" };
  }
  if (!USERNAME_RE.test(username)) {
    return {
      ok: false,
      error: "username may only contain letters, numbers, spaces, dot, dash and underscore",
    };
  }
  return { ok: true, username, key: username.toLowerCase() };
}

export function sanitizeMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // strip control characters but keep newlines / tabs
  const body = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!body) return null;
  return body.slice(0, MAX_MESSAGE_LENGTH);
}

export function sanitizeRoomName(raw: unknown, fallback = "Untitled room"): string {
  if (typeof raw !== "string") return fallback;
  const name = raw.trim().replace(/\s+/g, " ").slice(0, 80);
  return name.length ? name : fallback;
}

export function sanitizeTopic(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const topic = raw.trim().replace(/\s+/g, " ").slice(0, 200);
  return topic.length ? topic : null;
}

export function clampLimit(raw: unknown, fallback = 50, max = 200): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return Response.json({ ok: false, error: { code, message }, ...extra }, { status });
}

export type PublicRoom = {
  code: string;
  name: string;
  topic: string | null;
  maxMembers: number;
  createdAt: string;
  lastActivityAt: string;
};

export type PublicMessage = {
  id: number;
  room: string;
  username: string;
  body: string;
  kind: string;
  createdAt: string;
};

export type PublicMember = {
  username: string;
  transport: string;
  joinedAt: string;
  lastSeenAt: string;
};
