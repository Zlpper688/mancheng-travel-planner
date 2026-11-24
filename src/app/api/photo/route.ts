import { NextResponse } from "next/server";
import { resolvePlacePhoto } from "@/lib/photos";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const name = (params.get("name") ?? "").trim().slice(0, 80);
  const city = (params.get("city") ?? "").trim().slice(0, 30);
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const qidRaw = (params.get("qid") ?? "").trim();
  const qid = /^Q\d{1,10}$/.test(qidRaw) ? qidRaw : undefined;
  const image = (params.get("image") ?? "").trim().slice(0, 320);
  const commons = (params.get("commons") ?? "").trim().slice(0, 320);

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