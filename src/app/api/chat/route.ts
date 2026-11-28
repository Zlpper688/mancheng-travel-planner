import { NextResponse } from "next/server";
// 两边都留下：safeDraft 是我方拆出的独立守门模块（替代对方原来的本地实现），
// logEvent / rate-limit 是对方新增的护栏，二者互补，不冲突。
import { safeDraft } from "@/lib/chat/safe-draft";
import { logEvent } from "@/lib/log";
import { checkRoute, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { askChatModel, chatModelConfig, ChatModelError, probeChatModel } from "@/lib/chat/model";
import type { ChatApiResponse, ChatMessage } from "@/lib/chat/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function clip(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
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