export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { ...init, headers });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ ok: false, error: { code, message }, ...extra }, { status });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Best-effort public origin detection so we can hand back a usable wss:// URL. */
export function publicUrls(request: Request): { http: string; ws: string } {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(host);
  // Anything that is not localhost is served over TLS in practice (Render,
  // and every other managed host, terminates TLS at the edge), so advertise
  // https/wss unless the proxy explicitly says otherwise for a local host.
  const localProto = forwardedProto ?? url.protocol.replace(":", "");
  const secure = isLocal ? localProto === "https" : true;
  return {
    http: `${secure ? "https" : "http"}://${host}`,
    ws: `${secure ? "wss" : "ws"}://${host}`,
  };
}
