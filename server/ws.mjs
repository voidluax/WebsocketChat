/**
 * Websocket gateway.
 *
 * Accepted upgrade paths (all equivalent):
 *   wss://host/                 wss://host/ws
 *   wss://host/chat             wss://host/ws/<ROOM_CODE>
 *
 * Query params: ?room=CODE&username=NAME  (auto join)
 *               ?create=1&name=My+Room&username=NAME (create + join)
 */
import { WebSocketServer } from "ws";
import { clampLimit, normalizeCode, publicRoom } from "./util.mjs";

export const WS_PATHS = new Set(["/", "/ws", "/chat", "/socket", "/websocket"]);

const CLOSE = {
  BAD_REQUEST: 4400,
  ROOM_NOT_FOUND: 4404,
  USERNAME_TAKEN: 4409,
  RATE_LIMITED: 4429,
  SERVER_SHUTDOWN: 4500,
};

const HEARTBEAT_MS = 25_000;
const PRESENCE_TOUCH_MS = 30_000;

export function isWebsocketPath(pathname) {
  if (WS_PATHS.has(pathname)) return true;
  return /^\/ws\/[A-Za-z0-9]{4,12}$/.test(pathname);
}

function send(socket, payload) {
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(payload));
}

function sendError(socket, code, message, { fatal = false, closeCode } = {}) {
  send(socket, { type: "error", code, message, ts: new Date().toISOString() });
  if (fatal) {
    setTimeout(() => socket.close(closeCode ?? CLOSE.BAD_REQUEST, code), 30);
  }
}

