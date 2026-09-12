import { normalizeRoomCode, validateUsername } from "@/lib/chat";
import { apiError, json, preflight, readJsonBody } from "@/lib/http";
import { getRoom, listMembers, touchPresence } from "@/lib/rooms";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ code: string }> };

export function OPTIONS() {
  return preflight();
}

/** GET /api/rooms/:code/presence — who is online right now. */
export async function GET(_request: Request, { params }: Params) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);
  try {
    const room = await getRoom(code);
    if (!room) return apiError(404, "ROOM_NOT_FOUND", `no room with code ${code}`);
    const members = await listMembers(code);
    return json({ ok: true, room: code, memberCount: members.length, members });
  } catch (error) {
    return apiError(500, "SERVER_ERROR", (error as Error).message);
  }
}

/**
 * POST /api/rooms/:code/presence — heartbeat for HTTP-transport clients.
 * Body: { username, sessionId }. Call it at least every 30s or the username
 * is released back to the pool.
 */
export async function POST(request: Request, { params }: Params) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);
  const body = await readJsonBody(request);

  const check = validateUsername(body.username);
  if (!check.ok) return apiError(400, "INVALID_USERNAME", check.error);
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) return apiError(400, "MISSING_SESSION", "sessionId is required");

  try {
    const alive = await touchPresence({ code, usernameKey: check.key, sessionId });
    const members = await listMembers(code);
    if (!alive) {
      return apiError(409, "SESSION_EXPIRED", "membership expired, re-join the room", {
        members,
      });
    }
    return json({ ok: true, room: code, memberCount: members.length, members });
  } catch (error) {
    return apiError(500, "SERVER_ERROR", (error as Error).message);
  }
}
