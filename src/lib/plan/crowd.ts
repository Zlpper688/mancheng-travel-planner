/**
 * 人流时段 —— 同一个景点，8 点和 11 点是两种体验。
 *
 * 现有的 crowdFactor 是「天级」的：假期整体加权 1.3，只影响停留时长，
 * 不知道「鼓浪屿上午十点开始排队」这种事。攻略里最值钱的一条信息恰恰是这个。
 *
 * 数据只可能来自两处：
 *   1. 人工核实过的人流时段（PlaceProfile.crowd，可选）；
 *   2. 没有数据时，按「类别 + 名气 + 点位节律」推断的规律。
 * 推断出来的东西一律标 source: "heuristic"，文案也只说规律，不编具体人数。
 */
import { CROWD_HOURS } from "../../content/crowd-hours";
import { findPlaceProfile } from "../tips/lookup";
import { cleanNameForMatch } from "../providers/normalize";
import type { Place } from "../types";

export interface CrowdWindow {
  /** 拥挤时段（分钟区间） */
  peak: Array<[number, number]>;
  /** 相对清静的时段 */
  valley: Array<[number, number]>;
  /** 拥挤时停留会被拉长的系数（1 = 不受影响） */
  factor: number;
  source: "data" | "heuristic";
}

const EMPTY: CrowdWindow = { peak: [], valley: [], factor: 1, source: "heuristic" };

function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59) return null;
  return hour * 60 + minute;
}

function toWindow(list?: string[]): Array<[number, number]> {
  if (!Array.isArray(list)) return [];
  const out: Array<[number, number]> = [];
  for (const item of list) {
    const [start, end] = String(item).split("-");
    const a = parseClock(start ?? "");
    const b = parseClock(end ?? "");
    if (a !== null && b !== null && b > a) out.push([a, b]);
  }
  return out;
}

/**
 * 采样数据（crowd-hours.ts）：优先级最高，也是唯一会被当成「实测」的来源。
 * 整名匹配，避免鼓浪屿的子景点继承整岛的规律。
 */
function readVerified(place: Place): CrowdWindow | null {
  const target = cleanNameForMatch(place.name);
  const city = place.city ?? "";
  if (!target || !city) return null;
  for (const entry of CROWD_HOURS) {
    if (!(city.includes(entry.city) || entry.city.includes(city))) continue;
    if (cleanNameForMatch(entry.name) !== target) continue;
    const peak = toWindow(entry.peak);
    if (!peak.length) continue;
    return {
      peak,
      valley: toWindow(entry.valley),
      factor:
        typeof entry.factor === "number" && entry.factor >= 1
          ? Math.min(1.5, entry.factor)
          : 1.15,
      source: "data",
    };
  }
  return null;
}

function readOverride(place: Place): CrowdWindow | null {
  const profile = findPlaceProfile(place.city ?? "", place.name);
  const raw = profile?.crowd;
  if (!raw) return null;
  const peak = toWindow(raw.peak);
  const valley = toWindow(raw.valley);
  if (!peak.length) return null;
  return {
    peak,
    valley,
    factor: typeof raw.factor === "number" && raw.factor >= 1 ? raw.factor : 1.15,
    source: "data",
  };
}

/**
 * 推断规则（写在这里而不是数据里，是因为它必须能被解释）：
 *   · 名气 ≥4.5 的常规景点：上午 10 点后与下午 2 点后两波团队客，午前与傍晚相对空。
 *   · 早市：8 点前人最少，9 点后本地人收摊、游客上来。
 *   · 博物馆：开馆后一小时最好逛，11 点后到下午 3 点是高峰。
 *   · 寺庙：7:30 前后香客少，9 点后旅行团到。
 *   · 日落点：日落前 90 分钟人人都来，之前一小时反而空。
 *   · 夜市/步行街：19 点后进入状态，17–18 点最舒服。
 */
