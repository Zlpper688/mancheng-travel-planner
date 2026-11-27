import { NextResponse } from "next/server";
import { todayISOLocal } from "@/lib/geo";
import { logEvent } from "@/lib/log";
import { checkRoute, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { makeDraft } from "@/lib/chat/draft";
import { askChatModel, chatModelConfig, ChatModelError, probeChatModel } from "@/lib/chat/model";
import type { ChatApiResponse, ChatDraft, ChatMessage } from "@/lib/chat/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function clip(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function coord(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(max, Math.max(min, parsed)) * 1e6) / 1e6;
}

function safeDraft(raw: unknown): ChatDraft {
  const base = makeDraft(todayISOLocal());
  if (!raw || typeof raw !== "object") return base;
  const record = raw as Record<string, unknown>;
  const city = (record.city ?? {}) as Record<string, unknown>;
  const hotel = (record.hotel ?? {}) as Record<string, unknown>;
  const confirmed = (record.confirmed ?? {}) as Record<string, unknown>;
  const bool = (key: string) => confirmed[key] === true;
  const places = Array.isArray(record.selectedPlaces) ? record.selectedPlaces : [];

  return {
    ...base,
    city: {
      name: clip(city.name, 30, base.city.name),
      lat: coord(city.lat, base.city.lat, -90, 90),
      lng: coord(city.lng, base.city.lng, -180, 180),
      address: clip(city.address, 80, base.city.address ?? ""),
    },
    hotel: {
      ...base.hotel,
      id: clip(hotel.id, 80, base.hotel.id),
      name: clip(hotel.name, 40, base.hotel.name),
      lat: coord(hotel.lat, base.hotel.lat, -90, 90),
      lng: coord(hotel.lng, base.hotel.lng, -180, 180),
      address: clip(hotel.address, 80, base.hotel.address ?? ""),
    },
    days: number(record.days, base.days, 1, 10),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(record.date ?? ""))
      ? String(record.date)
      : base.date,
    adults: number(record.adults, base.adults, 0, 9),
    children: number(record.children, base.children, 0, 9),
    seniors: number(record.seniors, base.seniors, 0, 9),
    avoidSteep: record.avoidSteep === true,
    notes: clip(record.notes, 200, ""),
    styles: Array.isArray(record.styles)
      ? (record.styles.filter((item) => typeof item === "string") as ChatDraft["styles"]).slice(0, 3)
      : base.styles,
    experiences: Array.isArray(record.experiences)
      ? (record.experiences.filter((item) => typeof item === "string") as ChatDraft["experiences"]).slice(0, 4)
      : base.experiences,
    selectedPlaces: places
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .slice(0, 12)
      .map((item) => ({
        ...base.hotel,
        id: clip(item.id, 80, "picked"),
        name: clip(item.name, 40, "自选点"),
        lat: coord(item.lat, base.hotel.lat, -90, 90),
        lng: coord(item.lng, base.hotel.lng, -180, 180),
        address: clip(item.address, 80, ""),
        category: "attraction" as const,
        source: "demo" as const,
      })),
    confirmed: {
      city: bool("city"),
      date: bool("date"),
      party: bool("party"),
      style: bool("style"),
      pace: bool("pace"),
      transport: bool("transport"),
      hotel: bool("hotel"),
    },
  };
}

function safeMessages(raw: unknown): Pick<ChatMessage, "role" | "text">[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      role: item.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: clip(item.text, 1200, ""),
    }))
    .filter((item) => item.text)
    .slice(-16);
}

export async function GET() {
  const config = chatModelConfig();
  if (!config) {
    return NextResponse.json({
      configured: false,
      model: null,
      reason: "未配置模型",
    });
  }
  const probe = await probeChatModel(config);
  return NextResponse.json({
    configured: probe.ok,
    model: config.model,
    reason: probe.reason,
  });
}

export async function POST(request: Request) {
  // 这个接口每被调用一次就是一次真实的模型计费。没有护栏时，一条链接就够把
  // 额度刷光——排在 /api/plan 之后第二个必须限流的接口。
  const limited = rateLimitResponse(checkRoute("chat", clientIp(request)));
  if (limited) return limited;

  const startedAt = Date.now();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ai: false, configured: false, reason: "请求格式不正确" } satisfies ChatApiResponse,
      { status: 400 },
    );
  }

  const config = chatModelConfig();
  const draft = safeDraft(body.draft);
  const messages = safeMessages(body.messages);
  if (!messages.length) {
    return NextResponse.json(
      { ai: false, configured: Boolean(config), reason: "没有可回复的内容" } satisfies ChatApiResponse,
      { status: 400 },
    );
  }
  if (!config) {
    return NextResponse.json(
      {
        ai: false,
        configured: false,
        reason: "未配置模型，使用向导模式",
      } satisfies ChatApiResponse,
    );
  }

  try {
    const reply = await askChatModel(config, draft, messages);
    logEvent("info", "chat", {
      ms: Date.now() - startedAt,
      model: config.model,
      turns: messages.length,
      action: reply.action,
      ok: true,
    });
    return NextResponse.json({
      ai: true,
      configured: true,
      model: config.model,
      reply,
    } satisfies ChatApiResponse);
  } catch (error) {
    logEvent("warn", "chat", {
      ms: Date.now() - startedAt,
      model: config.model,
      turns: messages.length,
      ok: false,
    });
    const raw = error instanceof ChatModelError ? error.message : `${(error as Error)?.message ?? error}`;
    const reason = /401|403|无效的令牌|unauthorized|invalid.*token/i.test(raw)
      ? "模型 Key 无效或被拒绝"
      : /429|rate limit/i.test(raw)
        ? "模型接口限流，稍后再试"
        : /timeout|超时|abort/i.test(raw)
          ? "模型响应超时"
          : raw.slice(0, 120) || "模型暂时不可用";
    console.warn("[chat] 模型调用失败：", raw.slice(0, 160));
    return NextResponse.json({
      ai: false,
      configured: true,
      reason,
    } satisfies ChatApiResponse);
  }
}