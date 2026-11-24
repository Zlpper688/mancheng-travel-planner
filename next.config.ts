import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 允许用独立目录做一次干净构建（NEXT_DIST_DIR=.next-build npm run build），
  // 这样验证构建时不必删掉正在用的 .next。默认仍是 .next。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
