import {
  clampLimit,
  sanitizeRoomName,
  sanitizeTopic,
  validateUsername,
} from "@/lib/chat";
import { apiError, json, preflight, publicUrls, readJsonBody } from "@/lib/http";
import { createRoom, listRooms, toPublicRoom } from "@/lib/rooms";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

/** GET /api/rooms — recently active rooms with live member counts. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = clampLimit(url.searchParams.get("limit"), 20, 100);
  try {
    const rooms = await listRooms(limit);
    return json({ ok: true, count: rooms.length, rooms });
  } catch (error) {
    return apiError(500, "SERVER_ERROR", (error as Error).message);
  }
}

/**
 * POST /api/rooms — create a room and receive the join code.
 * Body: { name?, topic?, username?, maxMembers? }
 */
export async function POST(request: Request) {
  const body = await readJsonBody(request);

  let createdBy: string | null = null;
  if (body.username !== undefined && body.username !== null && body.username !== "") {
    const check = validateUsername(body.username);
    if (!check.ok) return apiError(400, "INVALID_USERNAME", check.error);
    createdBy = check.username;
  }

  const name = sanitizeRoomName(body.name, createdBy ? `${createdBy}'s room` : "New room");
  const topic = sanitizeTopic(body.topic);
  const maxMembersRaw = Number(body.maxMembers);
  const maxMembers = Number.isFinite(maxMembersRaw)
    ? Math.min(Math.max(Math.floor(maxMembersRaw), 2), 200)
    : 50;

  try {
    const room = await createRoom({ name, topic, createdBy, maxMembers });
    const urls = publicUrls(request);
    const payload = toPublicRoom(room);
    return json(
      {
        ok: true,
        room: payload,
        code: payload.code,
        join: {
          websocket: `${urls.ws}/ws?room=${payload.code}&username=YOUR_NAME`,
          websocketRoomPath: `${urls.ws}/api/rooms/${payload.code}/ws?username=YOUR_NAME`,
          http: `${urls.http}/api/rooms/${payload.code}/join`,
          web: `${urls.http}/?room=${payload.code}`,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return apiError(500, "SERVER_ERROR", (error as Error).message);
  }
}
