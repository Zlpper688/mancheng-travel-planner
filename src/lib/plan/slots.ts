import {
  SLOT_PERIOD_LABELS,
  SLOT_PERIODS,
  type DayPlan,
  type DaySlot,
  type SlotPeriod,
  type StopPlan,
} from "../types";

/**
 * 把一天的 stops 投影成 6 个语义时段（宪法 Step 2）。
 *
 * 设计要点：
 * 1. stops 仍是排线真源，这里只做视图投影——零回归，不动排线算法。
 * 2. 空时段要明确给话术，不静默留白（宪法三：留白是节奏，但不能让用户以为漏了）。
 * 3. 每段自带起止分钟与上一段路程，局部替换时有明确边界。
 * 4. 餐点按 startMin 归段；午饭落在 noon，晚饭落在 evening。
 */
const BOUNDS: { period: SlotPeriod; from: number; to: number }[] = [
  { period: "early", from: 0, to: 9 * 60 },
  { period: "morning", from: 9 * 60, to: 12 * 60 },
  { period: "noon", from: 12 * 60, to: 14 * 60 },
  { period: "afternoon", from: 14 * 60, to: 18 * 60 },
  { period: "evening", from: 18 * 60, to: 21 * 60 },
  { period: "night", from: 21 * 60, to: 24 * 60 },
];

function periodOf(stop: StopPlan): SlotPeriod {
  // 餐点自带语义标记（午饭/晚饭/咖啡）：优先按语义归段，再看时间。
  // 否则「晚饭 · 春熙路一带」这种 17:30 开吃的弹性餐点会被塞进 afternoon，
  // 前端展示时和真正的晚间散步割裂。
  if (stop.slot === "dinner") return "evening";
  if (stop.slot === "lunch") return "noon";
  if (stop.slot === "cafe") return "afternoon";
  const minute = stop.startMin;
  for (const b of BOUNDS) {
    if (minute >= b.from && minute < b.to) return b.period;
  }
  return minute >= 21 * 60 ? "night" : "early";
}

const EMPTY_HINTS: Record<SlotPeriod, string> = {
  early: "起早才能赶上的日出或清晨街巷；不想早起就跳过。",
  morning: "上午还空着，可以加一片顺路的街区。",
  noon: "中午留白，就近吃饭、找个地方坐坐。",
  afternoon: "下午留白，按当天的兴致再定。",
  evening: "晚上留白，晚饭后散步或看夜景都合适。",
  night: "夜里不安排，想续摊再说。",
};

function intentOf(stops: StopPlan[]): string | undefined {
  if (!stops.length) return undefined;
  const kinds = stops.map((s) => s.kind);
  if (kinds.includes("meal")) {
    const meal = stops.find((s) => s.kind === "meal");
    if (meal?.place?.name) return `吃：${meal.place.name}`;
    return "吃饭";
  }
  const first = stops[0];
  const text = `${first?.place?.name ?? ""} ${first?.place?.category ?? ""}`;
  if (/寺|庙|观|教堂/.test(text)) return "人文";
  if (/山|湖|海|公园|湿地|植物园/.test(text)) return "自然";
  if (/街|巷|市集|老城|古镇/.test(text)) return "逛街";
  if (/博物馆|馆|遗址|故居/.test(text)) return "看展";
  return "顺路看看";
}

export function buildSlots(day: DayPlan): DaySlot[] {
  const byPeriod = new Map<SlotPeriod, StopPlan[]>();
  for (const period of SLOT_PERIODS) byPeriod.set(period, []);
  for (const stop of [...day.stops].sort((a, b) => a.startMin - b.startMin)) {
    const period = periodOf(stop);
    byPeriod.get(period)?.push(stop);
  }

  // 上一段到最后一段的路程：从 day.legs 里按 from/to 的停靠点匹配。
  const legMinutes = (from: StopPlan | undefined, to: StopPlan | undefined) => {
    if (!from || !to) return undefined;
    const leg = day.legs.find(
      (l) =>
        (l.fromName === from.place.name && l.toName === to.place.name) ||
        (l.fromName === to.place.name && l.toName === from.place.name),
    );
    return leg?.durationMin;
  };

  let prevLast: StopPlan | undefined;
  return SLOT_PERIODS.map((period) => {
    const stops = byPeriod.get(period) ?? [];
    const first = stops[0];
    const last = stops[stops.length - 1];
    const slot: DaySlot = {
      period,
      stops,
      startMin: first?.startMin,
      endMin: last?.endMin,
      legFromPrevMin: prevLast ? legMinutes(prevLast, first) : undefined,
      intent: intentOf(stops),
      emptyHint: stops.length ? undefined : EMPTY_HINTS[period],
    };
    if (last) prevLast = last;
    return slot;
  });
}

/** 给整份计划的每一天补上 slots（不改 stops / legs / stats）。 */
export function withSlots<T extends DayPlan>(day: T): T {
  return { ...day, slots: buildSlots(day) };
}

/** 统计一天里有几个时段是真的有内容的——「一天只有一个点」会在这里暴露。 */
export function filledSlotCount(day: DayPlan): number {
  const slots = day.slots ?? buildSlots(day);
  return slots.filter((s) => s.stops.length > 0).length;
}
