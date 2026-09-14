import {
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Chat rooms. `code` is the short human friendly join code handed back by
 * `POST /api/rooms` (or the `create_room` websocket frame).
 */
export const rooms = pgTable(
  "rooms",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    code: varchar("code", { length: 12 }).notNull(),
    name: text("name").notNull().default("Untitled room"),
    isPrivate: boolean("is_private").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("rooms_code_key").on(table.code)],
);

/**
 * Active room membership. The unique index on (room_id, username_lower) is what
 * enforces "one username per room" – a duplicate join is rejected by Postgres.
 */
export const roomMembers = pgTable(
  "room_members",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    roomId: integer("room_id").notNull(),
    username: varchar("username", { length: 32 }).notNull(),
    usernameLower: varchar("username_lower", { length: 32 }).notNull(),
    token: varchar("token", { length: 64 }).notNull(),
    transport: varchar("transport", { length: 16 }).notNull().default("ws"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("room_members_unique_name").on(table.roomId, table.usernameLower),
    index("room_members_room_idx").on(table.roomId),
  ],
);

/** Persisted chat history (chat messages + system join/leave events). */
export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    roomId: integer("room_id").notNull(),
    username: varchar("username", { length: 32 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull().default("chat"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("messages_room_idx").on(table.roomId, table.id)],
);

export type Room = typeof rooms.$inferSelect;
export type RoomMember = typeof roomMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
