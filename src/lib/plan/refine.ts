import type { PlanResult, TripInput } from "../types";
import { planTrip } from "./engine";
import {
  DEFAULT_PARAMS,
  sanitizeParams,
  type PlanParams,
} from "./params";
import { auditPlan, type AuditIssue } from "./audit";
import { critiquePlan, type PlanPhenomenon } from "./critic";
import { filledSlotCount } from "./slots";
import type { PaceId } from "../types";

/**
 * 生成 → 反驳 → 修订 循环（宪法 Step 3）。
 *
 * 关键设计：
 * 1. 默认也跑，但**大多数行程一轮就过**（没有 P0/P1 就直接返回），零额外成本。
 * 2. 只改软参数（PlanParams），绝不碰硬约束（日期/人数/点名必去点/酒店）。
 * 3. 每轮必须真的改善，否则回退到最佳版本；最多 maxRounds 轮，参数不再变就收。
 * 4. 确定性 critic（现有 critic.ts + audit.ts）负责挑毛病；LLM critic 是上层增强，
 *    不在这里阻塞 —— 规则能判的先规则判，别为"看起来高级"每轮都烧 token。
 */
export type IssueLevel = "P0" | "P1" | "P2" | "P3";

export interface RefineIssue {
  level: IssueLevel;
  code: string;
  day?: number;
  detail: string;
  suggestion: string;
  /** 能不能靠调软参数修；不能的依据宪法要「说明不去理由」交给用户。 */
  fixable: boolean;
}

export interface RefineResult {
  plan: PlanResult;
  rounds: number;
  issues: RefineIssue[];
  /** 每轮实际调了什么，写进 dataNotes 让用户看见，不静默改。 */
  adjustments: string[];
  score: number;
}

const LEVEL_PENALTY: Record<IssueLevel, number> = {
  P0: 100,
  P1: 20,
  P2: 5,
  P3: 1,
};

/**
 * 每个体检项对应的「该怎么改」。
 *
 * 原来这里直接 `suggestion: issue.detail`，于是 UI 上会出现
 * 「问题：排了 4 个点却在 14:57 就收工 / 建议：排了 4 个点却在 14:57 就收工」——
 * 把问题复述一遍不等于给建议。宪法二要求的是「牺牲什么、得到什么」。
 */
const AUDIT_SUGGESTIONS: Record<string, string> = {
  DAY_START_LATE: "把出发时间提到 08:30–09:00：早上的景点人最少，也能给下午留出缓冲。",
  DAY_END_LATE: "砍掉当天最后一个点，或把它挪到另一天；20:30 之后回酒店对多数人不划算。",
  DAY_END_EARLY: "两种改法：① 下午顺路补一个 2 km 内的点；② 就这样早点回去休息，留白也是行程的一部分。",
  STOP_INVERTED: "这一段的时长算错了，需要重排当天时刻。",
  STOP_OVERLAP: "两个点的时间撞在一起了，把后一个点顺延或换到别的时段。",
  DAY_BIG_GAP: "中间空了两小时以上：补一个顺路点，或把下一段提前、把这段时间明确写成自由活动。",
  NO_LUNCH: "把午饭固定进 11:30–13:30，别让上午的点吃到中午。",
  NO_DINNER: "晚饭时段留出来；晚饭前不要再排需要 90 分钟以上的点。",
  MEAL_SAME_PLACE: "午饭和晚饭换到不同片区，顺路感会好很多。",
  LEG_TOO_LONG: "换一个更近的点，或把这段路改用打车/公交，并接受到达时间推后。",
  DAY_TRAVEL_LONG: "当天点太分散：砍掉最远的一个，或把这一片单独拆成一天。",
  DAY_SPAN_WIDE: "把同一片区的点集中到同一天，别在城东和城西之间来回横跳。",
  SAME_CATEGORY_RUN: "连着的三个同类点里换掉一个，体验差异比数量更重要。",
  SIGHT_COUNT: "这一天的点位数量偏离节奏设定，调高或调低每日点数，或换一天再排。",
  DUPLICATE_PLACE: "同一天里同一个地方出现了两次，删掉后一次。",
  CROSS_DAY_REPEAT: "同一个地方排进了两天：换成同片区另一个点，或把这一天改成另一片方向。",
};

