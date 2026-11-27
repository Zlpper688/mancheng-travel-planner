import { NextResponse } from "next/server";
import { resolvePlacePhoto } from "@/lib/photos";
import { checkRoute, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import type { Category } from "@/lib/types";

export const runtime = "nodejs";

const CATEGORIES = new Set<Category>([
  "attraction", "museum", "park", "viewpoint", "beach", "street",
  "temple", "market", "nature", "food", "cafe", "hotel", "other",
]);

export async function GET(request: Request) {
  // 一次解析可能依次打高德 / 维基 / 搜狗，共享资源那边还有串行 600ms 排队，
  // 阈值放得比正文接口宽，但必须存在——否则一个列表页就能把上游打满。
  const limited = rateLimitResponse(checkRoute("photo", clientIp(request)));
  if (limited) return limited;

  const params = new URL(request.url).searchParams;
  const name = (params.get("name") ?? "").trim().slice(0, 80);
  const city = (params.get("city") ?? "").trim().slice(0, 30);
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const qidRaw = (params.get("qid") ?? "").trim();
  const qid = /^Q\d{1,10}$/.test(qidRaw) ? qidRaw : undefined;
  const image = (params.get("image") ?? "").trim().slice(0, 320);
  const commons = (params.get("commons") ?? "").trim().slice(0, 320);
  const categoryRaw = (params.get("category") ?? "").trim();
  const category = CATEGORIES.has(categoryRaw as Category)
    ? (categoryRaw as Category)
    : undefined;

  if (!name) {
    return NextResponse.json({ photo: null, error: "缺少地点名称" }, { status: 400 });
  }

  const photo = await resolvePlacePhoto({
    name,
    city,
    lat: Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : undefined,
    lng: Number.isFinite(lng) && lng >= -180 && lng <= 180 ? lng : undefined,
    qid,
    image: image || undefined,
    commons: commons || undefined,
    category,
  });

  return NextResponse.json(
    { photo },
    {
      headers: {
        "Cache-Control": "public, max-age=600, s-maxage=86400",
      },
    },
  );
}