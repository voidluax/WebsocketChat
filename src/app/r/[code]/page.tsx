import { notFound } from "next/navigation";
import ChatRoom from "@/components/chat-room";

export const dynamic = "force-dynamic";

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(normalized)) notFound();
  return <ChatRoom code={normalized} />;
}
