import type { ReactNode } from "react";

export const dynamic = "force-static";

function Code({ children }: { children: ReactNode }) {
  return (
    <pre className="chat-scroll mt-3 overflow-x-auto rounded-xl border border-white/10 bg-slate-950/80 p-4 text-[13px] leading-relaxed text-slate-200">
      <code>{children}</code>
    </pre>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-white/5 pt-8">
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      <div className="mt-3 space-y-3 text-sm text-slate-400">{children}</div>
    </section>
  );
}

const REST_ROWS: Array<[string, string, string]> = [
  ["POST", "/api/rooms", "Create a room → returns { code, websocketUrl, joinUrl }"],
  ["GET", "/api/rooms/new?name=Demo", "Browser-friendly room creation (same payload)"],
  ["GET", "/api/rooms?limit=25", "List public rooms + member counts"],
  ["GET", "/api/rooms/:code", "Room details, members and connection URLs"],
  ["GET", "/api/rooms/:code/available?username=ada", "Is this username free in the room?"],
  ["POST", "/api/rooms/:code/join", "Claim a username → { token }. 409 if taken"],
  ["POST", "/api/rooms/:code/messages", "Send a message over plain HTTP (needs username + token)"],
  ["GET", "/api/rooms/:code/messages?after=0&limit=50", "Message history"],
  ["GET", "/api/rooms/:code/members", "Who is currently in the room"],
  ["POST", "/api/rooms/:code/heartbeat", "Keep an HTTP membership alive (<90s)"],
  ["POST", "/api/rooms/:code/leave", "Release the username"],
  ["GET", "/api/stats", "Room/member/message counters + storage backend"],
  ["GET", "/api/health", "Health check used by Render"],
];

const WS_CLIENT_FRAMES: Array<[string, string]> = [
  ["create_room", `{"type":"create_room","name":"Standup","username":"ada"}`],
  ["join", `{"type":"join","room":"ABC123","username":"ada"}`],
  ["message", `{"type":"message","text":"hello world"}`],
  ["typing", `{"type":"typing","state":true}`],
  ["members", `{"type":"members"}`],
  ["history", `{"type":"history","after":0,"limit":50}`],
  ["leave", `{"type":"leave"}`],
  ["ping", `{"type":"ping"}`],
];

const WS_SERVER_FRAMES: Array<[string, string]> = [
  ["welcome", "Sent immediately after the socket opens"],
  ["room_created", "{ code, room } after a create_room frame"],
  ["joined", "{ room, username, token, members, history }"],
  ["message", "{ id, room, username, text, ts, kind:'chat' }"],
  ["system", "join/leave notices (kind:'system')"],
  ["presence", "{ members: [...], count }"],
  ["typing", "{ username, state }"],
  ["error", "{ code, message } – see error codes below"],
  ["pong", "reply to ping"],
];

const ERRORS: Array<[string, string, string]> = [
  ["USERNAME_TAKEN", "409", "4409 — username already in the room"],
  ["ROOM_NOT_FOUND", "404", "4404 — unknown room code"],
  ["INVALID_USERNAME", "400", "4400 — 2–24 chars, [A-Za-z0-9 ._-]"],
  ["INVALID_CODE", "400", "4400 — code must be 4–12 alphanumerics"],
  ["NOT_IN_ROOM", "403", "— join before sending"],
  ["RATE_LIMITED", "429", "4429 — 20 msgs / 10s per user"],
];

