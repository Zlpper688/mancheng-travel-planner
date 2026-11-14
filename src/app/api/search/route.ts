import { NextResponse } from "next/server";
import { QUICK_CITIES } from "@/lib/constants";
import { DEMO_HOTELS, isDemoCity } from "@/lib/demo/xiamen";
import { getProvider } from "@/lib/providers";
import { nameSimilarity } from "@/lib/providers/normalize";
import type { Place } from "@/lib/types";

export const runtime = "nodejs";

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
    const local = QUICK_CITIES.filter(
      (option) =>
        option.name.includes(query) ||
        (option.address ?? "").includes(query) ||
        query.includes(option.name),
    );
    if (local.length) {
      return NextResponse.json({
        results: local.map((option) => ({
          id: `city-${option.name}`,
          name: option.name,
          category: "other",
          lat: option.lat,
          lng: option.lng,
          address: option.address,
          city: option.name,
          source: "demo",
        })),
      });
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
