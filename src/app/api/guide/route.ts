import { NextResponse } from "next/server";
import { TravelError } from "@/lib/errors";
import { todayISOLocal } from "@/lib/geo";
import { parseGuide } from "@/lib/guide";
import { DEMO_HOTELS } from "@/lib/demo/xiamen";
import { discoverForTrip } from "@/lib/plan/engine";
import { sanitizeTripInput } from "@/lib/plan/validate";
import { getProvider } from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new TravelError("请求格式不正确", "INVALID_INPUT");
    }
    const record = body as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
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

    const discovered = await discoverForTrip(trip);
    const provider = getProvider();
    const pool = [
      ...discovered.sights,
      ...discovered.meals,
      ...(discovered.isDemo ? DEMO_HOTELS : []),
    ];
    const result = await parseGuide(text, pool, {
      search: (query) =>
        provider.search(query, {
          city: trip.city,
          center: [trip.hotel.lng, trip.hotel.lat],
          kind: "any",
        }),
      maxSearches: 6,
    });

    return NextResponse.json({
      result,
      source: discovered.source,
      sourceNote: discovered.sourceNote,
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
