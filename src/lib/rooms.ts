import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";

import { db } from "@/db";
import { messages, roomMembers, rooms } from "@/db/schema";
import {
  CHAT_EVENT_CHANNEL,
  PRESENCE_TTL_SECONDS,
  generateRoomCode,
  type PublicMember,
  type PublicMessage,
  type PublicRoom,
} from "@/lib/chat";

const activePresence = sql`${roomMembers.lastSeenAt} > now() - make_interval(secs => ${PRESENCE_TTL_SECONDS})`;

export function toPublicRoom(row: typeof rooms.$inferSelect): PublicRoom {
  return {
    code: row.code,
    name: row.name,
    topic: row.topic,
    maxMembers: row.maxMembers,
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}

export function toPublicMessage(row: typeof messages.$inferSelect): PublicMessage {
  return {
    id: row.id,
    room: row.roomCode,
    username: row.username,
    body: row.body,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function prunePresence(): Promise<void> {
  await db
    .delete(roomMembers)
    .where(sql`${roomMembers.lastSeenAt} < now() - make_interval(secs => ${PRESENCE_TTL_SECONDS})`);
}

export async function getRoom(code: string) {
  const [room] = await db.select().from(rooms).where(eq(rooms.code, code)).limit(1);
  return room ?? null;
}

export async function createRoom(input: {
  name: string;
  topic: string | null;
  createdBy: string | null;
  maxMembers: number;
}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateRoomCode(attempt < 5 ? 6 : 8);
    const existing = await getRoom(code);
    if (existing) continue;
    const [room] = await db
      .insert(rooms)
      .values({
        code,
        name: input.name,
        topic: input.topic,
        createdBy: input.createdBy,
        maxMembers: input.maxMembers,
      })
      .returning();
    return room;
  }
  throw new Error("could not allocate a unique room code");
}

export async function listRooms(limit: number) {
  await prunePresence();
  const rows = await db
    .select({
      code: rooms.code,
      name: rooms.name,
      topic: rooms.topic,
      maxMembers: rooms.maxMembers,
      createdAt: rooms.createdAt,
      lastActivityAt: rooms.lastActivityAt,
      members: sql<number>`(
        select count(*)::int from ${roomMembers}
        where ${roomMembers.roomCode} = ${rooms.code}
          and ${roomMembers.lastSeenAt} > now() - make_interval(secs => ${PRESENCE_TTL_SECONDS})
      )`,
    })
    .from(rooms)
    .orderBy(desc(rooms.lastActivityAt))
    .limit(limit);

  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    topic: row.topic,
    maxMembers: row.maxMembers,
    members: Number(row.members ?? 0),
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
  }));
}

export async function listMembers(code: string): Promise<PublicMember[]> {
  const rows = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomCode, code), activePresence))
    .orderBy(asc(roomMembers.joinedAt));

  return rows.map((row) => ({
    username: row.username,
    transport: row.transport,
    joinedAt: row.joinedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}

export async function countMembers(code: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomCode, code), activePresence));
  return Number(row?.count ?? 0);
}

export type ClaimResult =
  | { status: "joined" | "rejoined" }
  | { status: "taken" }
  | { status: "full" };

/**
 * Atomically claim `username` inside `code`. The insert only succeeds when the
 * username is free, still owned by the same session (reconnect) or the previous
 * owner's heartbeat has expired.
 */
export async function claimMembership(input: {
  code: string;
  username: string;
  usernameKey: string;
  sessionId: string;
  transport: "ws" | "http";
  maxMembers: number;
}): Promise<ClaimResult> {
  await prunePresence();

  const [existing] = await db
    .select({ sessionId: roomMembers.sessionId })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomCode, input.code),
        eq(roomMembers.usernameKey, input.usernameKey),
        activePresence,
      ),
    )
    .limit(1);

  if (!existing) {
    const current = await countMembers(input.code);
    if (current >= input.maxMembers) return { status: "full" };
  }

  const result = await db.execute(sql`
    insert into ${roomMembers} (room_code, username_key, username, session_id, transport, joined_at, last_seen_at)
    values (${input.code}, ${input.usernameKey}, ${input.username}, ${input.sessionId}, ${input.transport}, now(), now())
    on conflict (room_code, username_key) do update
      set session_id = excluded.session_id,
          username = excluded.username,
          transport = excluded.transport,
          last_seen_at = now()
      where room_members.session_id = excluded.session_id
         or room_members.last_seen_at < now() - make_interval(secs => ${PRESENCE_TTL_SECONDS})
    returning (xmax = 0) as inserted
  `);

  const rows = (result as unknown as { rows: Array<{ inserted: boolean }> }).rows ?? [];
  if (!rows.length) return { status: "taken" };
  return { status: rows[0]?.inserted ? "joined" : "rejoined" };
}

export async function touchPresence(input: {
  code: string;
  usernameKey: string;
  sessionId: string;
}): Promise<boolean> {
  const result = await db
    .update(roomMembers)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(roomMembers.roomCode, input.code),
        eq(roomMembers.usernameKey, input.usernameKey),
        eq(roomMembers.sessionId, input.sessionId),
      ),
    )
    .returning({ id: roomMembers.id });
  return result.length > 0;
}

export async function releaseMembership(input: {
  code: string;
  usernameKey: string;
  sessionId?: string;
}): Promise<boolean> {
  const filters = [
    eq(roomMembers.roomCode, input.code),
    eq(roomMembers.usernameKey, input.usernameKey),
  ];
  if (input.sessionId) filters.push(eq(roomMembers.sessionId, input.sessionId));
  const removed = await db
    .delete(roomMembers)
    .where(and(...filters))
    .returning({ id: roomMembers.id });
  return removed.length > 0;
}

export async function insertMessage(input: {
  code: string;
  username: string;
  body: string;
  kind?: "chat" | "system";
}): Promise<PublicMessage> {
  const [row] = await db
    .insert(messages)
    .values({
      roomCode: input.code,
      username: input.username,
      body: input.body,
      kind: input.kind ?? "chat",
    })
    .returning();
  await db
    .update(rooms)
    .set({ lastActivityAt: new Date() })
    .where(eq(rooms.code, input.code));
  return toPublicMessage(row);
}

export async function listMessages(input: {
  code: string;
  after?: number;
  before?: number;
  limit: number;
}): Promise<PublicMessage[]> {
  const filters = [eq(messages.roomCode, input.code)];
  if (typeof input.after === "number") filters.push(gt(messages.id, input.after));
  if (typeof input.before === "number") filters.push(lt(messages.id, input.before));

  if (typeof input.after === "number") {
    const rows = await db
      .select()
      .from(messages)
      .where(and(...filters))
      .orderBy(asc(messages.id))
      .limit(input.limit);
    return rows.map(toPublicMessage);
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...filters))
    .orderBy(desc(messages.id))
    .limit(input.limit);
  return rows.reverse().map(toPublicMessage);
}

/**
 * Broadcast an event to every websocket hub process listening on the
 * `chat_events` Postgres channel. This is how HTTP writes reach live sockets.
 */
export async function publishChatEvent(payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  if (body.length > 7000) return;
  await db.execute(sql`select pg_notify(${CHAT_EVENT_CHANNEL}, ${body})`);
}
