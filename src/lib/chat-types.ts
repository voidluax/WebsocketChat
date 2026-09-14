export type ChatMessage = {
  id: number;
  room: string;
  kind: "chat" | "system";
  username: string;
  text: string;
  ts: string;
  self?: boolean;
};

export type Member = {
  username: string;
  transport: string;
  joinedAt: string;
};

export type RoomSummary = {
  code: string;
  name: string;
  isPrivate: boolean;
  createdAt: string;
  lastActiveAt: string;
  memberCount: number;
};

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "rejected"
  | "closed";

export type ChatError = {
  code: string;
  message: string;
};

export function wsUrl(path: string, params: Record<string, string>): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams(params).toString();
  return `${protocol}//${window.location.host}${path}${query ? `?${query}` : ""}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-fuchsia-500",
];

export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 997;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
