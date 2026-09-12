import { normalizeRoomCode } from "@/lib/chat";
import { apiError, json, preflight, publicUrls } from "@/lib/http";
import { listMembers, getRoom, toPublicRoom } from "@/lib/rooms";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ code: string }> };

export function OPTIONS() {
  return preflight();
}

/** GET /api/rooms/:code — room metadata plus the live member roster. */
export async function GET(request: Request, { params }: Params) {
  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);
  if (!code) return apiError(400, "INVALID_CODE", "room code is required");

  try {
    const room = await getRoom(code);
    if (!room) return apiError(404, "ROOM_NOT_FOUND", `no room with code ${code}`);
    const members = await listMembers(code);
    const urls = publicUrls(request);
    return json({
      ok: true,
      room: toPublicRoom(room),
      members,
      memberCount: members.length,
      join: {
        websocket: `${urls.ws}/ws?room=${code}&username=YOUR_NAME`,
        websocketRoomPath: `${urls.ws}/api/rooms/${code}/ws?username=YOUR_NAME`,
        http: `${urls.http}/api/rooms/${code}/join`,
      },
    });
  } catch (error) {
    return apiError(500, "SERVER_ERROR", (error as Error).message);
  }
}
