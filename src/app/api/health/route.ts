import { sql } from "drizzle-orm";

import { db } from "@/db";
import { json, publicUrls } from "@/lib/http";

export const dynamic = "force-dynamic";

type HubSnapshot = {
  hubId: string;
  rooms: number;
  sockets: number;
  connections: number;
  messages: number;
  startedAt: string;
};

export async function GET(request: Request) {
  const hub = (
    globalThis as typeof globalThis & { __chatHub?: { snapshot: () => HubSnapshot } }
  ).__chatHub;

  try {
    await db.execute(sql`select 1`);
    const urls = publicUrls(request);
    return json({
      ok: true,
      service: "render-chat",
      database: "up",
      websocket: hub
        ? { enabled: true, url: `${urls.ws}/ws`, ...hub.snapshot() }
        : { enabled: false, reason: "custom server not active (HTTP fallback only)" },
      time: new Date().toISOString(),
    });
  } catch (error) {
    return json(
      { ok: false, database: "down", message: (error as Error).message },
      { status: 500 },
    );
  }
}
