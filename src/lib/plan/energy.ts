/**
 * 旅行者能量模型 —— 把「早上有劲、下午发蔫」变成排线能算的约束。
 *
 * 现在节奏只有 chill / balanced / packed 三档，全天用同一个 dwellScale：
 * 上午爬完山，下午还按同一套时长继续塞大景区，排出来「能走完」，
 * 但人走不下来。真人的体力是一条单调下降的曲线，不是三档档位。
 *
 * 模型：
 *   每天维护一个 E ∈ [0, 100]；
 *   初始值由出发时刻（首日晚到 = 已消耗）、行程第几天（累计疲劳）、
 *   同行人（老人/小孩）决定；
 *   每个点位按类型扣或加，餐饮与茶歇是恢复点。
 *
 * 用途有两处，都是软约束：
 *   1. 排序代价（order-dp）：重体力点位排在 E 高的时段，轻点位留给 E 低时；
 *   2. 停留时长（schedule）：E 低时把重体力点位的停留收 15%，并给一句人话解释。
 *
 * 没有真值可标定，所以这里只做「方向正确」：
 * 系数是保守的，宁可少扣一点也不要把一条正常行程判成「体力不支」。
 */
import type { Category, PaceId, Place } from "../types";
import { steepnessOf } from "./strenuous";

export type Effort = "hard" | "medium" | "light" | "restore";

export type MealSlot = "lunch" | "dinner" | "cafe";

/**
 * 单次访问的能量变化（正 = 恢复），逐项对应定下来的那张表：
 *   爬山 -18 / 大景区 -10 / 博物馆 -6 / 步行街 -4 / 咖啡 +8 / 午休 +12
 *
 * 表里没列的类别按最接近的一档靠：寺庙、海滩、观景台与博物馆同级，
 * 公园介于景区与步行街之间。全部偏保守——宁可少扣一点，
 * 也不要把一条正常行程判成「走不动」。
 */
const BASE: Partial<Record<Category, number>> = {
  attraction: -10,
  museum: -6,
  temple: -6,
  beach: -6,
  viewpoint: -6,
  street: -4,
  market: -4,
  park: -8,
  nature: -12,
  food: 8,
  cafe: 8,
  other: -4,
};

/** 爬山单独一档：这是唯一会把人真正耗空的动作。 */
const HIKE_COST = -18;

/** 午休（坐下吃一顿正餐、顺带歇脚）的恢复量。 */
export const LUNCH_RESTORE = 12;

/**
 * 每在外面待一小时的「基础消耗」：通勤、排队、站着看地图、晒太阳。
 *
 * 不加这一条会出现一个很假的结果：一天 8 个点位、13 个小时，午饭 +12、
 * 咖啡 +8、晚饭 +8 把景区消耗全抵平了，回酒店还剩 90 分。
 * 真实的疲惫大部分来自「一直在动」，而不是「进了几个馆」。
 */
const DRAIN_PER_HOUR = 1.5;

/** 从 fromMin 到 toMin 这段时间的基础体力消耗（非负）。 */
export function timeDrain(fromMin: number, toMin: number): number {
  return Math.max(0, ((toMin - fromMin) / 60) * DRAIN_PER_HOUR);
}

export interface EnergyStart {
  /** 当天第一个点位的出发时刻（分钟）。晚出发说明体力已经被路上消耗过。 */
  startMin: number;
  /** 第几天（1 起）。 */
  dayIndex: number;
  pace: PaceId;
  seniors?: number;
  children?: number;
}

/**
 * 每天开始时的能量。
 *
 * 100 不是「无限体力」，只是这条曲线上的满格刻度：
 * 正常 8:30 出门、第二天、两个人，大概从 94 开始，走到晚上 20 点剩 35 左右。
 */
export function initialEnergy(input: EnergyStart): number {
  let energy = 100;
  // 晚出发不是「休息得更好」，是「已经在路上了」——但这条只对**首日**成立。
  // 只有第一天，出门晚才意味着刚从机场/高铁下来；后面几天出门晚是排线自己
  // 安排的（把日落那一整天的上午空出来），那是「还没开始累」，不是「已经累过一轮」。
  //
  // 这条踩过坑：不加 dayIndex 判断时，厦门真实排线第 2 天 14:30 出发，
  // 起点被压到 70，紧接着触发「体力已经下去一截」的解释和停留折扣——
  // 一天的第一个点位就被告知走不动了，而旅行者其实刚出门。
  //
  // 首日 14:00 到达 ≈ 55 分：这是「上午在路上」的真实手感，也是这套曲线的锚点。
  if (input.dayIndex <= 1) {
    const lateMin = Math.max(0, input.startMin - 10 * 60);
    energy -= Math.min(45, (lateMin / 60) * 11.25);
  }
  // 累计疲劳：第 2 天 -6，第 3 天 -12，封顶 -24。
  energy -= Math.min(24, Math.max(0, input.dayIndex - 1) * 6);
  // 老人与小孩都要额外留余量，但别把「带一个孩子」直接判成走不动。
  energy -= Math.min(18, (input.seniors ?? 0) * 7 + (input.children ?? 0) * 4);
  // 松弛节奏本来就走得少，起点给一点回补。
  if (input.pace === "chill") energy += 6;
  if (input.pace === "packed") energy -= 4;
  return Math.max(35, Math.min(100, Math.round(energy)));
}

export function effortOf(
  place: Place,
  city: string,
  steep: "core" | "soft" | null = null,
): Effort {
  if (place.category === "food" || place.category === "cafe") return "restore";
  const slope = steep ?? steepnessOf(city, place);
  if (slope === "core") return "hard";
  if (place.category === "nature") return "medium";
  if (place.category === "attraction") {
    // 半天型大景区（植物园、野生动物园）按重体力算，逛两小时的展馆不算。
    return "medium";
  }
  if (slope === "soft") return "medium";
  if (place.category === "museum") return "light";
  if (place.category === "park") return "medium";
  return "light";
}

