import { NextResponse } from "next/server";
import { PACES, STYLES } from "@/lib/constants";
import { critiquePlan, type CriticContext } from "@/lib/plan/critic";
import type { DayPlan, PaceId, StyleId } from "@/lib/types";

export const runtime = "nodejs";

const PACE_IDS = new Set(Object.keys(PACES));
const STYLE_IDS = new Set(STYLES.map((style) => style.id));

function readContext(raw: unknown): CriticContext {
  const data =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pace =
    typeof data.pace === "string" && PACE_IDS.has(data.pace)
      ? (data.pace as PaceId)
      : "balanced";
  const styles = Array.isArray(data.styles)
    ? Array.from(
        new Set(
          data.styles.filter(
            (style): style is StyleId =>
              typeof style === "string" && STYLE_IDS.has(style as StyleId),
          ),
        ),
      )
    : [];
  return {
    pace,
    family: data.family === true,
    styles,
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const plan =
    record.plan && typeof record.plan === "object"
      ? (record.plan as Record<string, unknown>)
      : null;
  const days = Array.isArray(plan?.days)
    ? (plan.days as DayPlan[])
    : Array.isArray(record.days)
      ? (record.days as DayPlan[])
      : null;

  if (!days || !days.length) {
    return NextResponse.json(
      { error: "请提交 plan.days 或 days 数组" },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({
      critique: critiquePlan(days, readContext(record.context)),
    });
  } catch {
    return NextResponse.json(
      { error: "行程数据不完整，无法分析" },
      { status: 400 },
    );
  }
}