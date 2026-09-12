import { normalizeRoomCode, validateUsername } from "@/lib/chat";
import { apiError, json, preflight, readJsonBody } from "@/lib/http";
import { getRoom, insertMessage, publishChatEvent, releaseMembership } from "@/lib/rooms";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ code: string }> };

export function OPTIONS() {
  return preflight();
}

/** POST /api/rooms/:code/leave — release a username so somebody else can use it. */
export async function POST(request: Request, { params }: Params) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);
  const body = await readJsonBody(request);

  const check = validateUsername(body.username);
  if (!check.ok) return apiError(400, "INVALID_USERNAME", check.error);

  try {
    const room = await getRoom(code);
    if (!room) return apiError(404, "ROOM_NOT_FOUND", `no room with code ${code}`);

    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const released = await releaseMembership({ code, usernameKey: check.key, sessionId });

    if (released) {
      const systemMessage = await insertMessage({
        code,
        username: check.username,
        body: `${check.username} left the room`,
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
        event: "leave",
        username: check.username,
      });
    }

    return json({ ok: true, released, room: code, username: check.username });
  } catch (error) {
    return apiError(500, "SERVER_ERROR", (error as Error).message);
  }
}
