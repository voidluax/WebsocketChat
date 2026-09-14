export const dynamic = "force-dynamic";

/**
 * Health check used by Render (`healthCheckPath: /api/health`).
 *
 * The chat server works with or without Postgres, so a missing/unreachable
 * database reports `storage: "memory"`/`"degraded"` instead of failing the
 * deploy — the websocket gateway is still fully functional.
 */
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return Response.json({ ok: true, storage: "memory", ts: new Date().toISOString() });
  }
  try {
    const [{ db }, { sql }] = await Promise.all([import("@/db"), import("drizzle-orm")]);
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, storage: "postgres", ts: new Date().toISOString() });
  } catch {
    return Response.json({ ok: true, storage: "degraded", ts: new Date().toISOString() });
  }
}
