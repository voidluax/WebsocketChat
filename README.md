# RenderChat — free-tier WebSocket chat rooms

A complete realtime chat app that runs as **one Render free-tier web service**: Next.js UI + REST API +
its own WebSocket server, all on the single port Render exposes.

```
https://name.onrender.com          → web UI (lobby + chat rooms)
https://name.onrender.com/api/...  → REST API (create rooms, history, members)
wss://name.onrender.com            → WebSocket gateway (also /ws, /chat, /ws/<CODE>)
```

* 🔑 **Create a room, get a code** — `POST /api/rooms` (or a `create_room` websocket frame) returns a short
  code like `K7QF2M`. Share the code, others join with it.
* 👤 **Usernames are unique per room** — if a username is already in the room the join is refused:
  HTTP `409 USERNAME_TAKEN` / websocket close code `4409`. The client never enters the room.
* 💾 **Postgres optional** — set `DATABASE_URL` for persistent history, otherwise the server falls back to an
  in-memory store so a bare free-tier service still works.
* ♻️ **Free-tier friendly** — heartbeats, auto-reconnect with backoff and stale-member cleanup for cold starts.

---

## Render deployment (copy/paste)

Create a **Web Service** on Render (Runtime: **Node**) pointing at this repo, then:

| Setting | Value |
| --- | --- |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm run start` |
| Health Check Path | `/api/health` |
| Instance Type | Free |

`npm run start` runs `NODE_ENV=production node server.mjs`, which boots Next.js, the REST router and the
WebSocket server on `$PORT` (Render injects it). **Do not use `next start`** — it cannot serve the websocket
upgrade.

Alternative one-liners if you prefer them inline:

```bash
# Build Command
npm ci && npm run build

# Start Command
NODE_ENV=production node server.mjs
```

Optional environment variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | *(unset)* | Postgres connection string. Unset → in-memory store. |
| `PORT` | `3000` | Provided automatically by Render. |
| `HOST` | `0.0.0.0` | Bind address. |

This repo also ships a `render.yaml` blueprint — push it and use **New → Blueprint** on Render.

> Free instances spin down after ~15 minutes of inactivity; the first request after that takes a few seconds
> and open websockets are dropped. The bundled client reconnects automatically with exponential backoff.

---

## Quick start (local)

```bash
npm install
cp .env.example .env        # optional, only if you want Postgres persistence
npm run dev                 # http://localhost:3000  (ws://localhost:3000/ws)
```

Production-like run: `npm run build && npm run start`.

---

## REST API

Base URL: `https://name.onrender.com`. All responses are JSON, CORS is open (`*`), bodies are JSON
(`application/x-www-form-urlencoded` is also accepted).

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/rooms` | Create a room → returns the join **code** |
| `GET` | `/api/rooms/new?name=Demo` | Same thing, browser friendly |
| `GET` | `/api/rooms?limit=25` | List public rooms with live member counts |
| `GET` | `/api/rooms/:code` | Room details + members + connection URLs |
| `GET` | `/api/rooms/:code/available?username=ada` | Check whether a username is free |
| `POST` | `/api/rooms/:code/join` | Claim a username → `{ token }` (409 if taken) |
| `POST` | `/api/rooms/:code/messages` | Send a message over HTTP |
| `GET` | `/api/rooms/:code/messages?after=0&limit=50` | Message history |
| `GET` | `/api/rooms/:code/members` | Current members |
| `POST` | `/api/rooms/:code/heartbeat` | Keep an HTTP membership alive (< 90 s) |
| `POST` \| `DELETE` | `/api/rooms/:code/leave` | Release the username |
| `GET` | `/api/stats` | Counters + which storage backend is active |
| `GET` | `/api/health` | Health check (used by Render) |

### Create a room

```bash
curl -X POST https://name.onrender.com/api/rooms \
  -H "content-type: application/json" \
  -d '{"name":"Design sync","isPrivate":false}'
```

```json
{
  "ok": true,
  "code": "K7QF2M",
  "room": {
    "code": "K7QF2M",
    "name": "Design sync",
    "isPrivate": false,
    "createdAt": "2026-01-01T10:00:00.000Z",
    "lastActiveAt": "2026-01-01T10:00:00.000Z",
    "memberCount": 0
  },
  "websocketUrl": "wss://name.onrender.com/ws?room=K7QF2M",
  "websocketRootUrl": "wss://name.onrender.com/?room=K7QF2M",
  "restUrl": "https://name.onrender.com/api/rooms/K7QF2M",
  "joinUrl": "https://name.onrender.com/r/K7QF2M"
}
```

Body fields (all optional): `name` (≤ 60 chars), `isPrivate` (hides it from `GET /api/rooms`),
`username` (creates the room **and** immediately reserves that username, returning a `token`).

### Join a room over HTTP

```bash
curl -X POST https://name.onrender.com/api/rooms/K7QF2M/join \
  -H "content-type: application/json" \
  -d '{"username":"ada"}'
```

```json
{ "ok": true, "username": "ada", "token": "0f1c…", "room": { "...": "..." }, "history": [] }
```

If somebody already holds that name:

```json
HTTP/1.1 409 Conflict
{ "ok": false, "error": { "code": "USERNAME_TAKEN",
  "message": "The username \"ada\" is already in room K7QF2M. Pick another one." } }
```

### Send / read messages over HTTP

```bash
curl -X POST https://name.onrender.com/api/rooms/K7QF2M/messages \
  -H "content-type: application/json" \
  -d '{"username":"ada","token":"0f1c…","text":"hello from curl"}'

