import { NextResponse } from "next/server";
import { searchLocalCities } from "@/lib/city-search";
import { QUICK_CITIES } from "@/lib/constants";
import { DEMO_HOTELS } from "@/content/demo-xiamen";
import { isDemoCity } from "@/lib/demo";
import { prefetchTripFor } from "@/lib/plan/prefetch-trip";
import { getProvider } from "@/lib/providers";
import { nameSimilarity } from "@/lib/providers/normalize";
import type { Place } from "@/lib/types";

export const runtime = "nodejs";

/**
 * 用户还在挑城市的时候，后台把这座城市的行程先算出来。
 *
 * 只在「查询词与某个城市名完全一致」时触发：用户打到「南京」说明他大概率就要去南京，
 * 而打到「南」时结果里南京南昌都有，猜错就是白烧一次 20 秒的外部请求。
 *
 * 一定要 fire-and-forget：搜索接口本身必须在几十毫秒内返回，
 * 预热慢或失败都不该让用户多等一毫秒。
 */
function maybePrefetch(query: string, results: Place[]): void {
  const exact = results.find((place) => place.name === query);
  if (!exact) return;
  if (!Number.isFinite(exact.lat) || !Number.isFinite(exact.lng)) return;
  prefetchTripFor(exact.name, [exact.lng, exact.lat]);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  if (!query) return NextResponse.json({ results: [] });
  const rawKind = url.searchParams.get("kind");
  const kind = rawKind === "city" || rawKind === "hotel" ? rawKind : "any";
  const city = url.searchParams.get("city")?.trim() || undefined;
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const center: [number, number] | undefined =
    Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : undefined;

  if (kind === "city") {
    // 先查本地索引：122 个目的地，坐标都是核实过的，零延迟。
    // 原来这里直接走 Photon，实测单次 10.7s 且多个城市返回 0 条——
    // 用户打的第一个字就卡住，而坐标我们本来就有。
    const local = searchLocalCities(query, 8);
    if (local.length) {
      const localResults = local.map((option) => ({
        id: `city-${option.name}`,
        name: option.name,
        category: "other" as const,
        lat: option.lat,
        lng: option.lng,
        address: option.region ? `${option.region} · ${option.name}` : option.name,
        city: option.name,
        source: "demo" as const,
      }));
      maybePrefetch(query, localResults as Place[]);
      return NextResponse.json({ results: localResults });
    }
  }

  try {
    const provider = getProvider();
    let results = await provider.search(query, { kind, city, center });
    if (kind === "hotel" && city && isDemoCity(city)) {
      const demo = DEMO_HOTELS.filter(
        (hotel) =>
          hotel.name.includes(query) ||
          query.includes(hotel.name) ||
          nameSimilarity(query, hotel.name) > 0.4,
      );
      results = [
        ...demo,
        ...results.filter(
          (place) => !demo.some((hotel) => hotel.name === place.name),
        ),
      ];
    }
    if (kind === "city" && !results.length) {
      results = QUICK_CITIES.slice(0, 8).map(
        (option): Place => ({
          id: `city-${option.name}`,
          name: option.name,
          category: "other",
          lat: option.lat,
          lng: option.lng,
          address: option.address,
          city: option.name,
          source: "demo",
        }),
      );
    }
    if (kind === "city" && results.length) maybePrefetch(query, results);
    return NextResponse.json({ results: results.slice(0, 12) });
  } catch (error) {
    console.error("[search]", error);
    return NextResponse.json({
      results: [],
      error: "搜索服务暂时不可用",
      hint: kind === "hotel" ? "也可以打开地图点选位置" : "请稍后重试",
    });
  }
}
