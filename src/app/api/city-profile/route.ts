import { NextResponse } from "next/server";
import { buildCityProfile, type CityProfile } from "@/lib/city-profile";
import { readLocalKnowledge } from "@/lib/providers/knowledge";

export const runtime = "nodejs";
export const maxDuration = 20;

/**
 * 城市画像：选完城市，前端调这个接口决定玩法卡片显示什么。
 * 数据来自本地知识库（离线、零成本），不会因网络抖动失败。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const city = (searchParams.get("city") ?? "").trim().slice(0, 40);
  if (!city) {
    return NextResponse.json({ error: "缺少城市名称" }, { status: 400 });
  }

  try {
    const { places } = await readLocalKnowledge(city);
    const profile: CityProfile = buildCityProfile(city, places);
    return NextResponse.json(profile, {
      headers: { "Cache-Control": "public, max-age=1800" },
    });
  } catch (error) {
    console.warn("[city-profile] 读取失败：", String(error).slice(0, 160));
    // 降级：返回空画像，前端会回退到全量玩法选项，不让用户卡住。
    return NextResponse.json({
      city,
      options: [],
      hidden: [],
      summary: "",
    } satisfies CityProfile);
  }
}