function infer(place: Place): CrowdWindow {
  const text = `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")}`;
  const popularity = place.popularity ?? 3.4;
  const famous = popularity >= 4.5 || (place.rating ?? 0) >= 4.6;
  if (!famous) return EMPTY;

  if (place.category === "market" || /早市|菜市场|八市/.test(text)) {
    return {
      peak: [[9 * 60, 11 * 60]],
      valley: [[7 * 60, 8 * 60 + 30]],
      factor: 1.2,
      source: "heuristic",
    };
  }
  if (place.category === "museum") {
    return {
      peak: [[11 * 60, 15 * 60]],
      valley: [[9 * 60, 10 * 60 + 30]],
      factor: 1.15,
      source: "heuristic",
    };
  }
  if (place.category === "temple") {
    return {
      // 寺庙的旅行团普遍 9:30 后才到，9 点整进门其实还算清静。
      peak: [[9 * 60 + 30, 11 * 60 + 30]],
      valley: [[7 * 60 + 30, 8 * 60 + 30]],
      factor: 1.15,
      source: "heuristic",
    };
  }
  if (/日落|夕阳|晚霞/.test(text)) {
    return {
      peak: [[16 * 60 + 30, 18 * 60 + 30]],
      valley: [[15 * 60, 16 * 60]],
      factor: 1.25,
      source: "heuristic",
    };
  }
  if (place.category === "street" && /夜市|步行街/.test(text)) {
    return {
      peak: [[19 * 60, 21 * 60]],
      valley: [[17 * 60, 18 * 60]],
      factor: 1.2,
      source: "heuristic",
    };
  }
  if (place.category === "beach" || place.category === "viewpoint") {
    return {
      peak: [[10 * 60, 11 * 60 + 30], [15 * 60, 17 * 60]],
      valley: [[8 * 60, 9 * 60 + 30]],
      factor: 1.15,
      source: "heuristic",
    };
  }
  return {
    peak: [[10 * 60, 11 * 60 + 30], [14 * 60, 16 * 60]],
    valley: [[8 * 60, 9 * 60 + 30], [16 * 60 + 30, 17 * 60 + 30]],
    factor: 1.2,
    source: "heuristic",
  };
}

export function crowdOf(place: Place): CrowdWindow {
  return readVerified(place) ?? readOverride(place) ?? infer(place);
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * 排序代价（分钟量级）：撞上高峰就加罚，落在低谷轻微减罚。
 * 减罚封顶 0.6，避免「为了躲人」把一天拆得七零八落。
 */
export function crowdPenaltyAt(
  window: CrowdWindow,
  startMin: number,
  dwellMin: number,
): number {
  if (!window.peak.length && !window.valley.length) return 0;
  const end = startMin + Math.max(20, dwellMin);
  let penalty = 0;
  for (const [start, endPeak] of window.peak) {
    const minutes = overlap(startMin, end, start, endPeak);
    if (minutes > 0) penalty += (minutes / 60) * 1.6;
  }
  for (const [start, endValley] of window.valley) {
    const minutes = overlap(startMin, end, start, endValley);
    if (minutes > 0) penalty -= Math.min(0.6, (minutes / 60) * 0.8);
  }
  return penalty;
}

/**
 * 拥挤对停留时长的放大系数（只对「有人工核实的时段数据」生效）。
 *
 * 为什么不作用到推断结果上：推断出「10 点人最多」，如果因此把 10 点的停留拉长，
 * 排队时间会把整条下午顺延，等于自己制造下一个高峰——这正是修掉的那个病。
 * 有真实数据时才有理由承认「这个点确实要排更久」。
 */
export function crowdDwellFactor(
  window: CrowdWindow,
  startMin: number,
  dwellMin: number,
): number {
  if (window.source !== "data" || window.factor <= 1) return 1;
  const end = startMin + Math.max(20, dwellMin);
  const crowded = window.peak.reduce(
    (sum, [start, finish]) => sum + overlap(startMin, end, start, finish),
    0,
  );
  // 只有大半个停留都落在高峰里才拉长，擦边不算。
  if (crowded < Math.max(30, Math.max(20, dwellMin) * 0.5)) return 1;
  return Math.min(1.5, window.factor);
}

function clockText(minute: number): string {
  const hour = Math.floor(minute / 60);
  const mins = minute % 60;
  return `${hour}:${String(mins).padStart(2, "0")}`;
}

/**
 * 写给人看的提示。
 *
 * 只在「排得正好」和「撞上高峰」两种情况下说话：
 * 一个每站都说「建议早点来」的系统，等于什么都没说。
 */
export function crowdNote(
  window: CrowdWindow,
  startMin: number,
  dwellMin: number,
): string | null {
  if (!window.peak.length && !window.valley.length) return null;
  const end = startMin + Math.max(20, dwellMin);
  // 只提醒「明显撞上」的情况：重叠不足一半，说明这一站大部分时间都不在高峰，
  // 为这点重叠写一句警告，只会让整份行程变成免责声明。
  const inPeak = window.peak.find(
    ([start, finish]) =>
      overlap(startMin, end, start, finish) >= Math.max(45, Math.max(20, dwellMin) * 0.5),
  );
  const inValley = window.valley.find(
    ([start, finish]) => overlap(startMin, end, start, finish) >= 20,
  );
  const nextPeak = [...window.peak]
    .filter(([start]) => start > startMin)
    .sort((a, b) => a[0] - b[0])[0];

  if (inPeak) {
    const [start, finish] = inPeak;
    return `${clockText(start)}–${clockText(finish)} 是人最多的时段，能早半小时或晚一点来会舒服很多`;
  }
  if (inValley) {
    const [, finish] = inValley;
    return nextPeak
      ? `这一段人相对少，${clockText(finish)} 之后开始排长队，按现在这个点刚好`
      : "这一段人相对少，按现在这个点刚好";
  }
  return null;
}
