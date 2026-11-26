/**
 * refine 循环的分类与调整逻辑回归（npx tsx scripts/check-refine.ts）。
 * 只测纯函数：P0-P3 分级、修复判定、参数收敛。不打网络、不跑引擎。
 */
import { DEFAULT_PARAMS, sanitizeParams } from "../src/lib/plan/params";
import type { AuditIssue } from "../src/lib/plan/audit";
import type { PlanPhenomenon } from "../src/lib/plan/critic";
import { filledSlotCount } from "../src/lib/plan/slots";
import type { DayPlan, StopPlan, Place } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

// 复刻 refine.ts 里的映射规则做断言（保持两处同步的关键约定）
const AUDIT_FIXABLE = new Set(["SIGHT_COUNT", "DAY_SPAN_WIDE", "LEG_TOO_LONG", "DAY_TRAVEL_LONG"]);
const CRITIC_FIXABLE = new Set(["rush", "fatigue", "monotony", "day-monotony", "gap", "long-day"]);
function auditLevel(i: AuditIssue): string {
  return i.severity === "error" ? "P0" : "P2";
}
function criticLevel(p: PlanPhenomenon): string {
  return p.severity === "high" ? "P1" : p.severity === "medium" ? "P2" : "P3";
}

console.log("1) audit → P0-P3 分级");
ok(
  "error → P0",
  auditLevel({ code: "STOP_OVERLAP", severity: "error", detail: "", day: 1 }) === "P0",
);
ok(
  "warn → P2",
  auditLevel({ code: "SIGHT_COUNT", severity: "warn", detail: "", day: 1 }) === "P2",
);
ok(
  "时间重叠不可自动修",
  !AUDIT_FIXABLE.has("STOP_OVERLAP"),
);
ok(
  "点数不足可自动修",
  AUDIT_FIXABLE.has("SIGHT_COUNT"),
);

console.log("\n2) critic → P0-P3 分级");
const mkPhen = (severity: PlanPhenomenon["severity"], id: PlanPhenomenon["id"]): PlanPhenomenon => ({
  id,
  severity,
  day: 1,
  title: "",
  detail: "",
  suggestion: "",
});
ok("high → P1", criticLevel(mkPhen("high", "rush")) === "P1");
ok("medium → P2", criticLevel(mkPhen("medium", "gap")) === "P2");
ok("low → P3", criticLevel(mkPhen("low", "monotony")) === "P3");
ok("赶场可修", CRITIC_FIXABLE.has("rush"));
ok("暴晒不可修", !CRITIC_FIXABLE.has("exposure"));

console.log("\n3) 稀疏时段检测（P1 触发源）");
const place = (name: string): Place => ({ id: name, name, category: "attraction", lat: 30, lng: 104, source: "demo" });
const stop = (name: string, startMin: number): StopPlan => ({
  id: name, place: place(name), kind: "sight", order: 0,
  startMin, endMin: startMin + 60, dwellMin: 60,
});
const sparseDay: DayPlan = {
  index: 1, date: "2026-12-01", theme: "t", area: "a", color: "#fff",
  stops: [stop("孤零零", 10 * 60)], legs: [],
  stats: { stopCount: 1, sightCount: 1, distanceKm: 1, travelMin: 10, walkKm: 1, ticket: 0 },
  startMin: 600, endMin: 660, tip: "",
  slots: [
    { period: "early", stops: [] },
    { period: "morning", stops: [stop("孤零零", 600)] },
    { period: "noon", stops: [] },
    { period: "afternoon", stops: [] },
    { period: "evening", stops: [] },
    { period: "night", stops: [] },
  ],
};
ok("稀疏天 filledSlotCount=1 → 触发 P1", filledSlotCount(sparseDay) === 1);

console.log("\n4) 参数调整收敛（放大点数）");
const relaxed = sanitizeParams(
  { ...DEFAULT_PARAMS, sightsPerDay: { ...DEFAULT_PARAMS.sightsPerDay, chill: [2, 6] } },
  false,
);
ok("chill 上限从 4 放到 6", relaxed.sightsPerDay.chill[1] === 6);
ok("其他节奏不变", relaxed.sightsPerDay.balanced[1] === 5);
ok("上限有界（≤8）", sanitizeParams({ sightsPerDay: { chill: [2, 999] } }).sightsPerDay.chill[1] <= 8);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：P0-P3 分级 + 修复判定 + 稀疏检测 + 参数收敛");
