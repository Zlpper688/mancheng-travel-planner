import { NextResponse } from "next/server";
import { TravelError } from "./errors";

/**
 * 进程内的两道护栏。都用 globalThis 存，dev 热重载不会清零。
 *
 * 1) IP 限速：挡住脚本刷接口。一次排线要打 6–10 次高德搜索，
 *    没有限速时任何一个拿到链接的人都能反复点生成，把配额耗光。
 * 2) 高德每日额度：按「真实出网请求」计数。个人认证的「基础搜索」
 *    是 5000 次/月，摊到每天约 167 次，超过就是第二天全线报 10003。
 *    到点直接拒绝，并告诉用户什么时候恢复。
 *
 * 注意：IP 取自 x-forwarded-for / x-real-ip。如果将来挂在自己不控制的
 * 代理后面，这两个头可以被客户端伪造成任意值，届时需要改成从可信层取。
 */

type Window = {
  used: number;
  resetAt: number;
};

const globalForLimit = globalThis as typeof globalThis & {
  __manchengLimits?: Map<string, Window>;
  __manchengAmapBudget?: Map<string, Window>;
};

const limitStore =
  globalForLimit.__manchengLimits ??
  (globalForLimit.__manchengLimits = new Map<string, Window>());
const budgetStore =
  globalForLimit.__manchengAmapBudget ??
  (globalForLimit.__manchengAmapBudget = new Map<string, Window>());

/** 防止被大量随机 IP / 随机 key 撑爆内存。 */
const MAX_LIMIT_KEYS = 4096;

export type LimitDecision =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSec: number; remaining: 0 };

function sweep(now: number): void {
  for (const [key, window] of limitStore) {
    if (window.resetAt <= now) limitStore.delete(key);
  }
}

export function consume(
  key: string,
  limit: number,
  windowMs: number,
): LimitDecision {
  const now = Date.now();
  const hit = limitStore.get(key);
  if (!hit || hit.resetAt <= now) {
    if (limitStore.size >= MAX_LIMIT_KEYS) sweep(now);
    limitStore.set(key, { used: 1, resetAt: now + windowMs });
    return { ok: true, remaining: Math.max(0, limit - 1) };
  }
  if (hit.used >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((hit.resetAt - now) / 1000)),
    };
  }
  hit.used += 1;
  return { ok: true, remaining: Math.max(0, limit - hit.used) };
}

/** 两个窗口都过才算过：短窗口挡突发，长窗口挡慢速刷。 */
function consumeBoth(
  key: string,
  burst: { limit: number; windowMs: number },
  sustained: { limit: number; windowMs: number },
): LimitDecision {
  const burstResult = consume(`${key}:b`, burst.limit, burst.windowMs);
  if (!burstResult.ok) return burstResult;
  const sustainedResult = consume(`${key}:s`, sustained.limit, sustained.windowMs);
  if (!sustainedResult.ok) return sustainedResult;
  return { ok: true, remaining: Math.min(burstResult.remaining, sustainedResult.remaining) };
}

/**
 * 排线是最贵的一个接口。20 次/分足够一个正常用户连点，
 * 但脚本一秒钟就能撞上；120 次/小时防的是「慢速刷」。
 */
export function checkPlanRate(ip: string): LimitDecision {
  return consumeBoth(
    `plan:${ip}`,
    { limit: 20, windowMs: 60_000 },
    { limit: 120, windowMs: 3_600_000 },
  );
}

/**
 * 除 /api/plan 之外的接口，按「上游成本」分档限流。
 *
 * 之前只有排线接口有护栏，其余五个接口是敞开的：一个拿到链接的人用二十行脚本
 * 就能把模型额度刷光、把高德日配额打穿、把进程拖满。这里按每档的真实成本定阈值：
 *   chat    一次请求 = 一次 LLM 调用，最贵，压到最低
 *   catalog 一次可能跑满 120 秒（Overpass + Wikidata 深挖）
 *   guide   最多 6 次上游搜索
 *   photo   多级回退 + 共享资源串行，但单次便宜、页面会并发发起
 *   search  随输入触发，阈值放宽，真正的大头由 prefetch 开关和每日额度兜
 */
export type LimitedRoute = "chat" | "catalog" | "guide" | "photo" | "search";

const ROUTE_BUDGET: Record<
  LimitedRoute,
  [burst: { limit: number; windowMs: number }, sustained: { limit: number; windowMs: number }]
