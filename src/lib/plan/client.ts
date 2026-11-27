import type { PlanResponse, TripInput } from "../types";

/**
 * 排线接口的唯一调用入口。
 *
 * PlannerApp 与 ChatApp 原来各写了一份几乎一样的 fetch：
 * abort 控制器、序号防竞态、`!response.ok || !data.plan` 的判断、错误文案、
 * AbortError 的静默处理。两边改一处忘一处，就会出现「一个界面报错、另一个卡住」。
 *
 * 这里只做「请求 + 归类结果」，不碰任何 React 状态：
 *   - 调用方仍然自己持有 plan / loading / error（两边对成功的后续处理不同：
 *     一个要同步地址栏，一个要往对话里插一条消息）
 *   - 但「怎么发请求、怎么判断失败、失败说什么」只有这一份
 */
export type PlanOutcome =
  | { status: "ok"; data: PlanResponse & { plan: NonNullable<PlanResponse["plan"]> } }
  | { status: "error"; message: string; hint?: string }
  | { status: "aborted" };

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 统一的网络失败文案：不把 "Failed to fetch" 这种原文丢给用户。 */
export const NETWORK_ERROR = {
  message: "网络好像断了，没能拿到新行程。",
  hint: "确认本地服务还在运行后再试一次。",
} as const;

export async function postPlan(
  body: TripInput,
  signal: AbortSignal,
): Promise<PlanOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return isAbortError(error)
      ? { status: "aborted" }
      : { status: "error", ...NETWORK_ERROR };
  }

  let data: PlanResponse;
  try {
    data = (await response.json()) as PlanResponse;
  } catch {
    return { status: "error", ...NETWORK_ERROR };
  }

  if (!response.ok || !data.plan) {
    return {
      status: "error",
      message: data.error ?? "生成失败，请稍后再试。",
      hint: data.hint,
    };
  }
  return {
    status: "ok",
    data: data as PlanResponse & { plan: NonNullable<PlanResponse["plan"]> },
  };
}
