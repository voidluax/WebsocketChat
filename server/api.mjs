/**
 * Plain Node REST router mounted in front of Next.js for `/api/rooms*`.
 * Living in the custom server means REST and websockets share one process,
 * one store and one broadcast hub.
 */
import { clampLimit, normalizeCode, publicRoom, validateUsername } from "./util.mjs";

const MAX_BODY_BYTES = 64 * 1024;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-chat-token",
  "access-control-max-age": "86400",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

function fail(res, result) {
  return sendJson(res, result.status ?? 400, {
    ok: false,
    error: { code: result.code ?? "BAD_REQUEST", message: result.message ?? "Bad request" },
  });
}

async function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve({ ok: false, error: "body too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({ ok: true, value: {} });
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({ ok: true, value: {} });
      try {
        const parsed = JSON.parse(raw);
        resolve({ ok: true, value: parsed && typeof parsed === "object" ? parsed : {} });
      } catch {
        // also accept x-www-form-urlencoded for quick curl usage
        try {
          const params = new URLSearchParams(raw);
          const value = Object.fromEntries(params.entries());
          resolve({ ok: true, value });
        } catch {
          resolve({ ok: false, error: "invalid JSON body" });
        }
      }
    });
    req.on("error", () => resolve({ ok: false, error: "could not read body" }));
  });
}

function clientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function publicOrigin(req) {
  const external = process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL;
  if (external) {
    const url = new URL(external);
    const secure = url.protocol === "https:";
    return {
      http: `${secure ? "https" : "http"}://${url.host}`,
      ws: `${secure ? "wss" : "ws"}://${url.host}`,
    };
  }
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").toString();
  const forwardedProto = req.headers["x-forwarded-proto"]?.toString().split(",")[0];
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(host);
  // Behind Render (or any proxy) assume TLS unless we are clearly on localhost.
  const proto = forwardedProto ?? (isLocal ? "http" : "https");
  return { http: `${proto}://${host}`, ws: `${proto === "https" ? "wss" : "ws"}://${host}` };
}

function connectionInfo(req, code, username) {
  const origin = publicOrigin(req);
  const query = new URLSearchParams({ room: code });
  if (username) query.set("username", username);
  return {
    websocketUrl: `${origin.ws}/ws?${query.toString()}`,
    websocketRootUrl: `${origin.ws}/?${query.toString()}`,
    restUrl: `${origin.http}/api/rooms/${code}`,
    joinUrl: `${origin.http}/r/${code}`,
  };
}

/**
 * @returns {Promise<boolean>} true when the request was handled here.
 */