/** audit 的 error/warn + critic 的 high/medium/low → 宪法的 P0–P3。 */
function fromAudit(issue: AuditIssue, pace: PaceId): RefineIssue {
  // 留白是宪法三明确允许的节奏需求，不该一律当问题：
  // 慢节奏只作提示（P3），只有「排得满」的节奏下早收工才算明显不合理（P2）。
  const earlyFinish = issue.code === "DAY_END_EARLY";
  const level: IssueLevel = earlyFinish
    ? pace === "packed"
      ? "P2"
      : "P3"
    : issue.severity === "error"
      ? "P0"
      : "P2";
  // 时间重叠、重复点位这类硬伤不是调参数能修的。
  const fixable =
    [
      "SIGHT_COUNT",
      "DAY_SPAN_WIDE",
      "LEG_TOO_LONG",
      "DAY_TRAVEL_LONG",
      "SAME_CATEGORY_RUN",
    ].includes(issue.code) || (earlyFinish && pace === "packed");
  return {
    level,
    code: `audit:${issue.code}`,
    day: issue.day,
    detail: issue.detail,
    suggestion: AUDIT_SUGGESTIONS[issue.code] ?? issue.detail,
    fixable,
  };
}

function fromCritic(phenomenon: PlanPhenomenon): RefineIssue {
  const level: IssueLevel =
    phenomenon.severity === "high"
      ? "P1"
      : phenomenon.severity === "medium"
        ? "P2"
        : "P3";
  const fixable = ["rush", "fatigue", "monotony", "day-monotony", "gap", "long-day"].includes(
    phenomenon.id,
  );
  return {
    level,
    code: `critic:${phenomenon.id}`,
    day: phenomenon.day,
    detail: phenomenon.detail,
    suggestion: phenomenon.suggestion,
    fixable,
  };
}

/** 时段结构完整性也是一类 critic：一天只剩一个点，属于 P1（明显不合理）。 */
function fromSlots(plan: PlanResult): RefineIssue[] {
  const out: RefineIssue[] = [];
  for (const day of plan.days) {
    const slots = day.slots ?? [];
    if (!slots.length) continue;
    const filled = filledSlotCount(day);
    if (filled === 0) {
      out.push({
        level: "P0",
        code: "slot:empty",
        day: day.index,
        detail: `第 ${day.index} 天六个时段全空。`,
        suggestion: "需要重新选点。",
        fixable: true,
      });
    } else if (filled === 1) {
      out.push({
        level: "P1",
        code: "slot:sparse",
        day: day.index,
        detail: `第 ${day.index} 天只有 1 个时段有安排，其余全空。`,
        suggestion: "放宽每日点数或搜索半径，让这一天有内容。",
        fixable: true,
      });
    }
  }
  return out;
}

function collectIssues(
  plan: PlanResult,
  input: TripInput,
  params: PlanParams,
  isRegion: boolean,
): RefineIssue[] {
  const pace: PaceId = input.pace;
  let auditIssues = auditPlan(plan, {
    pace,
    isFixed: plan.meta.isFixed,
    params,
  });
  // 区域游一天跨百公里是常态，城市尺度的「单段 90 分钟 / 跨度 22km」不适用。
  // 这些误报会让 refine 徒劳调参、越调越差（实测把点数从 4 压到 2）。
  if (isRegion) {
    auditIssues = auditIssues.filter(
      (i) =>
        !["LEG_TOO_LONG", "DAY_SPAN_WIDE", "DAY_TRAVEL_LONG"].includes(i.code),
    );
  }
  const critique = critiquePlan(plan.days, {
    pace,
    family:
      input.children > 0 ||
      (input.seniors ?? 0) > 0 ||
      input.styles.includes("family"),
    styles: input.styles,
  });
  let criticIssues = critique.phenomena;
  if (isRegion) {
    // 跨片区移动是区域游的定义，不算折返/长日；但太赶、空档仍要报。
    criticIssues = criticIssues.filter(
      (p) => p.id !== "backtrack" && p.id !== "long-day",
    );
  }
  return [
    ...auditIssues.map((issue) => fromAudit(issue, pace)),
    ...criticIssues.map(fromCritic),
    ...fromSlots(plan),
  ];
}

function scoreOf(issues: RefineIssue[]): number {
  return issues.reduce((sum, i) => sum + LEVEL_PENALTY[i.level], 0);
}

