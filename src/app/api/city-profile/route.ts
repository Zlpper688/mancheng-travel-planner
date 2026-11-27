import { NextResponse } from "next/server";
import { CITY_FACTS, NEUTRAL_FACTS } from "@/content/city-facts.generated";

export const runtime = "nodejs";

/**
 * 城市画像（兼容接口）：返回这座城市能玩什么、适合怎么玩。
 *
 * 真相源：scripts/build-city-facts.mjs 离线生成的 CITY_FACTS 静态表。
 * 前端聊天卡片已直接 import 该表（同步、零延迟），本接口只留给外部/调试用。
 * 关键：查不到的城市返回 NEUTRAL_FACTS（中性玩法），绝不再返回
 *       「空画像让前端回退全量 8 项」——那正是内陆城市露出海边的老 bug。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const city = (searchParams.get("city") ?? "").trim().slice(0, 40);
  if (!city) {
    return NextResponse.json({ error: "缺少城市名称" }, { status: 400 });
  }

  const facts = CITY_FACTS[city] ?? NEUTRAL_FACTS;
  return NextResponse.json(
    {
      city,
      capabilities: facts.capabilities,
      styles: facts.styles,
      options: facts.experiences.map((option) => ({
        id: option.id,
        label: option.label,
        score: option.score,
        count: option.count,
        samples: option.samples,
        featured: option.featured,
      })),
      hidden: [],
      summary: facts.summary,
    },
    { headers: { "Cache-Control": "public, max-age=1800" } },
  );
}