curl "https://name.onrender.com/api/rooms/K7QF2M/messages?after=0&limit=50"
```

HTTP-posted messages are broadcast to every connected websocket in the room instantly (REST and WS share
one process and one hub). HTTP members must send `POST /api/rooms/:code/heartbeat` at least every 90 s or
their username is released.

---

## WebSocket API

Any of these upgrade paths work — they behave identically:

```
wss://name.onrender.com/
wss://name.onrender.com/ws
wss://name.onrender.com/chat
wss://name.onrender.com/ws/K7QF2M
```

Query parameters (optional, they let you skip the join frame):

| Param | Example | Meaning |
| --- | --- | --- |
| `room` / `code` | `?room=K7QF2M` | Room to join on connect |
| `username` / `user` | `&username=ada` | Username to claim |
| `create` | `?create=1&name=Standup&username=ada` | Create a new room, then join it |

```js
const ws = new WebSocket("wss://name.onrender.com/ws?room=K7QF2M&username=ada");

ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.type === "message") console.log(`${frame.username}: ${frame.text}`);
  if (frame.type === "error" && frame.code === "USERNAME_TAKEN") alert(frame.message);
};

ws.onopen = () => ws.send(JSON.stringify({ type: "message", text: "hello world" }));
ws.onclose = (event) => console.log("closed", event.code); // 4409 = username taken
```

### Client → server frames

| `type` | Payload | Notes |
| --- | --- | --- |
| `create_room` | `{ "type":"create_room", "name":"Standup", "username":"ada", "isPrivate":false }` | Replies `room_created`; auto-joins when `username` is given |
| `join` | `{ "type":"join", "room":"K7QF2M", "username":"ada", "history":50 }` | Replies `joined` or `error` |
| `message` | `{ "type":"message", "text":"hi", "clientId":"c1" }` | `chat`/`send` are aliases; a bare text frame also works |
| `typing` | `{ "type":"typing", "state":true }` | Relayed to everyone else |
| `members` | `{ "type":"members" }` | Replies `presence` |
| `history` | `{ "type":"history", "after":0, "limit":50 }` | Replies `history` |
| `leave` | `{ "type":"leave" }` | Releases the username, keeps the socket open |
| `ping` | `{ "type":"ping" }` | Replies `pong` (protocol-level pings are also sent every 25 s) |

### Server → client frames

```jsonc
{ "type": "welcome", "protocolVersion": 1, "serverTime": "…", "storage": "postgres" }
{ "type": "room_created", "code": "K7QF2M", "room": { … } }
{ "type": "joined", "code": "K7QF2M", "username": "ada", "token": "…",
  "members": [ { "username": "ada", "transport": "ws", "joinedAt": "…" } ],
  "history": [ { "id": 1, "kind": "chat", "username": "bob", "text": "hi", "ts": "…" } ] }
{ "type": "message", "id": 42, "room": "K7QF2M", "kind": "chat",
  "username": "bob", "text": "hi", "ts": "…" }          // kind:"system" for join/leave notices
{ "type": "presence", "count": 2, "members": [ … ] }
{ "type": "typing", "username": "bob", "state": true }
{ "type": "error", "code": "USERNAME_TAKEN", "message": "…" }
{ "type": "pong", "ts": "…" }
```

Your own messages come back with `"self": true` and echo the `clientId` you sent.

### Errors & close codes

| Code | HTTP | WS close | When |
| --- | --- | --- | --- |
| `USERNAME_TAKEN` | 409 | `4409` | The username is already in that room |
| `ROOM_NOT_FOUND` | 404 | `4404` | Unknown room code |
| `INVALID_USERNAME` | 400 | `4400` | Not 2–24 chars of `A-Z a-z 0-9 . _ - space` |
| `INVALID_CODE` | 400 | `4400` | Codes are 4–12 alphanumerics |
| `NOT_IN_ROOM` | 403 | — | Sent a message before joining |
| `INVALID_MESSAGE` | 400 | — | Empty or > 2000 characters |
| `RATE_LIMITED` | 429 | `4429` | > 20 messages / 10 s per user, > 15 rooms / min per IP |

### Node client example

```js
import WebSocket from "ws";

const res = await fetch("https://name.onrender.com/api/rooms", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Bot room" }),
});
const { code } = await res.json();

const ws = new WebSocket(`wss://name.onrender.com/ws?room=${code}&username=bot`);
ws.on("message", (data) => console.log(JSON.parse(data.toString())));
ws.on("open", () => ws.send(JSON.stringify({ type: "message", text: "beep boop" })));
```

---

## How usernames stay unique

1. `room_members` has a unique index on `(room_id, lower(username))`.
2. Joining performs an `INSERT … ON CONFLICT DO NOTHING`; zero rows returned ⇒ the name is taken ⇒
   `USERNAME_TAKEN` (HTTP 409 / WS close 4409) and the socket is closed before it joins the room.
3. Disconnecting (or 90 s without a heartbeat, e.g. after a free-tier spin-down) releases the name.

## Project layout

```
server.mjs              custom Node server: Next.js + REST + WebSocket on one port
server/store.mjs        Postgres store (auto-creates tables) with in-memory fallback
server/hub.mjs          rooms/members/messages logic + broadcast fan-out
server/api.mjs          /api/rooms* REST router
server/ws.mjs           websocket gateway (join, presence, typing, heartbeats)
src/app/                Next.js App Router UI (lobby, /r/[code] chat, /docs)
src/db/schema.ts        Drizzle schema (same tables the server creates)
```

## License

MIT
