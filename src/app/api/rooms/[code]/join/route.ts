import { clampLimit, newSessionId, normalizeRoomCode, validateUsername } from "@/lib/chat";
import { apiError, json, preflight, publicUrls, readJsonBody } from "@/lib/http";
import {
  claimMembership,
  getRoom,
  insertMessage,
  listMembers,
  listMessages,
  publishChatEvent,
  toPublicRoom,
} from "@/lib/rooms";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ code: string }> };

export function OPTIONS() {
  return preflight();
}

/**
 * POST /api/rooms/:code/join
 * Body: { username, sessionId? }
 * 409 USERNAME_TAKEN when the name is already occupied in that room.
 */
export async function POST(request: Request, { params }: Params) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);
  const body = await readJsonBody(request);

  const check = validateUsername(body.username);
  if (!check.ok) return apiError(400, "INVALID_USERNAME", check.error);

  try {
    const room = await getRoom(code);
    if (!room) return apiError(404, "ROOM_NOT_FOUND", `no room with code ${code}`);
    if (room.isLocked) return apiError(423, "ROOM_LOCKED", "this room is locked");

    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.length >= 8
        ? body.sessionId.slice(0, 40)
        : newSessionId();

    const claim = await claimMembership({
      code,
      username: check.username,
      usernameKey: check.key,
      sessionId,
      transport: "http",
      maxMembers: room.maxMembers,
    });

    if (claim.status === "taken") {
      return apiError(
        409,
        "USERNAME_TAKEN",
        `the username "${check.username}" is already in room ${code}`,
        { room: code, username: check.username },
      );
    }
    if (claim.status === "full") {
      return apiError(403, "ROOM_FULL", `room ${code} is full (${room.maxMembers} members)`);
    }

    if (claim.status === "joined") {
      const systemMessage = await insertMessage({
        code,
        username: check.username,
        body: `${check.username} joined the room`,
        kind: "system",
      });
      await publishChatEvent({
        v: 1,
        origin: "http",
        type: "message",
        room: code,
        message: systemMessage,
      });
      await publishChatEvent({
        v: 1,
        origin: "http",
        type: "presence",
        room: code,
        event: "join",
        username: check.username,
      });
    }

    const [members, history] = await Promise.all([
      listMembers(code),
      listMessages({ code, limit: clampLimit(body.history, 50, 200) }),
    ]);
    const urls = publicUrls(request);

    return json({
      ok: true,
      status: claim.status,
      room: toPublicRoom(room),
      username: check.username,
      sessionId,
      members,
      history,
      cursor: history.length ? history[history.length - 1].id : 0,
      endpoints: {
        websocket: `${urls.ws}/ws?room=${code}&username=${encodeURIComponent(check.username)}`,
        messages: `${urls.http}/api/rooms/${code}/messages`,
        presence: `${urls.http}/api/rooms/${code}/presence`,
        leave: `${urls.http}/api/rooms/${code}/leave`,
      },
    });
  } catch (error) {
    return apiError(500, "SERVER_ERROR", (error as Error).message);
  }
}
