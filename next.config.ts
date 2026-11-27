import type { NextConfig } from "next";

/**
 * 部署相关的三条不变量（每一条都踩过）：
 *
 * 1. **data/ 必须进构建产物**。代码在运行时用 fs 读 `process.cwd()/data`，
 *    Next 的依赖追踪看不到这种读法；不加 outputFileTracingIncludes，
 *    Vercel / standalone 部署后 /api/guides 会直接 500，122 城知识库静默失效。
 * 2. **缓存目录要能在只读文件系统上退化**。见 src/lib/disk-cache.ts 的 cacheRoot()。
 * 3. **静态资源（public/）是构建时快照**，运行时往里写文件不会被服务；
 *    所以现场搜图缓存只在开发环境有意义。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 允许用独立目录做一次干净构建（NEXT_DIST_DIR=.next-build npm run build），
  // 这样验证构建时不必删掉正在用的 .next。默认仍是 .next。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // 运行时用 fs 读的 JSON 资源：让 next build 把它们带进产物。
  outputFileTracingIncludes: {
    "/api/guides/**": ["./data/guides/**/*.json"],
    "/api/guide": ["./data/guides/**/*.json", "./data/knowledge/**/*.json"],
    "/api/plan": [
      "./data/knowledge/**/*.json",
      "./data/city-centers.json",
      "./data/warm/**/*.json",
    ],
    "/api/catalog": [
      "./data/knowledge/**/*.json",
      "./data/city-centers.json",
    ],
    "/api/search": ["./data/knowledge/**/*.json"],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  async headers() {
    // 地图底图、维基图片、高德瓦片都要跨域加载，CSP 只能放开 https:；
    // 真正的价值在 nosniff / frame-ancestors / referrer，这几条不影响功能。
    const csp = [
      "default-src 'self'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' https:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "script-src 'self' 'unsafe-inline'" +
        (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
      "worker-src 'self' blob:",
      "connect-src 'self' https:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "geolocation=(self), camera=(), microphone=(), payment=()",
          },
        ],
      },
      {
        // /photos 下的文件名是内容哈希，可以放心长缓存。
        // 用单段通配（:file）而不是正则：/photos/live/xxx.jpg 天然不会被匹配，
        // 那一层是运行时现场生成、随时会被替换的图。
        source: "/photos/:file",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
