/**
 * Single-process server for Render's free tier:
 *   • Next.js app (UI + /api/health)
 *   • REST API   -> /api/rooms...
 *   • WebSockets -> wss://<host>/  |  /ws  |  /ws/<CODE>  |  /chat
 *
 * Render only exposes ONE port per web service, so HTTP and WS share it.
 */
import { createServer } from "node:http";
import next from "next";
import { handleApi } from "./server/api.mjs";
import { Hub } from "./server/hub.mjs";
import { createStore } from "./server/store.mjs";
import { attachWebsocketServer, isWebsocketPath } from "./server/ws.mjs";

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOST ?? "0.0.0.0";

// Next.js loads .env files for its own runtime; do the same for the custom
// server so DATABASE_URL is available before the store is created.
async function loadEnvFiles() {
  try {
    const mod = await import("@next/env");
    const loadEnvConfig = mod.loadEnvConfig ?? mod.default?.loadEnvConfig;
    if (typeof loadEnvConfig === "function") {
      loadEnvConfig(process.cwd(), dev);
      return;
    }
  } catch {
    /* fall through to dotenv */
  }
  try {
    const mod = await import("dotenv");
    const dotenv = mod.default ?? mod;
    dotenv.config({ path: [".env.local", ".env"], quiet: true });
  } catch {
    /* env files are optional */
  }
}

await loadEnvFiles();

const app = next({ dev, hostname, port });

async function main() {
  const store = await createStore();
  const hub = new Hub(store);

  await app.prepare();

  // These must be created *after* prepare() resolves.
  const handleNext = app.getRequestHandler();
  const handleNextUpgrade =
    typeof app.getUpgradeHandler === "function" ? app.getUpgradeHandler() : null;

  const server = createServer((req, res) => {
    handleApi(req, res, hub)
      .then((handled) => {
        if (!handled) return handleNext(req, res);
        return undefined;
      })
      .catch((error) => {
        console.error("[http] unhandled error:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "Server error" } }));
      });
  });

  // keep free-tier proxies from cutting idle websocket connections too early
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  const ws = attachWebsocketServer(server, hub);

  // Everything that is not a chat socket (e.g. Next.js HMR in dev) goes to Next.
  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      /* ignore */
    }
    if (isWebsocketPath(pathname)) return;
    if (handleNextUpgrade) {
      void handleNextUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    console.log(`▶ chat server ready on http://${hostname}:${port}`);
    console.log(`  websocket  ws://${hostname}:${port}/ws?room=CODE&username=NAME`);
    console.log(`  rest api   POST http://${hostname}:${port}/api/rooms`);
    console.log(`  storage    ${store.kind}`);
  });

  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} received, shutting down…`);
    ws.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[server] failed to start:", error);
  process.exit(1);
});