export async function handleApi(req, res, hub) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (!path.startsWith("/api/rooms") && path !== "/api/stats") return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  const segments = path.split("/").filter(Boolean); // ['api','rooms', code?, action?]

  try {
    if (path === "/api/stats" && req.method === "GET") {
      const stats = await hub.store.stats();
      sendJson(res, 200, { ok: true, storage: hub.store.kind, ...stats, liveSockets: [...hub.sockets.values()].reduce((n, s) => n + s.size, 0) });
      return true;
    }

    /* ----------------------------- /api/rooms ---------------------------- */
    if (segments.length === 2) {
      if (req.method === "GET") {
        const limit = clampLimit(url.searchParams.get("limit"), 25, 100);
        const rooms = await hub.store.listRooms(limit);
        sendJson(res, 200, {
          ok: true,
          count: rooms.length,
          rooms: rooms.map((room) => publicRoom(room, room.memberCount ?? 0)),
        });
        return true;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body.ok) return fail(res, { status: 400, code: "BAD_REQUEST", message: body.error }), true;
        return (await createRoomResponse(req, res, hub, body.value)), true;
      }
      res.writeHead(405, { allow: "GET, POST, OPTIONS", ...CORS_HEADERS });
      res.end();
      return true;
    }

    /* --------------------- /api/rooms/new (browser helper) --------------- */
    if (segments.length === 3 && segments[2].toLowerCase() === "new" && req.method === "GET") {
      await createRoomResponse(req, res, hub, {
        name: url.searchParams.get("name"),
        username: url.searchParams.get("username"),
        isPrivate: url.searchParams.get("private") === "true",
      });
      return true;
    }

    const code = normalizeCode(segments[2]);
    if (!code) {
      fail(res, { status: 400, code: "INVALID_CODE", message: "Room codes are 4-12 alphanumeric characters." });
      return true;
    }
    const action = segments[3]?.toLowerCase();

    /* -------------------------- /api/rooms/:code ------------------------- */
    if (!action) {
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET, OPTIONS", ...CORS_HEADERS });
        res.end();
        return true;
      }
      const found = await hub.getRoomOr404(code);
      if (!found.ok) return fail(res, found), true;
      const members = await hub.store.listMembers(code);
      sendJson(res, 200, {
        ok: true,
        room: publicRoom(found.room, members.length),
        members: members.map((m) => ({ username: m.username, transport: m.transport, joinedAt: new Date(m.joinedAt).toISOString() })),
        ...connectionInfo(req, code),
      });
      return true;
    }

    /* ---------------------- /api/rooms/:code/members --------------------- */
    if (action === "members" && req.method === "GET") {
      const found = await hub.getRoomOr404(code);
      if (!found.ok) return fail(res, found), true;
      const members = await hub.store.listMembers(code);
      sendJson(res, 200, {
        ok: true,
        room: code,
        count: members.length,
        members: members.map((m) => ({ username: m.username, transport: m.transport, joinedAt: new Date(m.joinedAt).toISOString() })),
      });
      return true;
    }

    /* --------------------- /api/rooms/:code/available -------------------- */
    if (action === "available" && req.method === "GET") {
      const found = await hub.getRoomOr404(code);
      if (!found.ok) return fail(res, found), true;
      const check = validateUsername(url.searchParams.get("username") ?? "");
      if (!check.ok) return fail(res, { status: 400, code: "INVALID_USERNAME", message: check.error }), true;
      const taken = await hub.store.isUsernameTaken(code, check.value);
      sendJson(res, 200, { ok: true, room: code, username: check.value, available: !taken });
      return true;
    }

    /* ------------------------ /api/rooms/:code/join ---------------------- */
    if (action === "join" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.ok) return fail(res, { status: 400, code: "BAD_REQUEST", message: body.error }), true;
      const result = await hub.join({
        code,
        username: body.value.username ?? url.searchParams.get("username"),
        transport: "http",
      });
      if (!result.ok) return fail(res, result), true;
      await hub.broadcastPresence(code);
      const history = await hub.history(code, { limit: clampLimit(body.value.history, 50, 200) });
      sendJson(res, 201, {
        ok: true,
        room: publicRoom(result.room, (await hub.store.listMembers(code)).length),
        username: result.member.username,
        token: result.member.token,
        history,
        ...connectionInfo(req, code, result.member.username),
      });
      return true;
    }

    /* ----------------------- /api/rooms/:code/leave ---------------------- */
    if (action === "leave" && (req.method === "POST" || req.method === "DELETE")) {
      const body = await readJsonBody(req);
      const username = body.value?.username ?? url.searchParams.get("username");
      const token = body.value?.token ?? req.headers["x-chat-token"] ?? url.searchParams.get("token");
      if (!username) return fail(res, { status: 400, code: "BAD_REQUEST", message: "username is required" }), true;
      const result = await hub.leave({ code, username, token: token ? String(token) : undefined });
      if (!result.ok) return fail(res, result), true;
      sendJson(res, 200, { ok: true, room: code, username });
      return true;
    }

    /* --------------------- /api/rooms/:code/heartbeat -------------------- */
    if (action === "heartbeat" && req.method === "POST") {
      const body = await readJsonBody(req);
      const username = body.value?.username ?? url.searchParams.get("username");
      if (!username) return fail(res, { status: 400, code: "BAD_REQUEST", message: "username is required" }), true;
      const alive = await hub.store.touchMember(code, String(username));
      if (!alive) return fail(res, { status: 404, code: "NOT_IN_ROOM", message: "Member not found in room." }), true;
      sendJson(res, 200, { ok: true, room: code, username, ts: new Date().toISOString() });
      return true;
    }

    /* ---------------------- /api/rooms/:code/messages -------------------- */
    if (action === "messages") {
      if (req.method === "GET") {
        const found = await hub.getRoomOr404(code);
        if (!found.ok) return fail(res, found), true;
        const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
        const limit = clampLimit(url.searchParams.get("limit"), 50, 200);
        const messages = await hub.history(code, { after, limit });
        sendJson(res, 200, { ok: true, room: code, count: messages.length, messages });
        return true;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body.ok) return fail(res, { status: 400, code: "BAD_REQUEST", message: body.error }), true;
        const username = body.value.username ?? url.searchParams.get("username");
        const token = body.value.token ?? req.headers["x-chat-token"];
        if (!username) return fail(res, { status: 400, code: "BAD_REQUEST", message: "username is required" }), true;
        const result = await hub.postMessage({
          code,
          username: String(username),
          text: body.value.text ?? body.value.message ?? "",
          token: token ? String(token) : undefined,
        });
        if (!result.ok) return fail(res, result), true;
        sendJson(res, 201, { ok: true, message: result.message });
        return true;
      }
      res.writeHead(405, { allow: "GET, POST, OPTIONS", ...CORS_HEADERS });
      res.end();
      return true;
    }

    fail(res, { status: 404, code: "NOT_FOUND", message: `Unknown endpoint ${req.method} ${path}` });
    return true;
  } catch (error) {
    console.error("[api] error:", error);
    sendJson(res, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
    return true;
  }
}

async function createRoomResponse(req, res, hub, input) {
  const created = await hub.createRoom({
    name: input.name,
    isPrivate: input.isPrivate ?? input.private,
    clientKey: clientKey(req),
  });
  if (!created.ok) return fail(res, created);

  const code = created.room.code;
  let membership = null;
  if (input.username) {
    const joined = await hub.join({ code, username: input.username, transport: "http" });
    if (!joined.ok) return fail(res, joined);
    membership = { username: joined.member.username, token: joined.member.token };
  }

  sendJson(res, 201, {
    ok: true,
    room: { ...created.room, memberCount: membership ? 1 : 0 },
    code,
    ...(membership ?? {}),
    ...connectionInfo(req, code, membership?.username),
  });
}
