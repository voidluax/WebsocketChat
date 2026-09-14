/**
 * Storage layer for rooms / members / messages.
 *
 * Primary implementation is PostgreSQL (same tables that `src/db/schema.ts`
 * declares for Drizzle). If DATABASE_URL is missing or unreachable the server
 * transparently falls back to an in-memory store so the chat still works on a
 * bare Render free-tier web service without a database attached.
 */
import pg from "pg";
import { generateRoomCode, generateToken } from "./util.mjs";

const STALE_MEMBER_MS = 90_000;

function lower(value) {
  return value.toLocaleLowerCase("en-US");
}

/* ------------------------------------------------------------------ */
/* In-memory store                                                     */
/* ------------------------------------------------------------------ */

function createMemoryStore() {
  const rooms = new Map(); // code -> room
  const membersByRoom = new Map(); // code -> Map(usernameLower -> member)
  const messagesByRoom = new Map(); // code -> array
  let roomSeq = 1;
  let messageSeq = 1;

  const getMembers = (code) => {
    if (!membersByRoom.has(code)) membersByRoom.set(code, new Map());
    return membersByRoom.get(code);
  };
  const getMessages = (code) => {
    if (!messagesByRoom.has(code)) messagesByRoom.set(code, []);
    return messagesByRoom.get(code);
  };

  return {
    kind: "memory",
    async init() {},
    async createRoom({ name, isPrivate }) {
      let code = generateRoomCode();
      while (rooms.has(code)) code = generateRoomCode();
      const now = new Date();
      const room = {
        id: roomSeq++,
        code,
        name,
        isPrivate: Boolean(isPrivate),
        createdAt: now,
        lastActiveAt: now,
      };
      rooms.set(code, room);
      return room;
    },
    async getRoom(code) {
      return rooms.get(code) ?? null;
    },
    async touchRoom(code) {
      const room = rooms.get(code);
      if (room) room.lastActiveAt = new Date();
    },
    async listRooms(limit) {
      return [...rooms.values()]
        .filter((room) => !room.isPrivate)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, limit)
        .map((room) => ({ ...room, memberCount: getMembers(room.code).size }));
    },
    async listMembers(code) {
      return [...getMembers(code).values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((member) => ({ ...member }));
    },
    async isUsernameTaken(code, username) {
      return getMembers(code).has(lower(username));
    },
    async addMember(code, username, transport) {
      const members = getMembers(code);
      const key = lower(username);
      const existing = members.get(key);
      if (existing) {
        if (Date.now() - existing.lastSeenAt.getTime() < STALE_MEMBER_MS) {
          return { ok: false, reason: "USERNAME_TAKEN" };
        }
        members.delete(key);
      }
      const member = {
        roomCode: code,
        username,
        usernameLower: key,
        token: generateToken(),
        transport,
        joinedAt: new Date(),
        lastSeenAt: new Date(),
      };
      members.set(key, member);
      return { ok: true, member };
    },
    async touchMember(code, username) {
      const member = getMembers(code).get(lower(username));
      if (member) member.lastSeenAt = new Date();
      return Boolean(member);
    },
    async getMember(code, username) {
      return getMembers(code).get(lower(username)) ?? null;
    },
    async removeMember(code, username, token) {
      const members = getMembers(code);
      const key = lower(username);
      const member = members.get(key);
      if (!member) return false;
      if (token && member.token !== token) return false;
      members.delete(key);
      return true;
    },
    async pruneStaleMembers() {
      const cutoff = Date.now() - STALE_MEMBER_MS;
      let removed = 0;
      for (const members of membersByRoom.values()) {
        for (const [key, member] of members.entries()) {
          if (member.lastSeenAt.getTime() < cutoff) {
            members.delete(key);
            removed += 1;
          }
        }
      }
      return removed;
    },
    async addMessage({ roomCode, username, text, kind }) {
      const list = getMessages(roomCode);
      const message = {
        id: messageSeq++,
        roomCode,
        username,
        kind,
        body: text,
        createdAt: new Date(),
      };
      list.push(message);
      if (list.length > 500) list.splice(0, list.length - 500);
      await this.touchRoom(roomCode);
      return message;
    },
    async listMessages(roomCode, { after = 0, limit = 50 } = {}) {
      return getMessages(roomCode)
        .filter((message) => message.id > after)
        .slice(-limit)
        .map((message) => ({ ...message }));
    },
    async stats() {
      let members = 0;
      for (const map of membersByRoom.values()) members += map.size;
      let messages = 0;
      for (const list of messagesByRoom.values()) messages += list.length;
      return { rooms: rooms.size, members, messages };
    },
  };
}

