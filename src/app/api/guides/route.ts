import { NextResponse } from "next/server";
import { matchesCity, readGuideIndex } from "@/lib/guides/store";
import type { GuideIndexItem } from "@/lib/guides/types";

export const runtime = "nodejs";

function strip(value: string): string {
  return value.toLowerCase().replace(/[\s·•\-—_]/g, "");
}

function rank(item: GuideIndexItem, city: string): number {
  const query = strip(city);
  if (!query) return 0;
  const names = [item.city, item.title, ...item.cityAliases].map(strip);
  if (names.some((name) => name === query)) return 0;
  if (names.some((name) => name.startsWith(query) || query.startsWith(name))) {
    return 1;
  }
  return 2;
}

export async function GET(request: Request) {
  try {
    const city = (new URL(request.url).searchParams.get("city") ?? "")
      .trim()
      .slice(0, 40);
    const index = await readGuideIndex();
    const guides = city
      ? index.guides
          .filter((item) => matchesCity(item, city))
          .sort(
            (a, b) =>
              rank(a, city) - rank(b, city) ||
              Number(b.status === "ok") - Number(a.status === "ok") ||
              Number(b.stops > 0) - Number(a.stops > 0) ||
              Number(a.needsReview) - Number(b.needsReview) ||
              b.routeCount - a.routeCount ||
              a.title.localeCompare(b.title, "zh-CN"),
          )
      : index.guides;

    return NextResponse.json(
      {
        version: index.version,
        total: index.count,
        count: guides.length,
        guides,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        },
      },
    );
  } catch (error) {
    console.error("[guides]", error);
    return NextResponse.json(
      { error: "攻略库暂时读不出来", code: "GUIDES_UNAVAILABLE" },
      { status: 500 },
    );
  }
}