/** 严格分级比较：P0 少者胜；P0 相同比 P1，以此类推。
 *  宪法 P0 > P1 > P2 > P3 是字典序，不是加权求和——
 *  否则 4 个小问题(P2)会和 1 个稀疏(P1)打平，选错版本。 */
function countByLevel(issues: RefineIssue[]): [number, number, number, number] {
  let p0 = 0; let p1 = 0; let p2 = 0; let p3 = 0;
  for (const i of issues) {
    if (i.level === "P0") p0 += 1;
    else if (i.level === "P1") p1 += 1;
    else if (i.level === "P2") p2 += 1;
    else p3 += 1;
  }
  return [p0, p1, p2, p3];
}

function isStrictlyBetter(
  a: RefineIssue[],
  b: RefineIssue[],
): boolean {
  const x = countByLevel(a);
  const y = countByLevel(b);
  for (let i = 0; i < 4; i += 1) {
    if (x[i] < y[i]) return true;
    if (x[i] > y[i]) return false;
  }
  return scoreOf(a) < scoreOf(b);
}

/**
 * 依据 P0/P1 调整软参数。返回 null 表示没有可修的，或已经到边界。
 * 注意：这里只调"上限"，不替用户删点、不换城市、不改日期。
 */
function adjustParams(params: PlanParams, issues: RefineIssue[], pace: PaceId): PlanParams | null {
  const p0p1 = issues.filter((i) => (i.level === "P0" || i.level === "P1") && i.fixable);
  if (!p0p1.length) return null;

  const raw: Record<string, unknown> = {};
  const currentBand = params.sightsPerDay[pace];
  let band: [number, number] = currentBand;

  const sparse = p0p1.some((i) => i.code === "slot:sparse" || i.code === "slot:empty");
  const crowded = p0p1.some((i) => i.code.startsWith("critic:rush") || i.code.startsWith("critic:fatigue"));
  // 宪法三：一天只有一个点是 P1（明显不合理），比「排太满」严重得多。
  // 稀疏存在时绝不走减少点数分支——那会让本来就空的一天更空（实测踩过这个坑）。
  if (sparse && currentBand[1] < 8) {
    band = [currentBand[0], Math.min(8, currentBand[1] + 2)];
  } else if (!sparse && crowded && currentBand[0] > 2) {
    band = [Math.max(2, currentBand[0] - 1), currentBand[1]];
  }

  // 节奏本身排得满（packed），却在下午就收工：说明每天点数的下限给低了，
  // 抬一格下限比「补一个顺路点」更稳——后者会挑到不该去的点。
  const earlyFinish = p0p1.some((i) => i.code === "audit:DAY_END_EARLY");
  if (earlyFinish && !sparse && band === currentBand && band[0] < 7) {
    band = [Math.min(7, band[0] + 1), band[1]];
  }

  if (band !== currentBand) raw.sightsPerDay = { ...params.sightsPerDay, [pace]: band };

  // 稀疏往往不是「每天点数上限」的问题，而是候选池在那个方向没点。
  // 放大远足搜索半径，让城外/片区的景点进池（Step 1 实测证明这能带来大熊猫基地）。
  if (sparse && params.farLimitKm < 120) {
    raw.farLimitKm = Math.min(120, params.farLimitKm + 30);
  }

  const wide = p0p1.some((i) => i.code.startsWith("audit:DAY_SPAN_WIDE"));
  const longLeg = p0p1.some((i) => i.code.startsWith("audit:LEG_TOO_LONG"));
  const longDay = p0p1.some((i) =>
    i.code.startsWith("audit:DAY_TRAVEL_LONG") || i.code.startsWith("critic:long-day"),
  );
  if (wide && params.maxDaySpanKm < 80) raw.maxDaySpanKm = Math.min(80, params.maxDaySpanKm * 1.6);
  if (longLeg && params.maxLegMin < 180) raw.maxLegMin = Math.min(180, params.maxLegMin + 30);
  // 一天在路上太久：不是放大上限，而是少排点。
  if (longDay && currentBand[1] > 2) {
    raw.sightsPerDay = { ...params.sightsPerDay, [pace]: [Math.max(2, currentBand[0] - 1), currentBand[1] - 1] };
  }
  if (p0p1.some((i) => i.code.startsWith("critic:gap")) && params.lodgingClusterKm < 24) {
    raw.lodgingClusterKm = Math.min(24, params.lodgingClusterKm + 4);
  }

  if (!Object.keys(raw).length) return null;
  const next = sanitizeParams(
    {
      ...params,
      ...raw,
      sightsPerDay: raw.sightsPerDay ?? params.sightsPerDay,
    },
    params.avoidSteep,
  );
  const changed = JSON.stringify(next) !== JSON.stringify(params);
  return changed ? next : null;
}

