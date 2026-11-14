import { NextResponse } from "next/server";
import { getProvider } from "@/lib/providers";
import type { Place } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return NextResponse.json(
      { place: null, error: "坐标不正确" },
      { status: 400 },
    );
  }

  try {
    const provider = getProvider();
    const resolved = await provider.reverse(lat, lng);
    const place: Place = resolved
      ? {
          ...resolved,
          category: "hotel",
          name: /酒店|宾馆|民宿|旅馆|客栈/.test(resolved.name)
            ? resolved.name
            : `${resolved.name.slice(0, 24)}附近`,
          lat,
          lng,
        }
      : {
          id: `picked-${lat.toFixed(5)}-${lng.toFixed(5)}`,
          name: "地图选点",
          category: "hotel",
          lat,
          lng,
          address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          source: "demo",
        };
    return NextResponse.json({ place });
  } catch (error) {
    console.error("[reverse]", error);
    return NextResponse.json({
      place: {
        id: `picked-${lat.toFixed(5)}-${lng.toFixed(5)}`,
        name: "地图选点",
        category: "hotel",
        lat,
        lng,
        address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        source: "demo",
      } satisfies Place,
    });
  }
}
