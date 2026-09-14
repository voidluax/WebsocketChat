"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatError,
  type ChatMessage,
  type ConnectionStatus,
  type Member,
  wsUrl,
} from "./chat-types";

type ServerFrame =
  | { type: "welcome"; storage?: string }
  | { type: "joined"; code: string; username: string; token: string; members: Member[]; history: ChatMessage[]; room: { name: string } }
  | { type: "presence"; members: Member[]; count: number }
  | { type: "typing"; username: string; state: boolean }
  | { type: "history"; messages: ChatMessage[] }
  | { type: "error"; code: string; message: string }
  | { type: "pong" }
  | { type: "left" }
  | (ChatMessage & { type: "message" | "chat" | "system" });

const FATAL_CLOSE_CODES = new Set([4409, 4404, 4400]);

export function useChatSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const targetRef = useRef<{ code: string; username: string } | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const manualCloseRef = useRef(false);

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [typing, setTyping] = useState<string[]>([]);
  const [error, setError] = useState<ChatError | null>(null);
  const [roomName, setRoomName] = useState<string>("");

  const pushMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => {
      if (prev.some((item) => item.id === message.id)) return prev;
      const next = [...prev, message];
      next.sort((a, b) => a.id - b.id);
      return next.slice(-300);
    });
  }, []);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const open = useCallback(
    (code: string, username: string) => {
      clearTimer();
      manualCloseRef.current = false;
      targetRef.current = { code, username };
      setStatus(retryRef.current > 0 ? "reconnecting" : "connecting");

      const socket = new WebSocket(wsUrl("/ws", { room: code, username }));
      socketRef.current = socket;

      socket.onopen = () => {
        retryRef.current = 0;
      };

      socket.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(event.data as string) as ServerFrame;
        } catch {
          return;
        }

        switch (frame.type) {
          case "joined": {
            setStatus("connected");
            setError(null);
            setRoomName(frame.room?.name ?? "");
            setMembers(frame.members ?? []);
            setMessages((frame.history ?? []).slice(-300));
            break;
          }
          case "presence": {
            setMembers(frame.members ?? []);
            break;
          }
          case "typing": {
            const { username: who, state } = frame;
            setTyping((prev) => {
              if (state) return prev.includes(who) ? prev : [...prev, who];
              return prev.filter((item) => item !== who);
            });
            const timers = typingTimersRef.current;
            const existing = timers.get(who);
            if (existing) clearTimeout(existing);
            if (state) {
              timers.set(
                who,
                setTimeout(() => {
                  setTyping((prev) => prev.filter((item) => item !== who));
                  timers.delete(who);
                }, 4000),
              );
            }
            break;
          }
          case "history": {
            (frame.messages ?? []).forEach(pushMessage);
            break;
          }
          case "error": {
            setError({ code: frame.code, message: frame.message });
            if (frame.code === "USERNAME_TAKEN" || frame.code === "ROOM_NOT_FOUND") {
              manualCloseRef.current = true;
              setStatus("rejected");
            }
            break;
          }
          case "message":
          case "chat":
          case "system": {
            pushMessage(frame as ChatMessage);
            setTyping((prev) => prev.filter((item) => item !== (frame as ChatMessage).username));
            break;
          }
          default:
            break;
        }
      };

      socket.onclose = (event) => {
        socketRef.current = null;
        if (manualCloseRef.current || FATAL_CLOSE_CODES.has(event.code)) {
          if (FATAL_CLOSE_CODES.has(event.code)) setStatus("rejected");
          else setStatus("closed");
          return;
        }
        const target = targetRef.current;
        if (!target) {
          setStatus("closed");
          return;
        }
        retryRef.current = Math.min(retryRef.current + 1, 6);
        const delay = Math.min(1000 * 2 ** (retryRef.current - 1), 15_000);
        setStatus("reconnecting");
        timerRef.current = setTimeout(() => open(target.code, target.username), delay);
      };

      socket.onerror = () => {
        // close handler performs the retry
      };
    },
    [pushMessage],
  );

  const connect = useCallback(
    (code: string, username: string) => {
      retryRef.current = 0;
      setMessages([]);
      setMembers([]);
      setTyping([]);
      setError(null);
      open(code, username);
    },
    [open],
  );

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    targetRef.current = null;
    clearTimer();
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "leave" }));
    }
    socket?.close(1000, "client left");
    socketRef.current = null;
    setStatus("closed");
  }, []);

  const send = useCallback((text: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "message", text }));
    return true;
  }, []);

  const sendTyping = useCallback((state: boolean) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "typing", state }));
  }, []);

  useEffect(() => {
    const ping = setInterval(() => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 20_000);
    return () => clearInterval(ping);
  }, []);

  useEffect(() => {
    const timers = typingTimersRef.current;
    return () => {
      manualCloseRef.current = true;
      clearTimer();
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      socketRef.current?.close(1000, "unmount");
      socketRef.current = null;
    };
  }, []);

  return {
    status,
    messages,
    members,
    typing,
    error,
    roomName,
    connect,
    disconnect,
    send,
    sendTyping,
  };
}
