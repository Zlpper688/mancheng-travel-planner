import type { MetadataRoute } from "next";

/**
 * 只放行真正给用户看的三个页面；API 一律不进索引。
 * 站点地址取 NEXT_PUBLIC_SITE_URL——本地开发时退回 localhost 也不会写错。
 */
export default function robots(): MetadataRoute.Robots {
  const baseUrl = (
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000"
  ).replace(/\/+$/, "");
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/"],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
