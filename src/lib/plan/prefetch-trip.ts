/**
 * 把「投机预热」接到真实排线上。
 *
 * 单独一个文件是为了让 `prefetch.ts` 保持纯逻辑（可测、无依赖），
 * 这里负责拼出与前端首屏完全一致的 TripInput —— 参数不一致的话
 * 预热出来的键对不上，等于白做。
 */
import { addDaysISO, todayISOLocal } from "../geo";
import { refinePlan, type RefineResult } from "./refine";
import { prefetchCity, singleFlight, singleFlightHas, type PrefetchResult } from "./prefetch";
import type { TripInput } from "../types";

/**
 * 与 PlannerApp 的初始 state 逐项对齐（src/components/PlannerApp.tsx）。
 * 改了那边记得改这里，否则预热命中率会悄悄掉到 0。
 */
const DEFAULTS = {
  days: 3,
  pace: "balanced",
  styles: ["citywalk", "coastal"],
  transport: "auto",
  budgetTier: "comfort",
  adults: 2,
  children: 0,
  seniors: 0,
  seed: 42,
} as const;

export function defaultTripInput(city: string, center: [number, number]): TripInput {
  return {
    city,
    center,
    days: DEFAULTS.days,
    // 首屏默认是「明天」（src/app/page.tsx），不是今天。
    // 差一天的话天气缓存键就对不上，预热等于只热了一半。
    date: addDaysISO(todayISOLocal(), 1),
    pace: DEFAULTS.pace,
    styles: [...DEFAULTS.styles],
    transport: DEFAULTS.transport,
    budgetTier: DEFAULTS.budgetTier,
    adults: DEFAULTS.adults,
    children: DEFAULTS.children,
    seniors: DEFAULTS.seniors,
    seed: DEFAULTS.seed,
  } as TripInput;
}

/**
 * 单飞（single-flight）：同一个请求只算一次。
 *
 * 没有这层的话，「预热」和「用户真的点了生成」会各算一遍——
 * 预热不但没省时间，还让服务器多干一份活。有了它，用户点下去时
 * 直接挂到已经在跑的那次计算上，等的是剩余时间而不是从头再来。
 */
/** 参与「算不算同一次」的字段。与缓存键口径一致：影响结果的都要进。 */
function planKey(input: TripInput): string {
  return JSON.stringify([
    input.city,
    input.center?.[0]?.toFixed(3),
    input.center?.[1]?.toFixed(3),
    input.days,
    input.date,
    input.pace,
    [...(input.styles ?? [])].sort(),
    input.transport,
    input.budgetTier,
    input.adults,
    input.children,
    input.seniors ?? 0,
    input.seed,
    input.farDays ?? null,
    (input.fixedPlaces ?? []).map((entry) => `${entry.place.name}@${entry.day}`).sort(),
    (input.selectedPlaces ?? []).map((place) => place.name).sort(),
    [...(input.excludeIds ?? [])].sort(),
    (input.lockedPlaces ?? []).map((entry) => `${entry.place.name}@${entry.day}`).sort(),
    input.slimDays ?? null,
    [...(input.experiences ?? [])].sort(),
    input.notes ?? null,
    input.planParams ?? null,
  ]);
}

/** 带单飞的排线入口。所有地方都该走这个，而不是直接调 refinePlan。 */
export function runPlan(input: TripInput): Promise<RefineResult> {
  // 结果由各层缓存（候选池 / 路线 / 天气 / 维基）自己留着，
  // 这里只合并「正在进行中」的重复计算。
  const key = planKey(input);
  if (process.env.MC_TIMING === "1") {
    console.error(
      `[plan] ${input.city} ${singleFlightHas(key) ? "并入正在跑的预热" : "新起一次计算"}`,
    );
  }
  return singleFlight(key, () => refinePlan(input));
}

/**
 * 后台预热一座城市。立即返回，绝不阻塞调用方。
 * 失败、超时、被丢弃都不影响任何面向用户的结果。
 */
export function prefetchTripFor(
  city: string,
  center: [number, number],
): PrefetchResult {
  return prefetchCity(city, () => runPlan(defaultTripInput(city, center)));
}