> = {
  chat: [
    { limit: 12, windowMs: 60_000 },
    { limit: 60, windowMs: 3_600_000 },
  ],
  catalog: [
    { limit: 6, windowMs: 60_000 },
    { limit: 40, windowMs: 3_600_000 },
  ],
  guide: [
    { limit: 10, windowMs: 60_000 },
    { limit: 80, windowMs: 3_600_000 },
  ],
  photo: [
    { limit: 90, windowMs: 60_000 },
    { limit: 900, windowMs: 3_600_000 },
  ],
  search: [
    { limit: 60, windowMs: 60_000 },
    { limit: 600, windowMs: 3_600_000 },
  ],
};

export function checkRoute(route: LimitedRoute, ip: string): LimitDecision {
  const [burst, sustained] = ROUTE_BUDGET[route];
  return consumeBoth(`${route}:${ip}`, burst, sustained);
}

/** 搜索是随输入触发的，网格放宽一些，配额靠下面的每日额度兜。 */
export function checkSearchRate(ip: string): LimitDecision {
  return checkRoute("search", ip);
}

/**
 * 路由守卫的统一出口：限流没过时返回 429 + Retry-After。
 * 返回 null 表示放行，调用方继续走自己的逻辑。
 */
export function rateLimitResponse(decision: LimitDecision): NextResponse | null {
  if (decision.ok) return null;
  return NextResponse.json(
    {
      error: "点得有点快，先缓一下。",
      hint: `约 ${decision.retryAfterSec} 秒后可以再试。`,
      code: "RATE_LIMITED",
    },
    {
      status: 429,
      headers: { "Retry-After": String(decision.retryAfterSec) },
    },
  );
}

export function clientIp(request: Request): string {
  const headers = request.headers;
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  const ip =
    first ||
    headers.get("x-real-ip")?.trim() ||
    headers.get("cf-connecting-ip")?.trim() ||
    "";
  if (!ip || ip.length > 64) return "unknown";
  return ip;
}

export type AmapMeter = "search" | "lbs";

/**
 * 高德的服务组划分：place/* 属于「基础搜索」（5000 次/月，个人认证），
 * geocode / direction / weather 属于「基础 LBS」（15 万次/月），
 * 两组额度差 30 倍，必须分开计。
 */
export function meterOfPath(path: string): AmapMeter {
  return path.startsWith("/place/") ? "search" : "lbs";
}

function capOf(meter: AmapMeter): number {
  const raw =
    meter === "search"
      ? process.env.AMAP_DAILY_SEARCH_BUDGET
      : process.env.AMAP_DAILY_LBS_BUDGET;
  // 搜索 200 次/天 ≈ 20 次完整排线，是个人认证额度下能长期撑住的上限
  // （5000/月 ÷ 30 ≈ 167）。LBS 额度宽得多，给 4000。
  const fallback = meter === "search" ? 200 : 4000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function endOfLocalDay(): number {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  ).getTime();
}

/**
 * 每次真正出网请求前调用。到顶就抛，让上层给出「今天额度用完了」而不是
 * 让高德返回一堆 10003 令用户以为是 Key 坏了。
 */
export function meterAmap(meter: AmapMeter): void {
  const cap = capOf(meter);
  const now = Date.now();
  let window = budgetStore.get(meter);
  if (!window || window.resetAt <= now) {
    window = { used: 0, resetAt: endOfLocalDay() };
    budgetStore.set(meter, window);
  }
  if (window.used >= cap) {
    throw new TravelError(
      meter === "search"
        ? "今天的实时搜索额度已经用完了。"
        : "今天的路线计算额度已经用完了。",
      "AMAP_BUDGET_EXHAUSTED",
      "额度在每天 0 点重置。这是本地保护上限，可在 .env.local 里用 AMAP_DAILY_SEARCH_BUDGET / AMAP_DAILY_LBS_BUDGET 调整。",
    );
  }
  window.used += 1;
}

export function budgetStatus(): {
  search: { used: number; cap: number };
  lbs: { used: number; cap: number };
} {
  const now = Date.now();
  const read = (meter: AmapMeter) => {
    const window = budgetStore.get(meter);
    const used = window && window.resetAt > now ? window.used : 0;
    return { used, cap: capOf(meter) };
  };
  return { search: read("search"), lbs: read("lbs") };
}
