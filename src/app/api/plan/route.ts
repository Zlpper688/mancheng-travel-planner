import { NextResponse } from "next/server";
import { TravelError } from "@/lib/errors";
import { planTrip } from "@/lib/plan/engine";
import { sanitizeTripInput } from "@/lib/plan/validate";
import type { PlanResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse<PlanResponse>> {
  try {
    const body = await request.json().catch(() => null);
    const input = sanitizeTripInput(body);
    const plan = await planTrip(input);
    return NextResponse.json({ plan });
  } catch (error) {
    if (error instanceof TravelError) {
      return NextResponse.json(
        { error: error.message, hint: error.hint, code: error.code },
        { status: 400 },
      );
    }
    console.error("[plan]", error);
    return NextResponse.json(
      {
        error: "排线时出了点问题",
        hint: "请稍后重试；如果刚配置了高德 Key，确认它是「Web服务」类型并重启了服务。",
        code: "PLAN_FAILED",
      },
      { status: 502 },
    );
  }
}
