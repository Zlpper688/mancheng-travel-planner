import type { PaceId } from "../types";

/**
 * 行程的「合理区间」集中在这里。
 *
 * 生成器（rhythm.ts / schedule.ts）和审计器（audit.ts）必须读同一份常量：
 * 否则规则调过之后，检查还按老标准跑，等于自己骗自己。
 */

/** 一天最晚几点该出门。再晚就不是「充实」，是把整个上午扔掉。 */
export const LATEST_START: Record<PaceId, number> = {
  chill: 10 * 60 + 30,
  balanced: 10 * 60,
  packed: 9 * 60 + 30,
};

/** 回酒店的最晚时间。城市行程再满，也不该跨过午夜。 */
export const HARD_CEIL_MIN = 23 * 60 + 15;

/** 一天该安排几个景点（不含吃饭）。区间是给审计用的宽容带。 */
export const SIGHT_BAND: Record<PaceId, [number, number]> = {
  chill: [2, 4],
  balanced: [3, 5],
  packed: [4, 7],
};

/** 单段路程上限。超过这个分钟数，游客会觉得自己在赶车而不是在玩。 */
export const MAX_LEG_MIN = 90;

/** 一天在路上的总时长上限。 */
export const MAX_DAY_TRAVEL_MIN = 240;

/** 同一天点位之间的最大跨越距离（km）。再大就是东西横跳。 */
export const MAX_DAY_SPAN_KM = 22;

/** 同类型点位最多连着几个。连着三个沙滩，说明选点只看打分不看差异。 */
export const MAX_SAME_CATEGORY_RUN = 2;

/** 相邻两个停留点之间允许的空档（分钟）。超过就是「这一天有个洞」。 */
export const MAX_GAP_MIN = 90;

/** 一天结束得多早算「把下午浪费了」。 */
export const EARLY_END_MIN = 17 * 60;

/** 午饭 / 晚饭应该落在的时间窗。 */
export const MEAL_WINDOW = {
  lunch: [11 * 60, 14 * 60 + 30] as [number, number],
  dinner: [17 * 60, 20 * 60 + 30] as [number, number],
};
