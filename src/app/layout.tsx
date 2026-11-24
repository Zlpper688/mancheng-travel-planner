import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "漫城 · 从酒店出发的城市漫游计划",
  description:
    "选一座城、定一间酒店，漫城会把景点、吃喝和休息排成每天的先后顺序：早上从酒店出发，一路顺着走，晚上回到酒店，并附上真实交通时间与预算。",
  applicationName: "漫城",
  authors: [{ name: "漫城" }],
  keywords: ["旅行规划", "Citywalk", "行程规划", "厦门", "旅游预算"],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f0e4",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="app-canvas min-h-screen text-ink">{children}</body>
    </html>
  );
}