/** 这一类点位的基础能量收支（不含停留时长缩放）。 */
export function baseCostOf(
  place: Place,
  city: string,
  steep: "core" | "soft" | null = null,
): number {
  const slope = steep ?? steepnessOf(city, place);
  if (slope === "core") return HIKE_COST;
  const base = BASE[place.category];
  if (base !== undefined) return base;
  return slope === "soft" ? -8 : -4;
}

/** 一次访问对能量的影响：耗电按停留时长缩放（最多 1.4 倍），恢复按 0.5–1.2 倍。 */
export function energyDelta(
  place: Place,
  city: string,
  dwellMin: number,
  steep?: "core" | "soft" | null,
  slot?: MealSlot,
): number {
  // 午饭是「坐下来歇」，恢复量固定为 +12，不按分钟折算：
  // 吃四十分钟和吃一小时，对身体的意义是一样的。
  if (slot === "lunch") return LUNCH_RESTORE;
  const base = baseCostOf(place, city, steep);
  if (base < 0) {
    // 40 分钟以内按 0.7 算，两小时按 1.15，四小时封顶 1.4。
    const scale = Math.min(1.4, Math.max(0.7, 0.7 + (dwellMin / 120) * 0.45));
    return Math.round(base * scale);
  }
  // 咖啡 20 分钟和坐一小时，恢复量不一样。
  const scale = Math.min(1.2, Math.max(0.5, dwellMin / 45));
  return Math.round(base * scale);
}

export function applyEnergy(
  energy: number,
  place: Place,
  city: string,
  dwellMin: number,
  steep?: "core" | "soft" | null,
  slot?: MealSlot,
): number {
  return Math.max(
    0,
    Math.min(100, energy + energyDelta(place, city, dwellMin, steep, slot)),
  );
}

/**
 * 排序代价：体力不够还排重体力点位，就加罚。
 *
 * 单位与「分钟」对齐（1 分 ≈ 1 单位代价），这样它和路程、等待能放在同一个
 * 目标函数里比较：为了把爬山放到上午，多坐 10 分钟车是值得的。
 */
export function energyPenalty(
  energy: number,
  place: Place,
  city: string,
  steep?: "core" | "soft" | null,
): number {
  const effort = effortOf(place, city, steep);
  if (effort === "hard") return Math.max(0, 62 - energy) * 0.16;
  if (effort === "medium") return Math.max(0, 48 - energy) * 0.1;
  if (effort === "restore") return energy < 40 ? 0 : 0.4;
  return 0;
}

/**
 * 体力低时重体力点位的停留折扣。
 * 只收 15%：不是为了「优化指标」，是承认走不动了还得留出上厕所、找座的时间。
 */
export function energyDwellScale(
  energy: number,
  place: Place,
  city: string,
  steep?: "core" | "soft" | null,
): number {
  if (energy >= 45) return 1;
  const effort = effortOf(place, city, steep);
  return effort === "hard" ? 0.85 : effort === "medium" ? 0.93 : 1;
}

/** 给点位写一句解释；没有可说的就不写，别为了「有 AI 感」硬凑。 */
export function energyNote(
  energy: number,
  place: Place,
  city: string,
  steep?: "core" | "soft" | null,
): string | null {
  if (energy >= 45) return null;
  const effort = effortOf(place, city, steep);
  if (effort !== "hard" && effort !== "medium") return null;
  return effort === "hard"
    ? "排到这时体力已经下去一截，这一站放慢走，能坐就坐一会儿"
    : "走到这会儿有点乏，这一站别贪多，看完主景就撤";
}

export interface DayEnergy {
  /** 出门时的能量 */
  start: number;
  /** 回到住处时的能量 */
  end: number;
  /** 全天最低点 */
  low: number;
  /** 最低点出现在哪个点位（用于解释文案） */
  lowPlaceId?: string;
  /** 是否触发了「体力见底」的提示 */
  strained: boolean;
}

/**
 * 全天能量曲线。入参是已经排好序的停靠点，所以它只做「记账」，
 * 不反向影响顺序——顺序由 order-dp 负责，两边共用同一套 delta。
 */
export function summarizeEnergy(
  stops: Array<{
    place: Place;
    dwellMin: number;
    slot?: MealSlot;
    startMin?: number;
    endMin?: number;
  }>,
  start: number,
  city: string,
  dayStartMin?: number,
): DayEnergy {
  let energy = start;
  let low = start;
  let lowPlaceId: string | undefined;
  // 有停靠时刻时就把「待在外面」的耗时消耗算进去：从上一站结束到这一站结束，
  // 覆盖路程与停留两部分。口径与 schedule 的循环一致（都不含站后缓冲）。
  let clock = dayStartMin ?? stops[0]?.startMin ?? 0;
  for (const stop of stops) {
    if (stop.endMin !== undefined && dayStartMin !== undefined) {
      energy = Math.max(0, energy - timeDrain(clock, stop.endMin));
    }
    energy = applyEnergy(
      energy,
      stop.place,
      city,
      stop.dwellMin,
      null,
      stop.slot,
    );
    if (stop.endMin !== undefined) clock = stop.endMin;
    else clock += stop.dwellMin;
    if (energy < low) {
      low = energy;
      lowPlaceId = stop.place.id;
    }
  }
  return {
    start: Math.round(start),
    end: Math.round(energy),
    low: Math.round(low),
    lowPlaceId,
    strained: low < 25,
  };
}
