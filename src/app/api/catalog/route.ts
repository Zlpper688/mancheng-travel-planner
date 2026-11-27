import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { buildCatalog } from "@/lib/catalog";
import { TravelError } from "@/lib/errors";
import { logEvent } from "@/lib/log";
import { checkRoute, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { getProvider } from "@/lib/providers";
import { sniffCity } from "@/lib/providers/sniff";
import type { SniffStage } from "@/lib/providers/sniff/types";
import { enrichPlacesFromWikidata } from "@/lib/wikidata";

export const runtime = "nodejs";
export const maxDuration = 120;

const BASE_TTL_MS = 8 * 60 * 1000;
const DEEP_TTL_MS = 30 * 60 * 1000;

export async function GET(request: Request): Promise<NextResponse> {
  // 深挖阶段会串起 Overpass + Wikidata，单次最长 120 秒，必须限流。
  const limited = rateLimitResponse(checkRoute("catalog", clientIp(request)));
  if (limited) return limited;

  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const city = (searchParams.get("city") ?? "").trim().slice(0, 40);
    const lat = Number(searchParams.get("lat"));
    const lng = Number(searchParams.get("lng"));
    const stage: SniffStage =
      searchParams.get("stage") === "deep" ? "deep" : "base";
    if (!city) {
      return NextResponse.json(
        { error: "缺少城市名称" },
        { status: 400 },
      );
    }
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return NextResponse.json(
        { error: "城市坐标不正确" },
        { status: 400 },
      );
    }

    const provider = getProvider();
    const center: [number, number] = [lng, lat];
    const key = [
      "catalog",
      "sniff",
      "v9",
      provider.source,
      stage,
      city,
    ].join(":");

    const catalog = await cached(
      key,
      stage === "deep" ? DEEP_TTL_MS : BASE_TTL_MS,
      async () => {
        const sniffed = await sniffCity({ city, center, stage });
        // 维基数据的名字批查又快又稳：深挖多补一些，浅扫只补前排。
        const enriched = await enrichPlacesFromWikidata(sniffed.sights, {
          maxNames: stage === "deep" ? 160 : 40,
          city,
          budgetMs: stage === "deep" ? 20_000 : 10_000,
        });
        const notes = [...sniffed.notes];
        if (enriched) {
          notes.push(`其中 ${enriched} 个点从维基数据补全了简介或实景图。`);
        }
        const result = buildCatalog(
          sniffed.sights,
          city,
          sniffed.source,
          sniffed.sourceNote,
          notes,
        );
        result.sniff = sniffed.stats;
        result.sniff.kept = result.total;
        return result;
      },
      {
        // 深挖失败时只留下精选结果，不要把“空扫描”缓存半小时。
        cacheIf: (value) =>
          value.total > 0 &&
          (stage === "base" ||
            Boolean(value.sniff?.bySource.amap || value.sniff?.bySource.osm)),
      },
    );

    logEvent("info", "catalog", {
      ms: Date.now() - startedAt,
      city,
      stage,
      total: catalog.total,
    });
    return NextResponse.json(catalog);
  } catch (error) {
    if (error instanceof TravelError) {
      return NextResponse.json(
        { error: error.message, hint: error.hint, code: error.code },
        { status: 400 },
      );
    }
    console.error("[catalog]", error);
    return NextResponse.json(
      {
        error: "景点图鉴暂时没有加载出来",
        hint: "全城扫描需要访问开放地图；稍后重试，或配置高德 Key 作为主数据源。",
        code: "CATALOG_FAILED",
      },
      { status: 502 },
    );
  }
}