import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "RenderChat — free-tier WebSocket chat rooms",
  description:
    "Realtime chat rooms with a custom WebSocket server and a REST API for creating rooms. Deploys to a single Render free-tier web service.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(60rem_60rem_at_15%_-10%,rgba(56,189,248,0.16),transparent),radial-gradient(50rem_50rem_at_110%_10%,rgba(168,85,247,0.14),transparent)]" />
        <header className="sticky top-0 z-20 border-b border-white/5 bg-slate-950/70 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-sky-400 to-indigo-500 text-sm font-black text-slate-950">
                RC
              </span>
              <span>
                Render<span className="text-sky-400">Chat</span>
              </span>
            </Link>
            <nav className="flex items-center gap-1 text-sm text-slate-300">
              <Link className="rounded-md px-3 py-1.5 transition hover:bg-white/5 hover:text-white" href="/">
                Lobby
              </Link>
              <Link className="rounded-md px-3 py-1.5 transition hover:bg-white/5 hover:text-white" href="/docs">
                API docs
              </Link>
              <a
                className="rounded-md px-3 py-1.5 transition hover:bg-white/5 hover:text-white"
                href="/api/rooms"
                target="_blank"
                rel="noreferrer"
              >
                /api/rooms
              </a>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