export function attachWebsocketServer(server, hub) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      /* keep default */
    }
    if (!isWebsocketPath(pathname)) return; // let Next.js handle (HMR etc.)
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathMatch = /^\/ws\/([A-Za-z0-9]{4,12})$/.exec(url.pathname);

    socket.isAlive = true;
    socket.chatRoom = null;
    socket.chatUsername = null;
    socket.chatToken = null;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    send(socket, {
      type: "welcome",
      message: "Connected to the chat gateway.",
      protocolVersion: 1,
      serverTime: new Date().toISOString(),
      storage: hub.store.kind,
      usage: {
        create_room: { type: "create_room", name: "My room", username: "optional" },
        join: { type: "join", room: "ABC123", username: "yourname" },
        message: { type: "message", text: "hello" },
        others: ["typing", "members", "history", "leave", "ping"],
      },
    });

    const bootRoom = normalizeCode(url.searchParams.get("room") ?? url.searchParams.get("code") ?? pathMatch?.[1] ?? "");
    const bootUser = url.searchParams.get("username") ?? url.searchParams.get("user");
    const wantsCreate = ["1", "true", "yes"].includes((url.searchParams.get("create") ?? "").toLowerCase());

    (async () => {
      if (wantsCreate) {
        await handleCreateRoom(socket, hub, {
          name: url.searchParams.get("name"),
          isPrivate: url.searchParams.get("private") === "true",
          username: bootUser ?? undefined,
        });
        return;
      }
      if (bootRoom && bootUser) {
        await handleJoin(socket, hub, { room: bootRoom, username: bootUser, history: 50 });
      }
    })().catch((error) => {
      console.error("[ws] boot error:", error);
      sendError(socket, "INTERNAL_ERROR", "Could not complete the connection request.");
    });

    socket.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        // Bare text frames are treated as chat messages for convenience.
        frame = { type: "message", text: raw.toString() };
      }
      if (!frame || typeof frame !== "object" || typeof frame.type !== "string") {
        sendError(socket, "BAD_REQUEST", 'Every frame needs a "type" field.');
        return;
      }
      handleFrame(socket, hub, frame).catch((error) => {
        console.error("[ws] frame error:", error);
        sendError(socket, "INTERNAL_ERROR", "Something went wrong handling that frame.");
      });
    });

    socket.on("close", () => {
      void teardown(socket, hub);
    });
    socket.on("error", () => {
      void teardown(socket, hub);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  const presence = setInterval(async () => {
    try {
      for (const socket of wss.clients) {
        if (socket.chatRoom && socket.chatUsername) {
          await hub.store.touchMember(socket.chatRoom, socket.chatUsername);
        }
      }
      await hub.store.pruneStaleMembers();
      hub.messageLimiter.sweep();
      hub.roomLimiter.sweep();
    } catch (error) {
      console.error("[ws] presence sweep failed:", error.message);
    }
  }, PRESENCE_TOUCH_MS);

  const stop = () => {
    clearInterval(heartbeat);
    clearInterval(presence);
    for (const socket of wss.clients) socket.close(CLOSE.SERVER_SHUTDOWN, "server shutting down");
    wss.close();
  };

  return { wss, stop };
}

async function handleFrame(socket, hub, frame) {
  switch (frame.type) {
    case "ping":
      send(socket, { type: "pong", ts: new Date().toISOString() });
      return;

    case "create_room":
    case "create":
      await handleCreateRoom(socket, hub, {
        name: frame.name ?? frame.room,
        isPrivate: frame.isPrivate ?? frame.private,
        username: frame.username,
        autoJoin: frame.autoJoin !== false,
      });
      return;

    case "join":
      await handleJoin(socket, hub, {
        room: frame.room ?? frame.code,
        username: frame.username,
        history: frame.history,
      });
      return;

    case "message":
    case "chat":
    case "send": {
      if (!socket.chatRoom || !socket.chatUsername) {
        sendError(socket, "NOT_IN_ROOM", "Send a join frame before chatting.");
        return;
      }
      const result = await hub.postMessage({
        code: socket.chatRoom,
        username: socket.chatUsername,
        token: socket.chatToken,
        text: frame.text ?? frame.message ?? frame.body ?? "",
        except: socket,
      });
      if (!result.ok) {
        sendError(socket, result.code, result.message);
        return;
      }
      send(socket, { ...result.message, self: true, clientId: frame.clientId ?? null });
      return;
    }

    case "typing": {
      if (!socket.chatRoom || !socket.chatUsername) return;
      hub.broadcast(socket.chatRoom, {
        type: "typing",
        room: socket.chatRoom,
        username: socket.chatUsername,
        state: frame.state !== false,
        ts: new Date().toISOString(),
      }, { except: socket });
      return;
    }

    case "members":
    case "presence": {
      if (!socket.chatRoom) {
        sendError(socket, "NOT_IN_ROOM", "Join a room first.");
        return;
      }
      const members = await hub.store.listMembers(socket.chatRoom);
      send(socket, {
        type: "presence",
        room: socket.chatRoom,
        count: members.length,
        members: members.map((m) => ({
          username: m.username,
          transport: m.transport,
          joinedAt: new Date(m.joinedAt).toISOString(),
        })),
        ts: new Date().toISOString(),
      });
      return;
    }

    case "history": {
      if (!socket.chatRoom) {
        sendError(socket, "NOT_IN_ROOM", "Join a room first.");
        return;
      }
      const messages = await hub.history(socket.chatRoom, {
        after: Number.parseInt(String(frame.after ?? 0), 10) || 0,
        limit: clampLimit(frame.limit, 50, 200),
      });
      send(socket, { type: "history", room: socket.chatRoom, messages });
      return;
    }

    case "leave": {
      await teardown(socket, hub, "left the room");
      send(socket, { type: "left", ts: new Date().toISOString() });
      return;
    }

    default:
      sendError(socket, "UNKNOWN_TYPE", `Unsupported frame type "${frame.type}".`);
  }
}

async function handleCreateRoom(socket, hub, { name, isPrivate, username, autoJoin = true }) {
  const created = await hub.createRoom({
    name,
    isPrivate,
    clientKey: socket._socket?.remoteAddress ?? "ws",
  });
  if (!created.ok) {
    sendError(socket, created.code, created.message, {
      fatal: false,
      closeCode: CLOSE.RATE_LIMITED,
    });
    return;
  }
  send(socket, {
    type: "room_created",
    room: created.room,
    code: created.room.code,
    ts: new Date().toISOString(),
  });
  if (autoJoin && username) {
    await handleJoin(socket, hub, { room: created.room.code, username, history: 50 });
  }
}

async function handleJoin(socket, hub, { room, username, history }) {
  const code = normalizeCode(room ?? "");
  if (!code) {
    sendError(socket, "INVALID_CODE", "Room codes are 4-12 alphanumeric characters.");
    return;
  }
  if (socket.chatRoom) {
    await teardown(socket, hub, "switched rooms");
  }

  const result = await hub.join({ code, username, transport: "ws" });
  if (!result.ok) {
    // Username collisions close the socket with 4409 so clients can react.
    const fatal = result.code === "USERNAME_TAKEN" || result.code === "ROOM_NOT_FOUND";
    sendError(socket, result.code, result.message, {
      fatal,
      closeCode: result.code === "USERNAME_TAKEN" ? CLOSE.USERNAME_TAKEN : CLOSE.ROOM_NOT_FOUND,
    });
    return;
  }

  socket.chatRoom = code;
  socket.chatUsername = result.member.username;
  socket.chatToken = result.member.token;
  hub.register(code, socket);

  const members = await hub.store.listMembers(code);
  const messages = await hub.history(code, { limit: clampLimit(history, 50, 200) });

  send(socket, {
    type: "joined",
    room: publicRoom(result.room, members.length),
    code,
    username: result.member.username,
    token: result.member.token,
    members: members.map((m) => ({
      username: m.username,
      transport: m.transport,
      joinedAt: new Date(m.joinedAt).toISOString(),
    })),
    history: messages,
    ts: new Date().toISOString(),
  });

  await hub.broadcastPresence(code);
}

async function teardown(socket, hub, reason = "left the room") {
  const code = socket.chatRoom;
  const username = socket.chatUsername;
  const token = socket.chatToken;
  socket.chatRoom = null;
  socket.chatUsername = null;
  socket.chatToken = null;
  if (!code || !username) return;
  hub.unregister(code, socket);
  try {
    await hub.leave({ code, username, token, reason });
  } catch (error) {
    console.error("[ws] teardown failed:", error.message);
  }
}
