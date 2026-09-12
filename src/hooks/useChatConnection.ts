"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ChatMessage = {
  id: number;
  room: string;
  username: string;
  body: string;
  kind: string;
  createdAt: string;
  pending?: boolean;
};

export type ChatMember = {
  username: string;
  transport: string;
  joinedAt: string;
  lastSeenAt: string;
};

export type RoomInfo = {
  code: string;
  name: string;
  topic: string | null;
  maxMembers?: number;
};

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "closed";

export type Transport = "websocket" | "http" | null;

type ConnectArgs = { room: string; username: string; roomInfo?: RoomInfo | null };

const POLL_MS = 1500;
const HEARTBEAT_MS = 12_000;
const MAX_WS_ATTEMPTS = 3;

function sortMessages(list: ChatMessage[]): ChatMessage[] {
  return [...list].sort((a, b) => a.id - b.id);
}

export function useChatConnection() {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [transport, setTransport] = useState<Transport>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [username, setUsername] = useState<string>("");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [typing, setTyping] = useState<string[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<string>("");
  const cursorRef = useRef<number>(0);
  const targetRef = useRef<ConnectArgs | null>(null);
  const attemptsRef = useRef<number>(0);
  const fatalRef = useRef<boolean>(false);
  const activeRef = useRef<boolean>(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const pushMessages = useCallback((incoming: ChatMessage[]) => {
    if (!incoming.length) return;
    setMessages((prev) => {
      const byId = new Map<number, ChatMessage>();
      for (const item of prev) if (!item.pending) byId.set(item.id, item);
      for (const item of incoming) byId.set(item.id, item);
      const pending = prev.filter(
        (item) => item.pending && !incoming.some((m) => m.body === item.body && m.username === item.username),
      );
      const next = sortMessages([...byId.values()]);
      for (const item of incoming) cursorRef.current = Math.max(cursorRef.current, item.id);
      return [...next, ...pending];
    });
  }, []);

  const clearTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (beatRef.current) clearInterval(beatRef.current);
    if (retryRef.current) clearTimeout(retryRef.current);
    pollRef.current = null;
    beatRef.current = null;
    retryRef.current = null;
  }, []);

  const markTyping = useCallback((who: string, isTyping: boolean) => {
    setTyping((prev) => {
      const set = new Set(prev);
      if (isTyping) set.add(who);
      else set.delete(who);
      return [...set];
    });
    const timers = typingTimers.current;
    const existing = timers.get(who);
    if (existing) clearTimeout(existing);
    if (isTyping) {
      timers.set(
        who,
        setTimeout(() => {
          timers.delete(who);
          setTyping((prev) => prev.filter((name) => name !== who));
        }, 4000),
      );
    }
  }, []);

  /* ---------------------------------------------------------------- HTTP */

  const startHttpFallback = useCallback(async () => {
    const target = targetRef.current;
    if (!target || !activeRef.current) return;
    setTransport("http");
    setStatus("connecting");

    try {
      const response = await fetch(`/api/rooms/${target.room}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: target.username,
          sessionId: sessionRef.current || undefined,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        fatalRef.current = data?.error?.code === "USERNAME_TAKEN";
        setError(
          data?.error ?? { code: "JOIN_FAILED", message: "could not join the room" },
        );
        setStatus("error");
        activeRef.current = false;
        return;
      }

      sessionRef.current = data.sessionId;
      setRoom(data.room);
      setUsername(data.username);
      setMembers(data.members ?? []);
      cursorRef.current = 0;
      setMessages([]);
      pushMessages(data.history ?? []);
      setStatus("connected");
      setError(null);

      clearTimers();
      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const res = await fetch(
              `/api/rooms/${target.room}/messages?after=${cursorRef.current}&limit=100`,
              { cache: "no-store" },
            );
            if (!res.ok) return;
            const payload = await res.json();
            pushMessages(payload.messages ?? []);
          } catch {
            /* transient */
          }
        })();
      }, POLL_MS);

      beatRef.current = setInterval(() => {
        void (async () => {
          try {
            const res = await fetch(`/api/rooms/${target.room}/presence`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                username: target.username,
                sessionId: sessionRef.current,
              }),
            });
            const payload = await res.json();
            if (payload?.members) setMembers(payload.members);
          } catch {
            /* transient */
          }
        })();
      }, HEARTBEAT_MS);
    } catch (err) {
      setError({ code: "NETWORK", message: (err as Error).message });
      setStatus("error");
    }
  }, [clearTimers, pushMessages]);

  /* ----------------------------------------------------------- WebSocket */

  const openSocket = useCallback(() => {
    const target = targetRef.current;
    if (!target || !activeRef.current || typeof window === "undefined") return;

    attemptsRef.current += 1;
    setStatus(attemptsRef.current === 1 ? "connecting" : "reconnecting");

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ room: target.room, username: target.username });
    if (sessionRef.current) params.set("sessionId", sessionRef.current);
    const url = `${proto}//${window.location.host}/ws?${params.toString()}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      void startHttpFallback();
      return;
    }
    socketRef.current = socket;
    setTransport("websocket");

    socket.onopen = () => {
      attemptsRef.current = 1;
    };

    socket.onmessage = (event) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const type = frame.type as string;

      if (type === "joined") {
        sessionRef.current = String(frame.sessionId ?? "");
        setRoom(frame.room as RoomInfo);
        setUsername(String(frame.username ?? target.username));
        setMembers((frame.members as ChatMember[]) ?? []);
        cursorRef.current = 0;
        setMessages([]);
        pushMessages((frame.history as ChatMessage[]) ?? []);
        setStatus("connected");
        setError(null);
        return;
      }
      if (type === "message") {
        pushMessages([frame as unknown as ChatMessage]);
        return;
      }
      if (type === "history") {
        pushMessages((frame.messages as ChatMessage[]) ?? []);
        return;
      }
      if (type === "presence" || type === "members") {
        if (frame.members) setMembers(frame.members as ChatMember[]);
        return;
      }
      if (type === "typing") {
        markTyping(String(frame.username), frame.isTyping !== false);
        return;
      }
      if (type === "error") {
        const code = String(frame.code ?? "ERROR");
        if (code === "USERNAME_TAKEN" || code === "ROOM_NOT_FOUND" || code === "ROOM_FULL") {
          fatalRef.current = true;
          activeRef.current = false;
          setError({ code, message: String(frame.message ?? code) });
          setStatus("error");
        } else {
          setError({ code, message: String(frame.message ?? code) });
        }
      }
    };

    socket.onerror = () => {
      /* handled in onclose */
    };

    socket.onclose = (event) => {
      socketRef.current = null;
      if (!activeRef.current || fatalRef.current) {
        if (!fatalRef.current) setStatus("closed");
        return;
      }
      if (event.code === 4409) {
        fatalRef.current = true;
        activeRef.current = false;
        setStatus("error");
        return;
      }
      if (attemptsRef.current >= MAX_WS_ATTEMPTS) {
        void startHttpFallback();
        return;
      }
      setStatus("reconnecting");
      const delay = Math.min(1000 * attemptsRef.current, 5000);
      retryRef.current = setTimeout(() => openSocket(), delay);
    };
  }, [markTyping, pushMessages, startHttpFallback]);

  /* -------------------------------------------------------------- public */

  const connect = useCallback(
    (args: ConnectArgs) => {
      clearTimers();
      socketRef.current?.close(1000, "switching rooms");
      socketRef.current = null;
      sessionRef.current = "";
      cursorRef.current = 0;
      attemptsRef.current = 0;
      fatalRef.current = false;
      activeRef.current = true;
      targetRef.current = args;
      setMessages([]);
      setMembers([]);
      setTyping([]);
      setError(null);
      setRoom(args.roomInfo ?? { code: args.room, name: args.room, topic: null });
      setUsername(args.username);
      openSocket();
    },
    [clearTimers, openSocket],
  );

  const disconnect = useCallback(() => {
    const target = targetRef.current;
    activeRef.current = false;
    clearTimers();
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "leave" }));
      } catch {
        /* ignore */
      }
    }
    socket?.close(1000, "left");
    socketRef.current = null;
    if (target && sessionRef.current) {
      void fetch(`/api/rooms/${target.room}/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({ username: target.username, sessionId: sessionRef.current }),
      }).catch(() => {});
    }
    targetRef.current = null;
    sessionRef.current = "";
    setStatus("idle");
    setTransport(null);
    setMessages([]);
    setMembers([]);
    setRoom(null);
    setError(null);
  }, [clearTimers]);

  const sendMessage = useCallback(
    (text: string) => {
      const target = targetRef.current;
      const body = text.trim();
      if (!target || !body) return;

      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "message", text: body }));
        return;
      }

      const optimistic: ChatMessage = {
        id: Date.now(),
        room: target.room,
        username: target.username,
        body,
        kind: "chat",
        createdAt: new Date().toISOString(),
        pending: true,
      };
      setMessages((prev) => [...prev, optimistic]);

      void fetch(`/api/rooms/${target.room}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: target.username,
          sessionId: sessionRef.current,
          text: body,
        }),
      })
        .then((res) => res.json())
        .then((payload) => {
          if (payload?.message) {
            setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
            pushMessages([payload.message]);
          }
        })
        .catch(() => {});
    },
    [pushMessages],
  );

  const sendTyping = useCallback((isTyping: boolean) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "typing", isTyping }));
    }
  }, []);

  useEffect(() => {
    const handleUnload = () => {
      const target = targetRef.current;
      if (!target || !sessionRef.current) return;
      const payload = JSON.stringify({
        username: target.username,
        sessionId: sessionRef.current,
      });
      navigator.sendBeacon?.(
        `/api/rooms/${target.room}/leave`,
        new Blob([payload], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      clearTimers();
      socketRef.current?.close();
    };
  }, [clearTimers]);

  return {
    status,
    transport,
    messages,
    members,
    room,
    username,
    error,
    typing,
    connect,
    disconnect,
    sendMessage,
    sendTyping,
  };
}