function describeChange(before: PlanParams, after: PlanParams, pace: PaceId): string {
  const parts: string[] = [];
  if (JSON.stringify(before.sightsPerDay[pace]) !== JSON.stringify(after.sightsPerDay[pace])) {
    parts.push(`每日点数 ${before.sightsPerDay[pace].join("-")}→${after.sightsPerDay[pace].join("-")}`);
  }
  if (before.maxDaySpanKm !== after.maxDaySpanKm) {
    parts.push(`单日跨度 ${Math.round(before.maxDaySpanKm)}→${Math.round(after.maxDaySpanKm)}km`);
  }
  if (before.maxLegMin !== after.maxLegMin) {
    parts.push(`单段路程 ${before.maxLegMin}→${after.maxLegMin} 分钟`);
  }
  if (before.lodgingClusterKm !== after.lodgingClusterKm) {
    parts.push(`片区半径 ${before.lodgingClusterKm}→${after.lodgingClusterKm}km`);
  }
  return parts.join("，") || "微调";
}

export async function refinePlan(
  input: TripInput,
  maxRounds = 3,
): Promise<RefineResult> {
  // 区域游用不同的体检尺子（见 collectIssues）。
  let isRegion = false;
  try {
    const { readLocalKnowledge } = await import("../providers/knowledge");
    const kb = await readLocalKnowledge(input.city);
    isRegion = kb.form === "region-loop";
  } catch {
    isRegion = false;
  }

  let params = input.planParams ?? DEFAULT_PARAMS;
  let best: { plan: PlanResult; score: number; issues: RefineIssue[]; params: PlanParams } | null = null;
  const adjustments: string[] = [];
  let rounds = 0;
  let stagnant = 0;

  for (let round = 1; round <= Math.max(1, Math.min(4, maxRounds)); round += 1) {
    rounds = round;
    const plan = await planTrip({ ...input, planParams: params });
    const issues = collectIssues(plan, input, params, isRegion);
    const score = scoreOf(issues);
    const improved = !best || isStrictlyBetter(issues, best.issues);
    if (improved) {
      best = { plan, score, issues, params };
      stagnant = 0;
    } else {
      stagnant += 1;
    }

    const p0p1 = issues.filter((i) => i.level === "P0" || i.level === "P1");
    if (!p0p1.length) break;
    // 连续两轮没有改善：这一版的问题不是软参数能修的，早点收手，别烧时间。
    if (stagnant >= 2) break;

    // 从「最佳版本的参数」继续调，而不是从上一轮——否则一轮调坏后越走越远。
    const base = best!.params;
    const next = adjustParams(base, issues, input.pace);
    if (!next) break;
    adjustments.push(
      `${improved ? "" : "（本轮未改善，回退后重试）"}第 ${round} 轮体检发现 ${p0p1.length} 个明显问题，自动调整：${describeChange(base, next, input.pace)}`,
    );
    params = next;
  }

  const chosen = best!;
  // 宪法二：不静默改。把调整理由写进 dataNotes，用户能看见。
  const notes = [...adjustments];
  // 宪法二：不假装修好。调了参数仍有 P0/P1，就明确告诉用户「自动调不动」，
  // 并说明原因（候选池不足不是参数能解决的），把选择权交回用户。
  const unresolved = chosen.issues.filter(
    (i) => (i.level === "P0" || i.level === "P1"),
  );
  if (unresolved.length && adjustments.length) {
    const days = [...new Set(unresolved.map((i) => i.day).filter(Boolean))];
    notes.push(
      `自动调整后第 ${days.join("、") || "部分"} 天仍有 ${unresolved.length} 个明显问题（多半是那一带可用景点不够，不是参数能补的）——可以在地图上加景点、或改天数/换片区。`,
    );
  }
  if (notes.length) {
    chosen.plan = {
      ...chosen.plan,
      meta: {
        ...chosen.plan.meta,
        dataNotes: [...chosen.plan.meta.dataNotes, ...notes],
      },
    };
  }
  return {
    plan: chosen.plan,
    rounds,
    issues: chosen.issues,
    adjustments,
    score: chosen.score,
  };
}
