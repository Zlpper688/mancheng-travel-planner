import { NextResponse } from "next/server";
import { TravelError } from "@/lib/errors";
import { runPlan } from "@/lib/plan/prefetch-trip";
import { sanitizeTripInput } from "@/lib/plan/validate";
import { checkPlanRate, clientIp } from "@/lib/rate-limit";
import type { PlanResponse } from "@/lib/types";

export const runtime = "nodejs";
// 生成-反驳-修订循环在发现明显问题时最多重排 3 轮，放宽到 180 秒。
export const maxDuration = 180;

export async function POST(request: Request): Promise<NextResponse<PlanResponse>> {
  // 一次排线会消耗 6–10 次高德搜索调用，先挡住刷接口的。
  const limit = checkPlanRate(clientIp(request));
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: "点得有点快，先缓一下。",
        hint: `约 ${limit.retryAfterSec} 秒后可以再生成；连着改偏好时可以直接改，不用反复点生成。`,
        code: "RATE_LIMITED",
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSec) },
      },
    );
  }

  try {
    const body = await request.json().catch(() => null);
    const input = sanitizeTripInput(body);
    // 生成 → 反驳 → 修订：无问题时一轮即返回，有 P0/P1 才自动重排（软参数）。
    const result = await runPlan(input);
    return NextResponse.json({
      plan: result.plan,
      refine: {
        rounds: result.rounds,
        score: result.score,
        adjustments: result.adjustments,
        issueCount: result.issues.length,
      },
    });
  } catch (error) {
    if (error instanceof TravelError) {
      return NextResponse.json(
        { error: error.message, hint: error.hint, code: error.code },
        // 高德额度用尽是「今天到此为止」，语义上是限流而不是参数错误。
        { status: error.code === "AMAP_BUDGET_EXHAUSTED" ? 429 : 400 },
      );
    }
    console.error("[plan]", error);
    return NextResponse.json(
      {
        error: "安排行程时出了点问题",
        hint: "请稍后重试；如果刚配置了高德 Key，确认它是「Web服务」类型并重启了服务。",
        code: "PLAN_FAILED",
      },
      { status: 502 },
    );
  }
}
