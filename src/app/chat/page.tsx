import type { Metadata } from "next";
import ChatApp from "@/components/chat/ChatApp";
import { addDaysISO, todayISOLocal } from "@/lib/geo";

export const metadata: Metadata = {
  title: "漫城 · 对话定制",
};

export default function ChatPage() {
  return <ChatApp initialDate={addDaysISO(todayISOLocal(), 1)} />;
}