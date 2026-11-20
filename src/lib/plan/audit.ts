import { placeDistance } from "../geo";
import type { DayPlan, PaceId, PlanResult } from "../types";
import {
  EARLY_END_MIN,
  HARD_CEIL_MIN,
  LATEST_START,
  MAX_DAY_SPAN_KM,
  MAX_DAY_TRAVEL_MIN,
  MAX_GAP_MIN,
  MAX_LEG_MIN,
  MAX_SAME_CATEGORY_RUN,
  MEAL_WINDOW,
  SIGHT_BAND,
} from "./limits";

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
}

function mm(value: number): string {
  const h = Math.floor(value / 60);
  const m = Math.round(value % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function inWindow(minute: number, [start, end]: [number, number]): boolean {
  return minute >= start && minute <= end;
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
  const lunch = meals.filter((stop) => inWindow(stop.startMin, MEAL_WINDOW.lunch));
  const dinner = meals.filter((stop) => inWindow(stop.startMin, MEAL_WINDOW.dinner));
  // 出发早、收工早的半日行程可以没有晚饭，但只要有午饭需求就该有午饭。
  if (!restDay && !lunch.length && day.endMin >= MEAL_WINDOW.lunch[1]) {
    push("NO_LUNCH", "warn", "午饭时段没有安排吃饭");
  }
  if (!restDay && !dinner.length && day.endMin >= MEAL_WINDOW.dinner[0] + 30) {
    push("NO_DINNER", "warn", "晚饭时段没有安排吃饭");
  }
  if (lunch.length && dinner.length && lunch[0].place.id === dinner[0].place.id) {
    push("MEAL_SAME_PLACE", "warn", "午饭和晚饭是同一家");
  }

  // ---------- 通勤 ----------
  for (const leg of day.legs) {
    const limit = day.far ? MAX_LEG_MIN + 60 : MAX_LEG_MIN;
    if (leg.durationMin > limit) {
      push(
        "LEG_TOO_LONG",
        day.far ? "warn" : "error",
        `${leg.fromName} → ${leg.toName} 要走 ${leg.durationMin} 分钟`,
      );
    }
  }
  if (day.stats.travelMin > MAX_DAY_TRAVEL_MIN) {
    push("DAY_TRAVEL_LONG", "warn", `一天在路上 ${day.stats.travelMin} 分钟`);
  }

  if (!restDay && !day.far && sights.length >= 2) {
    let span = 0;
    for (let i = 0; i < sights.length; i += 1) {
      for (let j = i + 1; j < sights.length; j += 1) {
        span = Math.max(span, placeDistance(sights[i].place, sights[j].place));
      }
    }
    if (span > MAX_DAY_SPAN_KM) {
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
    const [lo, hi] = SIGHT_BAND[options.pace];
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
    if (seen.has(stop.place.id)) {
      push("DUPLICATE_PLACE", "error", `「${stop.place.name}」在同一天出现两次`);
    }
    seen.add(stop.place.id);
  }

  return issues;
}

export function auditPlan(plan: PlanResult, options: AuditOptions): AuditIssue[] {
  const issues = plan.days.flatMap((day) => auditDay(day, options));
  // 跨天重复不是硬错误（有些城市确实会路过同一个点两次），但值得看一眼。
  const visits = new Map<string, Set<number>>();
  for (const day of plan.days) {
    for (const stop of day.stops) {
      if (stop.kind !== "sight") continue;
      const set = visits.get(stop.place.id) ?? new Set<number>();
      set.add(day.index);
      visits.set(stop.place.id, set);
    }
  }
  for (const day of plan.days) {
    for (const stop of day.stops) {
      if (stop.kind !== "sight") continue;
      const days = visits.get(stop.place.id);
      if (days && days.size > 1) {
        issues.push({
          code: "CROSS_DAY_REPEAT",
          severity: "warn",
          day: day.index,
          detail: `「${stop.place.name}」在第 ${[...days].join("、")} 天都去了`,
        });
        visits.delete(stop.place.id);
      }
    }
  }
  return issues;
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
