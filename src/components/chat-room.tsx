"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { avatarColor, formatTime, initials } from "@/lib/chat-types";
import { useChatSocket } from "@/lib/use-chat-socket";

const STATUS_STYLES: Record<string, string> = {
  idle: "bg-slate-500/20 text-slate-300",
  connecting: "bg-amber-500/20 text-amber-200",
  reconnecting: "bg-amber-500/20 text-amber-200",
  connected: "bg-emerald-500/20 text-emerald-200",
  rejected: "bg-rose-500/20 text-rose-200",
  closed: "bg-slate-500/20 text-slate-300",
};

export default function ChatRoom({ code }: { code: string }) {
  const router = useRouter();
  const chat = useChatSocket();
  const [username, setUsername] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const typingSentAt = useRef(0);
  const bootstrapped = useRef(false);

  const { connect, disconnect, send, sendTyping, status, error } = chat;

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("u") ?? params.get("username");
    const saved = window.localStorage.getItem("renderchat:username") ?? "";
    const initial = fromQuery ?? saved;
    if (initial) setUsername(initial);
    if (fromQuery && fromQuery.trim().length >= 2) {
      setAttempted(true);
      connect(code, fromQuery.trim());
    }
  }, [code, connect]);

  useEffect(() => {
    if (status === "rejected") setAttempted(false);
  }, [status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.messages.length, chat.typing.length]);

  const handleJoin = useCallback(() => {
    const name = username.trim();
    if (name.length < 2) return;
    window.localStorage.setItem("renderchat:username", name);
    const url = new URL(window.location.href);
    url.searchParams.set("u", name);
    window.history.replaceState(null, "", url.toString());
    setAttempted(true);
    connect(code, name);
  }, [code, connect, username]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    if (send(text)) {
      setDraft("");
      sendTyping(false);
    }
  };

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  const inviteLink = useMemo(
    () => (typeof window === "undefined" ? "" : `${window.location.origin}/r/${code}`),
    [code],
  );
  const socketUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws?room=${code}&username=YOUR_NAME`;
  }, [code]);

  if (!attempted) {
    return (
      <main className="mx-auto flex max-w-md flex-col justify-center px-4 py-16">
        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-6 shadow-2xl">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Joining room</p>
          <h1 className="mt-1 font-mono text-3xl font-bold tracking-[0.25em] text-sky-300">{code}</h1>
          <p className="mt-3 text-sm text-slate-400">
            Pick a username. It must be unique inside this room — the server rejects duplicates.
          </p>
          <input
            autoFocus
            value={username}
            maxLength={24}
            onChange={(event) => setUsername(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && handleJoin()}
            placeholder="username"
            className="mt-4 w-full rounded-xl border border-white/10 bg-slate-950/70 px-4 py-3 outline-none transition placeholder:text-slate-600 focus:border-sky-400/60 focus:ring-2 focus:ring-sky-500/20"
          />
          {error ? (
            <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              <span className="font-mono text-xs">{error.code}</span> — {error.message}
            </p>
          ) : null}
          <button
            onClick={handleJoin}
            className="mt-4 w-full rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-3 font-semibold text-slate-950 transition hover:opacity-90"
          >
            Join chat
          </button>
          <button
            onClick={() => router.push("/")}
            className="mt-2 w-full rounded-xl px-4 py-2 text-sm text-slate-400 transition hover:text-white"
          >
            Back to lobby
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto grid max-w-6xl gap-4 px-4 py-6 lg:grid-cols-[1fr_260px]">
      <section className="flex h-[calc(100vh-8.5rem)] min-h-[520px] flex-col rounded-2xl border border-white/10 bg-slate-900/60">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
          <div>
            <h1 className="text-lg font-semibold">{chat.roomName || "Chat room"}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <button
                onClick={() => void copy("code", code)}
                className="rounded-md bg-white/5 px-2 py-1 font-mono tracking-[0.2em] text-sky-300 transition hover:bg-white/10"
                title="Copy room code"
              >
                {code}
              </button>
              <button
                onClick={() => void copy("link", inviteLink)}
                className="rounded-md bg-white/5 px-2 py-1 transition hover:bg-white/10"
              >
                {copied === "link" ? "link copied ✓" : "copy invite link"}
              </button>
              <button
                onClick={() => void copy("ws", socketUrl)}
                className="rounded-md bg-white/5 px-2 py-1 transition hover:bg-white/10"
              >
                {copied === "ws" ? "ws url copied ✓" : "copy wss url"}
              </button>
              {copied === "code" ? <span className="text-emerald-300">code copied ✓</span> : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[status] ?? ""}`}>
              {status}
            </span>
            <button
              onClick={() => {
                disconnect();
                router.push("/");
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-rose-400/40 hover:text-rose-200"
            >
              Leave
            </button>
          </div>
        </header>

        <div className="chat-scroll flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {chat.messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">
              No messages yet — say hello 👋
            </p>
          ) : null}
          {chat.messages.map((message) =>
            message.kind === "system" ? (
              <p key={message.id} className="animate-pop-in text-center text-xs text-slate-500">
                {message.text} · {formatTime(message.ts)}
              </p>
            ) : (
              <div
                key={message.id}
                className={`animate-pop-in flex gap-3 ${message.self ? "flex-row-reverse" : ""}`}
              >
                <div
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold text-slate-950 ${avatarColor(
                    message.username,
                  )}`}
                >
                  {initials(message.username)}
                </div>
                <div className={`max-w-[75%] ${message.self ? "text-right" : ""}`}>
                  <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                    <span className="font-medium text-slate-300">{message.username}</span>
                    <span>{formatTime(message.ts)}</span>
                  </div>
                  <div
                    className={`inline-block whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-sm ${
                      message.self
                        ? "bg-gradient-to-br from-sky-500 to-indigo-500 text-slate-950"
                        : "border border-white/5 bg-slate-950/60 text-slate-100"
                    }`}
                  >
                    {message.text}
                  </div>
                </div>
              </div>
            ),
          )}
          <div ref={bottomRef} />
        </div>

        {chat.typing.length > 0 ? (
          <p className="px-5 pb-1 text-xs text-slate-500">
            {chat.typing.join(", ")} {chat.typing.length === 1 ? "is" : "are"} typing…
          </p>
        ) : null}

        {error && status !== "rejected" ? (
          <p className="mx-5 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <span className="font-mono">{error.code}</span> — {error.message}
          </p>
        ) : null}

        <div className="border-t border-white/10 p-3">
          <div className="flex items-end gap-2">
            <textarea
              rows={1}
              value={draft}
              maxLength={2000}
              onChange={(event) => {
                setDraft(event.target.value);
                const now = Date.now();
                if (now - typingSentAt.current > 1500) {
                  typingSentAt.current = now;
                  sendTyping(true);
                }
              }}
              onBlur={() => sendTyping(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder={status === "connected" ? "Message the room…" : "Connecting…"}
              disabled={status !== "connected"}
              className="chat-scroll max-h-32 min-h-[46px] flex-1 resize-y rounded-xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm outline-none transition placeholder:text-slate-600 focus:border-sky-400/60 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={status !== "connected" || draft.trim().length === 0}
              className="rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:opacity-90 disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </section>

      <aside className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          In this room · {chat.members.length}
        </h2>
        <ul className="mt-3 space-y-1.5">
          {chat.members.map((member) => (
            <li key={member.username} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
              <span
                className={`grid h-7 w-7 place-items-center rounded-full text-[10px] font-bold text-slate-950 ${avatarColor(
                  member.username,
                )}`}
              >
                {initials(member.username)}
              </span>
              <span className="truncate text-sm text-slate-200">{member.username}</span>
              <span className="ml-auto text-[10px] uppercase text-slate-500">{member.transport}</span>
            </li>
          ))}
        </ul>
        <div className="mt-5 rounded-xl border border-white/5 bg-slate-950/50 p-3 text-[11px] leading-relaxed text-slate-500">
          <p className="font-semibold text-slate-400">Connect from code</p>
          <code className="mt-1 block break-all text-sky-300">{socketUrl}</code>
        </div>
      </aside>
    </main>
  );
}
