import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * A chat room. `code` is the short human friendly join code handed back by
 * `POST /api/rooms` and used by websocket clients in their `join` frame.
 */
export const rooms = pgTable(
  "rooms",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 12 }).notNull().unique(),
    name: varchar("name", { length: 80 }).notNull(),
    topic: varchar("topic", { length: 200 }),
    createdBy: varchar("created_by", { length: 32 }),
    maxMembers: integer("max_members").notNull().default(50),
    isLocked: boolean("is_locked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("rooms_last_activity_idx").on(table.lastActivityAt)],
);

/**
 * Persisted chat history so reconnecting clients (and the HTTP polling
 * fallback transport) can catch up on what they missed.
 */
export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    roomCode: varchar("room_code", { length: 12 })
      .notNull()
      .references(() => rooms.code, { onDelete: "cascade" }),
    username: varchar("username", { length: 32 }).notNull(),
    body: text("body").notNull(),
    kind: varchar("kind", { length: 16 }).notNull().default("chat"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("messages_room_id_idx").on(table.roomCode, table.id)],
);

/**
 * Live presence. A row only exists while somebody occupies that username in
 * that room, which is what makes "username already taken" enforceable across
 * both the websocket server and the REST fallback.
 */
export const roomMembers = pgTable(
  "room_members",
  {
    id: serial("id").primaryKey(),
    roomCode: varchar("room_code", { length: 12 })
      .notNull()
      .references(() => rooms.code, { onDelete: "cascade" }),
    usernameKey: varchar("username_key", { length: 32 }).notNull(),
    username: varchar("username", { length: 32 }).notNull(),
    sessionId: varchar("session_id", { length: 40 }).notNull(),
    transport: varchar("transport", { length: 8 }).notNull().default("ws"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("room_members_room_username_idx").on(table.roomCode, table.usernameKey),
    index("room_members_last_seen_idx").on(table.lastSeenAt),
  ],
);

export type Room = typeof rooms.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type RoomMember = typeof roomMembers.$inferSelect;
