import { NextResponse } from "next/server";
import { TravelError } from "@/lib/errors";
import { todayISOLocal } from "@/lib/geo";
import { parseGuide } from "@/lib/guide";
import { pickRoute, readGuide, routeToText } from "@/lib/guides/store";
import { DEMO_HOTELS } from "@/content/demo-xiamen";
import { discoverForTrip } from "@/lib/plan/engine";
import { sanitizeTripInput } from "@/lib/plan/validate";
import { getProvider } from "@/lib/providers";
import type { Place } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

// 同名地物常散落在周边城市（如「环岛路」），优先保留目的地城市内的结果；
// 若一个都没有（远足线路），则保留全部，避免误删跨城景点。
function preferCity(places: Place[], city: string): Place[] {
  const short = city.replace(/市$/, "").trim();
  if (short.length < 2) return places;
  const local = places.filter(
    (place) =>
      place.city?.includes(short) || place.address?.includes(short),
  );
  return local.length ? local : places;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new TravelError("请求格式不正确", "INVALID_INPUT");
    }
    const record = body as Record<string, unknown>;
    const guideId =
      typeof record.guideId === "string" ? record.guideId.trim() : "";
    const routeId =
      typeof record.routeId === "string" ? record.routeId.trim() : "";

    let text = "";
    const trip = sanitizeTripInput({
      city: record.city,
      center: record.center,
      hotel: record.hotel,
      days: record.days,
      styles: record.styles,
      pace: "balanced",
      transport: "auto",
      budgetTier: "comfort",
      adults: 1,
      children: 0,
      date: todayISOLocal(),
      seed: 7,
    });

    // 打开攻略库时预热点位发现，把首次复刻约 3 秒的联网耗时藏到浏览列表期间。
    if (record.prewarm === true) {
      const warmed = await discoverForTrip(trip);
      return NextResponse.json({
        warmed: true,
        source: warmed.source,
        sourceNote: warmed.sourceNote,
      });
    }

    let guideMeta: {
      id: string;
      title: string;
      city: string;
      routeId: string;
      routeTitle: string | null;
      days: number;
      stops: number;
    } | null = null;

    if (guideId) {
      const guide = await readGuide(guideId);
      if (!guide) {
        throw new TravelError(
          "没有找到这份攻略",
          "GUIDE_NOT_FOUND",
          "攻略库可能更新了，请重新选择一份",
        );
      }
      const route = pickRoute(guide, routeId);
      if (!route) {
        throw new TravelError(
          "这份攻略里还没有可用的路线",
          "GUIDE_EMPTY",
          "换一份攻略，或直接粘贴游记文字",
        );
      }
      text = routeToText(route);
      guideMeta = {
        id: guide.id,
        title: guide.title,
        city: guide.city,
        routeId: route.id,
        routeTitle: route.title,
        days: route.days.length,
        stops: route.stopCount,
      };
    } else {
      text = typeof record.text === "string" ? record.text.trim() : "";
      if (text.length < 10) {
        throw new TravelError(
          "攻略内容太短",
          "INVALID_INPUT",
          "至少粘贴一段包含地点或日程的攻略文字",
        );
      }
      if (text.length > 8000) {
        throw new TravelError(
          "攻略内容过长",
          "INVALID_INPUT",
          "请截取最核心的几天内容，控制在 8000 字以内",
        );
      }
    }

    const discovered = await discoverForTrip(trip);
    const provider = getProvider();
    const pool = [
      ...discovered.sights,
      ...discovered.meals,
      ...(discovered.isDemo ? DEMO_HOTELS : []),
    ];
    const result = await parseGuide(text, pool, {
      search: (query) =>
        provider
          .search(query, {
            city: trip.city,
            center: trip.center ??
              (trip.hotel ? [trip.hotel.lng, trip.hotel.lat] : undefined),
            kind: "any",
          })
          .then((places) => preferCity(places, trip.city)),
      maxSearches: 6,
    });

    return NextResponse.json({
      result,
      source: discovered.source,
      sourceNote: discovered.sourceNote,
      guide: guideMeta,
    });
  } catch (error) {
    if (error instanceof TravelError) {
      return NextResponse.json(
        { error: error.message, hint: error.hint, code: error.code },
        { status: 400 },
      );
    }
    console.error("[guide]", error);
    return NextResponse.json(
      {
        error: "解析攻略时出了点问题",
        hint: "请稍后重试，或缩短攻略文字再试一次。",
        code: "GUIDE_FAILED",
      },
      { status: 502 },
    );
  }
}
