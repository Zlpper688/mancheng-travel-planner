import { placeDistance } from "../geo";
import type { DayPlan, PaceId, Place, PlanResult } from "../types";
import {
  EARLY_END_MIN,
  HARD_CEIL_MIN,
  LATEST_START,
  MAX_GAP_MIN,
  MAX_SAME_CATEGORY_RUN,
} from "./limits";
import { DEFAULT_PARAMS, type PlanParams } from "./params";

/**
 * 行程体检。
 *
 * 这个文件的定位不是「再修一条行程」，而是把「什么样的行程算离谱」写成
 * 机器能判定的断言。生成器每次出新方案，都拿同一套尺子量一遍：
 * 量过了才认为可交付，量不过就当场暴露，而不是等用户肉眼撞见。
 *
 * 分成两档：
 *   error —— 不该出现在任何一条真实行程里（11 点出门、跨午夜回酒店、时间倒挂）
 *   warn  —— 不典型但可接受（某天少了晚饭、一天只排了 2 个点）
 *
 * 全部按「天」独立判定，所以城市、天数、风格怎么变都不影响尺子本身。
 */

export type AuditSeverity = "error" | "warn";

export interface AuditIssue {
  /** 稳定的机器可读编码，便于统计出现率、做基线对比。 */
  code: string;
  severity: AuditSeverity;
  day?: number;
  detail: string;
}

export interface AuditOptions {
  pace: PaceId;
  /** 攻略复刻：出发时间由用户指定的顺序决定，不当成算法缺陷。 */
  isFixed?: boolean;
  /** 软参数覆盖；不传时等价于 DEFAULT_PARAMS，体检尺子与以前完全一致。 */
  params?: PlanParams;
}

function mm(value: number): string {
  const h = Math.floor(value / 60);
  const m = Math.round(value % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function inWindow(minute: number, [start, end]: [number, number]): boolean {
  return minute >= start && minute <= end;
}

/**
 * 「这是不是同一个地方」的判定键。
 *
 * 只比 id 是不够的：同一处景点在 OSM / 维基数据 / 本地知识库里各有各的 id，
 * 名字还会带后缀（「厦门大学」vs「厦门大学（思明校区）」）。实测就有一次
 * 3 天行程里排进了两次厦大、两次沙坡尾，而按 id 判重一声没吭。
 * 所以键取「去括号、去符号后的名字 + 类别」，坐标只在名字对不上时做兜底。
 */
function placeKeyOf(place: { name: string; category: string; lat: number; lng: number }): string {
  const name = place.name
    .replace(/[（(【\[].*?[）)】\]]/g, "")
    .replace(/[\s·•\-—_]/g, "")
    .toLowerCase();
  return `${place.category}|${name}`;
}

/** 名字不同但离得极近（150 m 内）也算同一处，兜住「XX 东门 / XX 景区」这类录法。 */
function nearSamePlace(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): boolean {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLng =
    (a.lng - b.lng) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLng) <= 0.15;
}

/** 一天里是不是只剩下午和晚上能玩（日落、夜市型）。这种日子晚出门是对的。 */
function isAfternoonOnly(day: DayPlan): boolean {
  const sights = day.stops.filter((stop) => stop.kind === "sight");
  if (!sights.length) return false;
  return sights.every((stop) => stop.startMin >= 13 * 60 + 30);
}

export function auditDay(day: DayPlan, options: AuditOptions): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const push = (code: string, severity: AuditSeverity, detail: string) =>
    issues.push({ code, severity, day: day.index, detail });
  const params = options.params ?? DEFAULT_PARAMS;

  const sights = day.stops.filter((stop) => stop.kind === "sight");
  const meals = day.stops.filter((stop) => stop.kind === "meal");
  const restDay = sights.length === 0;

  // ---------- 时间轴 ----------
  // 出发太晚。留白日本来就没几个点，不参与这条判定。
  if (!restDay && day.startMin > LATEST_START[options.pace] && !isAfternoonOnly(day)) {
    push(
      "DAY_START_LATE",
      options.isFixed ? "warn" : "error",
      `${mm(day.startMin)} 才出门，${mm(LATEST_START[options.pace])} 之前本该已经在路上`,
    );
  }

  if (day.endMin > HARD_CEIL_MIN) {
    push("DAY_END_LATE", "error", `${mm(day.endMin)} 才回酒店`);
  } else if (!restDay && day.endMin < EARLY_END_MIN && sights.length >= 3) {
    push(
      "DAY_END_EARLY",
      "warn",
      `排了 ${sights.length} 个点却在 ${mm(day.endMin)} 就收工，下午后半段空着`,
    );
  }

  for (const stop of day.stops) {
    if (stop.endMin <= stop.startMin) {
      push("STOP_INVERTED", "error", `「${stop.place.name}」${mm(stop.startMin)}–${mm(stop.endMin)} 时间倒挂`);
    }
  }

  const ordered = [...day.stops].sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const next = ordered[i];
    if (next.startMin < prev.endMin) {
      push(
        "STOP_OVERLAP",
        "error",
        `「${prev.place.name}」和「${next.place.name}」时间重叠`,
      );
    } else {
      const gap = next.startMin - prev.endMin;
      if (gap > MAX_GAP_MIN) {
        push(
          "DAY_BIG_GAP",
          "warn",
          `${mm(prev.endMin)}–${mm(next.startMin)} 空着 ${gap} 分钟`,
        );
      }
    }
  }

  // ---------- 吃饭 ----------
  const lunch = meals.filter((stop) => inWindow(stop.startMin, params.mealWindow.lunch));
  const dinner = meals.filter((stop) => inWindow(stop.startMin, params.mealWindow.dinner));
  // 出发早、收工早的半日行程可以没有晚饭，但只要有午饭需求就该有午饭。
  if (!restDay && !lunch.length && day.endMin >= params.mealWindow.lunch[1]) {
    push("NO_LUNCH", "warn", "午饭时段没有安排吃饭");
  }
  if (!restDay && !dinner.length && day.endMin >= params.mealWindow.dinner[0] + 30) {
    push("NO_DINNER", "warn", "晚饭时段没有安排吃饭");
  }
  if (lunch.length && dinner.length && lunch[0].place.id === dinner[0].place.id) {
    push("MEAL_SAME_PLACE", "warn", "午饭和晚饭是同一家");
  }

  // ---------- 通勤 ----------
  for (const leg of day.legs) {
    const limit = day.far ? params.maxLegMin + 60 : params.maxLegMin;
    if (leg.durationMin > limit) {
      push(
        "LEG_TOO_LONG",
        day.far ? "warn" : "error",
        `${leg.fromName} → ${leg.toName} 要走 ${leg.durationMin} 分钟`,
      );
    }
  }
  if (day.stats.travelMin > params.maxDayTravelMin) {
    push("DAY_TRAVEL_LONG", "warn", `一天在路上 ${day.stats.travelMin} 分钟`);
  }

  if (!restDay && !day.far && sights.length >= 2) {
    let span = 0;
    for (let i = 0; i < sights.length; i += 1) {
      for (let j = i + 1; j < sights.length; j += 1) {
        span = Math.max(span, placeDistance(sights[i].place, sights[j].place));
      }
    }
    if (span > params.maxDaySpanKm) {
      push("DAY_SPAN_WIDE", "warn", `当天点位跨度 ${span.toFixed(1)} 公里，来回横跳`);
    }
  }

  // ---------- 内容 ----------
  let run = 1;
  for (let i = 1; i < sights.length; i += 1) {
    run = sights[i].place.category === sights[i - 1].place.category ? run + 1 : 1;
    if (run === MAX_SAME_CATEGORY_RUN + 1) {
      push(
        "SAME_CATEGORY_RUN",
        "warn",
        `连着 ${run} 个「${sights[i].place.category}」`,
      );
    }
  }

  if (!restDay) {
    const [lo, hi] = params.sightsPerDay[options.pace];
    if (sights.length < lo || sights.length > hi) {
      push(
        "SIGHT_COUNT",
        "warn",
        `排了 ${sights.length} 个景点，${options.pace} 节奏通常 ${lo}–${hi} 个`,
      );
    }
  }

  const seen = new Set<string>();
  for (const stop of day.stops) {
    const key = placeKeyOf(stop.place);
    if (seen.has(key)) {
      push("DUPLICATE_PLACE", "error", `「${stop.place.name}」在同一天出现两次`);
    }
    seen.add(key);
  }

  return issues;
}