/* ------------------------------------------------------------------ */
/* PostgreSQL store                                                    */
/* ------------------------------------------------------------------ */

const SCHEMA_SQL = `
create table if not exists rooms (
  id bigserial primary key,
  code varchar(12) not null,
  name text not null default 'Untitled room',
  is_private boolean not null default false,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);
create unique index if not exists rooms_code_key on rooms (code);

create table if not exists room_members (
  id bigserial primary key,
  room_id integer not null,
  username varchar(32) not null,
  username_lower varchar(32) not null,
  token varchar(64) not null,
  transport varchar(16) not null default 'ws',
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create unique index if not exists room_members_unique_name on room_members (room_id, username_lower);
create index if not exists room_members_room_idx on room_members (room_id);

create table if not exists messages (
  id bigserial primary key,
  room_id integer not null,
  username varchar(32) not null,
  kind varchar(16) not null default 'chat',
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_room_idx on messages (room_id, id);
`;

function mapRoom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    code: row.code,
    name: row.name,
    isPrivate: row.is_private,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    memberCount: row.member_count !== undefined ? Number(row.member_count) : undefined,
  };
}

function mapMember(row) {
  return {
    username: row.username,
    usernameLower: row.username_lower,
    token: row.token,
    transport: row.transport,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapMessage(row) {
  return {
    id: Number(row.id),
    username: row.username,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
  };
}

function createPgStore(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    ssl: /\bsslmode=require\b/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", (error) => {
    console.error("[store] idle postgres client error:", error.message);
  });

  const roomId = async (code) => {
    const { rows } = await pool.query("select id from rooms where code = $1", [code]);
    return rows.length ? Number(rows[0].id) : null;
  };

  return {
    kind: "postgres",
    pool,
    async init() {
      await pool.query(SCHEMA_SQL);
      // Nobody can still be connected to a process that just booted.
      await pool.query("delete from room_members");
    },
    async createRoom({ name, isPrivate }) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const code = generateRoomCode();
        const { rows } = await pool.query(
          `insert into rooms (code, name, is_private) values ($1, $2, $3)
           on conflict (code) do nothing
           returning *`,
          [code, name, Boolean(isPrivate)],
        );
        if (rows.length) return mapRoom(rows[0]);
      }
      throw new Error("could not allocate a unique room code");
    },
    async getRoom(code) {
      const { rows } = await pool.query("select * from rooms where code = $1", [code]);
      return mapRoom(rows[0]);
    },
    async touchRoom(code) {
      await pool.query("update rooms set last_active_at = now() where code = $1", [code]);
    },
    async listRooms(limit) {
      const { rows } = await pool.query(
        `select r.*, (select count(*) from room_members m where m.room_id = r.id) as member_count
         from rooms r
         where r.is_private = false
         order by r.last_active_at desc
         limit $1`,
        [limit],
      );
      return rows.map(mapRoom);
    },
    async listMembers(code) {
      const { rows } = await pool.query(
        `select m.* from room_members m
         join rooms r on r.id = m.room_id
         where r.code = $1
         order by m.joined_at asc`,
        [code],
      );
      return rows.map(mapMember);
    },
    async isUsernameTaken(code, username) {
      const { rows } = await pool.query(
        `select 1 from room_members m
         join rooms r on r.id = m.room_id
         where r.code = $1 and m.username_lower = $2
           and m.last_seen_at > now() - interval '90 seconds'`,
        [code, lower(username)],
      );
      return rows.length > 0;
    },
    async addMember(code, username, transport) {
      const id = await roomId(code);
      if (id === null) return { ok: false, reason: "ROOM_NOT_FOUND" };
      // Drop a stale ghost entry for the same name before trying to claim it.
      await pool.query(
        `delete from room_members
         where room_id = $1 and username_lower = $2
           and last_seen_at < now() - interval '90 seconds'`,
        [id, lower(username)],
      );
      const token = generateToken();
      const { rows } = await pool.query(
        `insert into room_members (room_id, username, username_lower, token, transport)
         values ($1, $2, $3, $4, $5)
         on conflict (room_id, username_lower) do nothing
         returning *`,
        [id, username, lower(username), token, transport],
      );
      if (!rows.length) return { ok: false, reason: "USERNAME_TAKEN" };
      return { ok: true, member: mapMember(rows[0]) };
    },
    async touchMember(code, username) {
      const { rowCount } = await pool.query(
        `update room_members m set last_seen_at = now()
         from rooms r
         where r.id = m.room_id and r.code = $1 and m.username_lower = $2`,
        [code, lower(username)],
      );
      return rowCount > 0;
    },
    async getMember(code, username) {
      const { rows } = await pool.query(
        `select m.* from room_members m
         join rooms r on r.id = m.room_id
         where r.code = $1 and m.username_lower = $2`,
        [code, lower(username)],
      );
      return rows.length ? mapMember(rows[0]) : null;
    },
    async removeMember(code, username, token) {
      const params = [code, lower(username)];
      let sql = `delete from room_members m
                 using rooms r
                 where r.id = m.room_id and r.code = $1 and m.username_lower = $2`;
      if (token) {
        params.push(token);
        sql += " and m.token = $3";
      }
      const { rowCount } = await pool.query(sql, params);
      return rowCount > 0;
    },
    async pruneStaleMembers() {
      const { rowCount } = await pool.query(
        "delete from room_members where last_seen_at < now() - interval '90 seconds'",
      );
      return rowCount;
    },
    async addMessage({ roomCode, username, text, kind }) {
      const { rows } = await pool.query(
        `insert into messages (room_id, username, kind, body)
         select r.id, $2, $3, $4 from rooms r where r.code = $1
         returning *`,
        [roomCode, username, kind, text],
      );
      if (!rows.length) throw new Error("ROOM_NOT_FOUND");
      await this.touchRoom(roomCode);
      return mapMessage(rows[0]);
    },
    async listMessages(roomCode, { after = 0, limit = 50 } = {}) {
      const { rows } = await pool.query(
        `select * from (
           select m.* from messages m
           join rooms r on r.id = m.room_id
           where r.code = $1 and m.id > $2
           order by m.id desc
           limit $3
         ) t order by t.id asc`,
        [roomCode, after, limit],
      );
      return rows.map(mapMessage);
    },
    async stats() {
      const { rows } = await pool.query(
        `select
           (select count(*) from rooms) as rooms,
           (select count(*) from room_members) as members,
           (select count(*) from messages) as messages`,
      );
      return {
        rooms: Number(rows[0].rooms),
        members: Number(rows[0].members),
        messages: Number(rows[0].messages),
      };
    },
  };
}

export async function createStore() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const store = createPgStore(url);
    try {
      await store.init();
      console.log("[store] using postgres");
      return store;
    } catch (error) {
      console.error("[store] postgres unavailable, falling back to memory:", error.message);
      await store.pool.end().catch(() => {});
    }
  } else {
    console.warn("[store] DATABASE_URL not set – using in-memory store");
  }
  const memory = createMemoryStore();
  await memory.init();
  return memory;
}
