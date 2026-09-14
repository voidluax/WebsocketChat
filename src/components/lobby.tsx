"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { RoomSummary } from "@/lib/chat-types";

type ApiError = { error?: { code: string; message: string } };

export default function Lobby() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [roomName, setRoomName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);

  useEffect(() => {
    const saved = window.localStorage.getItem("renderchat:username");
    if (saved) setUsername(saved);
  }, []);

  const loadRooms = useCallback(async () => {
    try {
      const response = await fetch("/api/rooms?limit=8", { cache: "no-store" });
      const data = (await response.json()) as { rooms?: RoomSummary[] };
      setRooms(data.rooms ?? []);
    } catch {
      /* offline – ignore */
    }
  }, []);

  useEffect(() => {
    void loadRooms();
    const timer = setInterval(() => void loadRooms(), 8000);
    return () => clearInterval(timer);
  }, [loadRooms]);

  const rememberUser = (value: string) => {
    window.localStorage.setItem("renderchat:username", value);
  };

  const enter = (code: string, name: string) => {
    rememberUser(name);
    router.push(`/r/${code}?u=${encodeURIComponent(name)}`);
  };

  const handleCreate = async () => {
    if (username.trim().length < 2) {
      setError("Pick a username with at least 2 characters.");
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: roomName || `${username.trim()}'s room` }),
      });
      const data = (await response.json()) as ApiError & { code?: string };
      if (!response.ok || !data.code) {
        setError(data.error?.message ?? "Could not create the room.");
        return;
      }
      enter(data.code, username.trim());
    } catch {
      setError("Network error while creating the room.");
    } finally {
      setBusy(null);
    }
  };

  const handleJoin = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) {
      setError("Room codes look like ABC123.");
      return;
    }
    if (username.trim().length < 2) {
      setError("Pick a username with at least 2 characters.");
      return;
    }
    setBusy("join");
    setError(null);
    try {
      const response = await fetch(
        `/api/rooms/${code}/available?username=${encodeURIComponent(username.trim())}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as ApiError & { available?: boolean };
      if (response.status === 404) {
        setError(`Room ${code} does not exist.`);
        return;
      }
      if (!response.ok) {
        setError(data.error?.message ?? "Could not join that room.");
        return;
      }
      if (data.available === false) {
        setError(`"${username.trim()}" is already taken in room ${code}. Choose another username.`);
        return;
      }
      enter(code, username.trim());
    } catch {
      setError("Network error while joining the room.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-4 pb-20 pt-10">
      <section className="mb-10 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          single Render web service · one port · HTTP + WSS
        </span>
        <h1 className="mt-5 text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          Realtime chat rooms over your own <span className="text-sky-400">WebSocket server</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-pretty text-slate-400">
          Create a room, get a short code, share it. Usernames are unique per room — the server rejects a
          duplicate join with <code className="rounded bg-white/10 px-1 py-0.5 text-sky-300">USERNAME_TAKEN</code>{" "}
          (HTTP 409 / websocket close 4409).
        </p>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 shadow-2xl shadow-sky-500/5">
          <label className="block text-sm font-medium text-slate-300" htmlFor="username">
            Your username
          </label>
          <input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="e.g. ada"
            maxLength={24}
            className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/70 px-4 py-3 text-base outline-none transition placeholder:text-slate-600 focus:border-sky-400/60 focus:ring-2 focus:ring-sky-500/20"
          />

          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div className="rounded-xl border border-white/5 bg-slate-950/40 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-sky-300">Create a room</h2>
              <input
                value={roomName}
                onChange={(event) => setRoomName(event.target.value)}
                placeholder="Room name (optional)"
                maxLength={60}
                className="mt-3 w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-sky-400/60"
              />
              <button
                onClick={() => void handleCreate()}
                disabled={busy !== null}
                className="mt-3 w-full rounded-lg bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:opacity-90 disabled:opacity-50"
              >
                {busy === "create" ? "Creating…" : "Create room & get code"}
              </button>
              <p className="mt-2 text-xs text-slate-500">
                Calls <code className="text-slate-400">POST /api/rooms</code>
              </p>
            </div>

            <div className="rounded-xl border border-white/5 bg-slate-950/40 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-300">Join with a code</h2>
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={12}
                className="mt-3 w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 font-mono text-sm uppercase tracking-[0.3em] outline-none placeholder:tracking-normal placeholder:text-slate-600 focus:border-emerald-400/60"
              />
              <button
                onClick={() => void handleJoin()}
                disabled={busy !== null}
                className="mt-3 w-full rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2.5 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-400/20 disabled:opacity-50"
              >
                {busy === "join" ? "Checking…" : "Join room"}
              </button>
              <p className="mt-2 text-xs text-slate-500">
                Checks <code className="text-slate-400">/available</code> before connecting
              </p>
            </div>
          </div>

          {error ? (
            <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </p>
          ) : null}
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Live rooms</h2>
            <span className="text-xs text-slate-500">auto-refresh 8s</span>
          </div>
          <ul className="mt-4 space-y-2">
            {rooms.length === 0 ? (
              <li className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
                No rooms yet. Create the first one.
              </li>
            ) : null}
            {rooms.map((room) => (
              <li key={room.code}>
                <button
                  onClick={() => setJoinCode(room.code)}
                  className="flex w-full items-center justify-between rounded-xl border border-white/5 bg-slate-950/50 px-4 py-3 text-left transition hover:border-sky-400/40 hover:bg-slate-900"
                >
                  <span>
                    <span className="block text-sm font-medium text-slate-100">{room.name}</span>
                    <span className="font-mono text-xs tracking-[0.2em] text-sky-300">{room.code}</span>
                  </span>
                  <span className="rounded-full bg-white/5 px-2 py-1 text-xs text-slate-300">
                    {room.memberCount} online
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <Link
            href="/docs"
            className="mt-5 block rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3 text-center text-sm text-slate-300 transition hover:border-sky-400/40 hover:text-white"
          >
            Read the WebSocket &amp; REST docs →
          </Link>
        </div>
      </div>

      <section className="mt-10 grid gap-4 md:grid-cols-3">
        {[
          {
            title: "1 · Create",
            body: "POST /api/rooms returns { code, websocketUrl }. You can also create a room straight from a websocket frame.",
          },
          {
            title: "2 · Connect",
            body: "wss://<app>.onrender.com/ws?room=CODE&username=NAME — or send a {\"type\":\"join\"} frame after connecting.",
          },
          {
            title: "3 · Chat",
            body: "Send {\"type\":\"message\",\"text\":\"hi\"}. Duplicate usernames in a room are refused before any message is delivered.",
          },
        ].map((card) => (
          <div key={card.title} className="rounded-2xl border border-white/10 bg-slate-900/40 p-5">
            <h3 className="text-sm font-semibold text-sky-300">{card.title}</h3>
            <p className="mt-2 text-sm text-slate-400">{card.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