export function auditPlan(plan: PlanResult, options: AuditOptions): AuditIssue[] {
  const issues = plan.days.flatMap((day) => auditDay(day, options));
  for (const repeat of findCrossDayRepeats(plan.days)) {
    issues.push({
      code: "CROSS_DAY_REPEAT",
      severity: "warn",
      day: repeat.days[0],
      detail: `「${repeat.name}」在第 ${repeat.days.join("、")} 天都去了`,
    });
  }
  return issues;
}

/**
 * 找出「同一处景点被排进了两天」。
 *
 * 单独抽出来是为了能单测（`scripts/check-dedupe.ts`）。判定不能用 id：
 * 同一处景点在 OSM / 维基数据 / 本地知识库里各有各的 id，名字还带后缀
 * （「厦门大学」vs「厦门大学（思明校区）」），实测就漏过一次「厦大排两遍」。
 * 所以先按「去括号的名字 + 类别」归并，再用 150m 坐标兜一层不同名字的录法。
 */
export function findCrossDayRepeats(
  days: Pick<DayPlan, "index" | "stops">[],
): Array<{ key: string; name: string; days: number[] }> {
  const visits = new Map<string, { days: Set<number>; name: string; point: Place }>();
  for (const day of days) {
    for (const stop of day.stops) {
      if (stop.kind !== "sight") continue;
      const key = placeKeyOf(stop.place);
      const entry =
        visits.get(key) ?? { days: new Set<number>(), name: stop.place.name, point: stop.place };
      entry.days.add(day.index);
      visits.set(key, entry);
    }
  }

  const keys = [...visits.keys()];
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = visits.get(keys[i]);
      const b = visits.get(keys[j]);
      if (!a || !b) continue;
      if (!nearSamePlace(a.point, b.point)) continue;
      for (const day of b.days) a.days.add(day);
      visits.delete(keys[j]);
    }
  }

  const out: Array<{ key: string; name: string; days: number[] }> = [];
  for (const [key, entry] of visits) {
    if (entry.days.size > 1) {
      out.push({ key, name: entry.name, days: [...entry.days].sort((x, y) => x - y) });
    }
  }
  return out.sort((a, b) => a.days[0] - b.days[0]);
}


export function summarizeAudit(issues: AuditIssue[]): {
  errors: number;
  warns: number;
  byCode: Record<string, number>;
} {
  const byCode: Record<string, number> = {};
  let errors = 0;
  let warns = 0;
  for (const issue of issues) {
    byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;
    if (issue.severity === "error") errors += 1;
    else warns += 1;
  }
  return { errors, warns, byCode };
}
