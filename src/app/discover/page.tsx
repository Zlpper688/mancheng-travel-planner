import type { Metadata } from "next";
import DiscoverApp from "@/components/DiscoverApp";

export const metadata: Metadata = {
  title: "漫城 · 发现景点",
  description: "像刷短视频一样发现目的地，收藏喜欢的景点灵感。",
};

export default function DiscoverPage() {
  return <DiscoverApp />;
}
