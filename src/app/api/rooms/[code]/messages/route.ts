import { clampLimit, normalizeRoomCode, sanitizeMessage, validateUsername } from "@/lib/chat";
import { apiError, json, preflight, readJsonBody } from "@/lib/http";
import {
  getRoom,
  insertMessage,
  listMessages,
  publishChatEvent,
  touchPresence,
} from "@/lib/rooms";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ code: string }> };

export function OPTIONS() {
  return preflight();
}

/** GET /api/rooms/:code/messages?after=<id>&before=<id>&limit=<n> */
export async function GET(request: Request, { params }: Params) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);
  const url = new URL(request.url);

  const afterRaw = url.searchParams.get("after");
  const beforeRaw = url.searchParams.get("before");
  const after = afterRaw !== null && afterRaw !== "" ? Number(afterRaw) : undefined;
  const before = beforeRaw !== null && beforeRaw !== "" ? Number(beforeRaw) : undefined;

  try {
    const room = await getRoom(code);
    if (!room) return apiError(404, "ROOM_NOT_FOUND", `no room with code ${code}`);

    const items = await listMessages({
      code,
      after: Number.isFinite(after) ? after : undefined,
      before: Number.isFinite(before) ? before : undefined,
      limit: clampLimit(url.searchParams.get("limit"), 50, 200),
    });

    return json({
      ok: true,
      room: code,
      count: items.length,
      cursor: items.length ? items[items.length - 1].id : (after ?? 0),
      messages: items,
    });
  } catch (error) {
    return apiError(500, "SERVER_ERROR", (error as Error).message);
  }
}

/**
 * POST /api/rooms/:code/messages
 * Body: { username, text, sessionId? } — HTTP twin of the websocket
 * `{"type":"message"}` frame. The message is fanned out to live sockets
 * through Postgres NOTIFY.
 */
export async function POST(request: Request, { params }: Params) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);
  const body = await readJsonBody(request);

  const check = validateUsername(body.username);
  if (!check.ok) return apiError(400, "INVALID_USERNAME", check.error);

  const text = sanitizeMessage(body.text ?? body.body ?? body.message);
  if (!text) return apiError(400, "EMPTY_MESSAGE", "text is required");

  try {
    const room = await getRoom(code);
    if (!room) return apiError(404, "ROOM_NOT_FOUND", `no room with code ${code}`);

    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (sessionId) {
      const alive = await touchPresence({ code, usernameKey: check.key, sessionId });
      if (!alive) {
        return apiError(
          403,
          "NOT_JOINED",
          "session is not a member of this room, call /join first",
        );
      }
    }

    const message = await insertMessage({ code, username: check.username, body: text });
    await publishChatEvent({ v: 1, origin: "http", type: "message", room: code, message });

    return json({ ok: true, message }, { status: 201 });
  } catch (error) {
    return apiError(500, "SERVER_ERROR", (error as Error).message);
  }
}
