import type { PaceId } from "../types";

/**
 * PlanParams —— 排线引擎的可调参数（LLM 唯一能改的东西）。
 *
 * 设计原则：
 * 1. 默认值 = 现有硬编码行为，不传参数时引擎输出完全不变（零回归）。
 * 2. 这是「覆盖层」，不是重写：各消费点用 resolveParams(input.params) 取值。
 * 3. 只放软参数。硬约束（日期/天数/人数/点名必去点/已订酒店/排除点）不在这里。
 *
 * 宪法依据：PRODUCT.md 第 4 节 —— LLM 通过意图编译改 PlanParams，不直接写行程。
 */
export interface PlanParams {
  /** 每日景点数区间（审计宽容带） */
  sightsPerDay: Record<PaceId, [number, number]>;
  /** 单段路程上限（分钟） */
  maxLegMin: number;
  /** 一天在路上的总时长上限（分钟） */
  maxDayTravelMin: number;
  /** 同一天点位最大跨度（km） */
  maxDaySpanKm: number;
  /** 住宿聚类半径（km）：景点聚成一片就算一个落脚点 */
  lodgingClusterKm: number;
  /** 城区半径（km）：离中心多近算「市区」 */
  cityKm: number;
  /** 景区门户最小单程（分钟）：超过才值得换宿到景区门口 */
  gatewayMinOneWayMin: number;
  /** 可选换宿最小单程（分钟） */
  optionalOneWayMin: number;
  /** 午饭 / 晚饭时间窗 */
  mealWindow: { lunch: [number, number]; dinner: [number, number] };
  /** 是否避开爬坡（影响选点，不直接改这里，由 input.avoidSteep 决定） */
  avoidSteep: boolean;
  /** 远足单程上限（分钟），按天数分档 */
  farOneWayCapByDays: { twoOrLess: number; three: number; longer: number };
  /** 远足搜索半径基准（km） */
  farLimitKm: number;
  /** 单日强制留白（宪法：不周密、玩一路） */
  restEachDay: boolean;
}

/** 默认值 = 现有全部硬编码常量，保证不传时行为不变。 */
export const DEFAULT_PARAMS: PlanParams = {
  sightsPerDay: { chill: [2, 4], balanced: [3, 5], packed: [4, 7] },
  maxLegMin: 90,
  maxDayTravelMin: 240,
  maxDaySpanKm: 22,
  lodgingClusterKm: 12,
  cityKm: 12,
  gatewayMinOneWayMin: 35,
  optionalOneWayMin: 48,
  mealWindow: {
    lunch: [11 * 60, 14 * 60 + 30],
    dinner: [17 * 60, 20 * 60 + 30],
  },
  avoidSteep: false,
  farOneWayCapByDays: { twoOrLess: 65, three: 90, longer: 110 },
  farLimitKm: 45,
  restEachDay: false,
};

const PACE_IDS: PaceId[] = ["chill", "balanced", "packed"];

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function band(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return fallback;
  const rawLo = Number(value[0]);
  const rawHi = Number(value[1]);
  // 分钟窗口（mealWindow）与「景点个数」（sightsPerDay）都走这里，
  // 但上下限不同：只要有一个不是有效数字，或 lo>hi 且无可救，就整体回退默认，
  // 不能把 [9999,-1] 裁成 [10,12] 这种「看着合法、语义全错」的值。
  const isMinuteBand = fallback[1] > 100;
  const min = isMinuteBand ? 0 : 1;
  const max = isMinuteBand ? 24 * 60 : 12;
  if (!Number.isFinite(rawLo) || !Number.isFinite(rawHi)) return fallback;
  if (rawLo > max || rawHi > max || rawLo < min || rawHi < min) return fallback;
  const lo = clamp(rawLo, min, max, fallback[0]);
  const hi = clamp(rawHi, lo, max, fallback[1]);
  return [Math.round(lo), Math.round(hi)];
}

/**
 * 把可能是 LLM 输出的松散对象解析成安全的 PlanParams。
 * LLM 只能改软参数，且每个值都在合理范围内；非法值一律退回默认。
 */
export function sanitizeParams(raw: unknown, avoidSteep?: boolean): PlanParams {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_PARAMS, avoidSteep: Boolean(avoidSteep) };
  }
  const r = raw as Record<string, unknown>;
  const sights = (r.sightsPerDay ?? {}) as Record<string, unknown>;
  const window = (r.mealWindow ?? {}) as Record<string, unknown>;
  const far = (r.farOneWayCapByDays ?? {}) as Record<string, unknown>;
  const sightsPerDay = { ...DEFAULT_PARAMS.sightsPerDay };
  for (const pace of PACE_IDS) {
    if (sights[pace] !== undefined) {
      sightsPerDay[pace] = band(sights[pace], DEFAULT_PARAMS.sightsPerDay[pace]);
    }
  }
  const DEFAULT = DEFAULT_PARAMS;
  return {
    sightsPerDay,
    maxLegMin: clamp(r.maxLegMin, 20, 240, DEFAULT.maxLegMin),
    maxDayTravelMin: clamp(r.maxDayTravelMin, 60, 600, DEFAULT.maxDayTravelMin),
    maxDaySpanKm: clamp(r.maxDaySpanKm, 3, 100, DEFAULT.maxDaySpanKm),
    lodgingClusterKm: clamp(r.lodgingClusterKm, 3, 40, DEFAULT.lodgingClusterKm),
    cityKm: clamp(r.cityKm, 3, 40, DEFAULT.cityKm),
    gatewayMinOneWayMin: clamp(r.gatewayMinOneWayMin, 10, 120, DEFAULT.gatewayMinOneWayMin),
    optionalOneWayMin: clamp(r.optionalOneWayMin, 10, 180, DEFAULT.optionalOneWayMin),
    mealWindow: {
      lunch: band(window.lunch, DEFAULT.mealWindow.lunch),
      dinner: band(window.dinner, DEFAULT.mealWindow.dinner),
    },
    avoidSteep:
      typeof r.avoidSteep === "boolean" ? r.avoidSteep : Boolean(avoidSteep),
    farOneWayCapByDays: {
      twoOrLess: clamp(far.twoOrLess, 20, 200, DEFAULT.farOneWayCapByDays.twoOrLess),
      three: clamp(far.three, 20, 240, DEFAULT.farOneWayCapByDays.three),
      longer: clamp(far.longer, 20, 300, DEFAULT.farOneWayCapByDays.longer),
    },
    farLimitKm: clamp(r.farLimitKm, 10, 200, DEFAULT.farLimitKm),
    restEachDay: r.restEachDay === true,
  };
}