export default function DocsPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-8 px-4 pb-24 pt-10">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">API &amp; WebSocket documentation</h1>
        <p className="mt-2 text-sm text-slate-400">
          Everything below is also in <code className="rounded bg-white/10 px-1 text-sky-300">README.md</code> at the
          repository root. Replace <code className="rounded bg-white/10 px-1">name.onrender.com</code> with your own
          Render service host.
        </p>
      </header>

      <Section id="rest" title="REST endpoints">
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-xs">
            <thead className="bg-white/5 text-slate-300">
              <tr>
                <th className="px-3 py-2">Method</th>
                <th className="px-3 py-2">Path</th>
                <th className="px-3 py-2">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {REST_ROWS.map(([method, path, purpose]) => (
                <tr key={`${method}-${path}`} className="border-t border-white/5">
                  <td className="px-3 py-2 font-mono text-sky-300">{method}</td>
                  <td className="px-3 py-2 font-mono text-slate-200">{path}</td>
                  <td className="px-3 py-2 text-slate-400">{purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Code>{`curl -X POST https://name.onrender.com/api/rooms \\
  -H "content-type: application/json" \\
  -d '{"name":"Design sync"}'

{
  "ok": true,
  "code": "K7QF2M",
  "room": { "code": "K7QF2M", "name": "Design sync", "memberCount": 0 },
  "websocketUrl": "wss://name.onrender.com/ws?room=K7QF2M",
  "joinUrl": "https://name.onrender.com/r/K7QF2M"
}`}</Code>
      </Section>

      <Section id="ws" title="WebSocket">
        <p>
          Connect to <code className="text-sky-300">wss://name.onrender.com</code> (root),{" "}
          <code className="text-sky-300">/ws</code>, <code className="text-sky-300">/chat</code> or{" "}
          <code className="text-sky-300">/ws/&lt;CODE&gt;</code>. Add{" "}
          <code className="text-sky-300">?room=CODE&amp;username=NAME</code> to join instantly, or send a join frame.
        </p>
        <Code>{`const ws = new WebSocket("wss://name.onrender.com/ws?room=K7QF2M&username=ada");

ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({ type: "message", text: "hi" }));

// create a room over the socket instead of REST
ws.send(JSON.stringify({ type: "create_room", name: "Standup", username: "ada" }));`}</Code>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-200">Client → server</h3>
            <ul className="mt-2 space-y-1 text-xs">
              {WS_CLIENT_FRAMES.map(([name, sample]) => (
                <li key={name} className="rounded-lg border border-white/5 bg-slate-950/50 px-3 py-2">
                  <span className="font-mono text-sky-300">{name}</span>
                  <code className="mt-1 block break-all text-slate-400">{sample}</code>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-200">Server → client</h3>
            <ul className="mt-2 space-y-1 text-xs">
              {WS_SERVER_FRAMES.map(([name, description]) => (
                <li key={name} className="rounded-lg border border-white/5 bg-slate-950/50 px-3 py-2">
                  <span className="font-mono text-emerald-300">{name}</span>
                  <span className="mt-1 block text-slate-400">{description}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section id="usernames" title="Unique usernames per room">
        <p>
          A username is claimed by a unique index on <code>(room_id, lower(username))</code>. A second client that
          tries the same name in the same room gets an <code className="text-rose-300">USERNAME_TAKEN</code> error and
          the socket is closed with code <code className="text-rose-300">4409</code> — it never joins and never
          receives room traffic. Names are released on disconnect (or after 90s without a heartbeat).
        </p>
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-xs">
            <thead className="bg-white/5 text-slate-300">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">HTTP</th>
                <th className="px-3 py-2">WebSocket / notes</th>
              </tr>
            </thead>
            <tbody>
              {ERRORS.map(([code, http, note]) => (
                <tr key={code} className="border-t border-white/5">
                  <td className="px-3 py-2 font-mono text-rose-300">{code}</td>
                  <td className="px-3 py-2 font-mono text-slate-200">{http}</td>
                  <td className="px-3 py-2 text-slate-400">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="render" title="Deploy on Render (free tier)">
        <p>Create a Web Service → Runtime: Node → then use:</p>
        <Code>{`Build Command:  npm install && npm run build
Start Command:  npm run start`}</Code>
        <p>
          <code className="text-sky-300">npm run start</code> runs{" "}
          <code className="text-sky-300">NODE_ENV=production node server.mjs</code>, which serves Next.js, the REST API
          and the WebSocket gateway on the single port Render provides via <code>$PORT</code>.
        </p>
        <p>
          Optional: set <code className="text-sky-300">DATABASE_URL</code> to a Render PostgreSQL instance for
          persistent history. Without it the server automatically uses an in-memory store.
        </p>
      </Section>
    </main>
  );
}
