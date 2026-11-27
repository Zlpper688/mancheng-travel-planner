/**
 * 首屏默认参数，**只此一份**。
 *
 * 以前这份默认值在三个地方各写一遍：`PlannerApp` 的 useState 初值、
 * `prefetch-trip.ts` 的 DEFAULTS（注释里写着"改了那边记得改这里"）、
 * 以及对话页的草稿默认值。任何一处漂移，预热键就对不上——用户点了生成还是冷启动，
 * 而且不会报错，只是慢，几乎发现不了。
 *
 * 现在改默认值只改这里。`scripts/check-* ` 不锁它，靠的是引用关系本身。
 */
import type { BudgetTier, PaceId, StyleId, TransportPref } from "./types";

export interface TripDefaults {
  days: number;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  budgetTier: BudgetTier;
  adults: number;
  children: number;
  seniors: number;
  seed: number;
}

export const DEFAULT_TRIP: TripDefaults = {
  days: 3,
  pace: "balanced",
  styles: ["citywalk", "coastal"],
  transport: "auto",
  budgetTier: "comfort",
  adults: 2,
  children: 0,
  seniors: 0,
  seed: 42,
};
