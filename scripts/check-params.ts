/**
 * PlanParams 回归检查（用 tsx 跑：npx tsx scripts/check-params.ts）。
 *
 * 证明三件事：
 *   1. 默认值 = 原有硬编码常量（不传参数零回归）
 *   2. sanitizeParams 对 LLM 的乱值做范围收敛，不会放进危险值
 *   3. 传了参数后，下游函数（farOneWayCap / farLimitKm）行为真的会变
 */
import { DEFAULT_PARAMS, sanitizeParams } from "../src/lib/plan/params";
import { farOneWayCap } from "../src/lib/plan/select/shared";
import { farLimitKm } from "../src/lib/plan/select/far";
import {
  MAX_DAY_SPAN_KM,
  MAX_LEG_MIN,
  MAX_DAY_TRAVEL_MIN,
  SIGHT_BAND,
  MEAL_WINDOW,
} from "../src/lib/plan/limits";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

console.log("1) 默认值 = 原有硬编码（零回归）");
ok("maxLegMin", DEFAULT_PARAMS.maxLegMin === MAX_LEG_MIN);
ok("maxDaySpanKm", DEFAULT_PARAMS.maxDaySpanKm === MAX_DAY_SPAN_KM);
ok("maxDayTravelMin", DEFAULT_PARAMS.maxDayTravelMin === MAX_DAY_TRAVEL_MIN);
ok(
  "sightsPerDay",
  JSON.stringify(DEFAULT_PARAMS.sightsPerDay) === JSON.stringify(SIGHT_BAND),
);
ok(
  "mealWindow",
  JSON.stringify(DEFAULT_PARAMS.mealWindow) === JSON.stringify(MEAL_WINDOW),
);
ok("farOneWayCap 两天 65", farOneWayCap(2) === 65);
ok("farOneWayCap 三天 90", farOneWayCap(3) === 90);
ok("farOneWayCap 四天 110", farOneWayCap(4) === 110);
ok("farLimitKm 默认 45", farLimitKm([]) === 45);
ok("farLimitKm family 32", farLimitKm(["family"]) === 32);
// sightsPerDay 区间上限减 1 = 每日目标点数，默认值必须与 PACES.sights 对齐（零回归）
ok("chill 目标点数 3", DEFAULT_PARAMS.sightsPerDay.chill[1] - 1 === 3);
ok("balanced 目标点数 4", DEFAULT_PARAMS.sightsPerDay.balanced[1] - 1 === 4);
ok("packed 目标点数 6", DEFAULT_PARAMS.sightsPerDay.packed[1] - 1 === 6);

console.log("\n2) sanitizeParams 对乱值收敛");
const wild = sanitizeParams({
  maxLegMin: -9999,
  maxDaySpanKm: 99999,
  sightsPerDay: { chill: [99, 1], balanced: "bad" },
  mealWindow: { lunch: [9999, -1] },
  farOneWayCapByDays: { twoOrLess: NaN },
  farLimitKm: 999999,
  restEachDay: "yes",
});
ok("负数 maxLegMin 收敛到下限", wild.maxLegMin >= 20, `实际 ${wild.maxLegMin}`);
ok("超大 maxDaySpanKm 收敛到上限", wild.maxDaySpanKm <= 100, `实际 ${wild.maxDaySpanKm}`);
ok("乱序 sightsPerDay 修正", wild.sightsPerDay.chill[0] <= wild.sightsPerDay.chill[1]);
ok("非数组 band 回退默认", wild.sightsPerDay.balanced[0] === 3 && wild.sightsPerDay.balanced[1] === 5);
ok("非法 mealWindow 回退", wild.mealWindow.lunch[0] === 11 * 60);
ok("NaN farCap 回退默认", wild.farOneWayCapByDays.twoOrLess === 65);
ok("超大 farLimitKm 收敛", wild.farLimitKm <= 200);
ok("非布尔 restEachDay 不当 true", wild.restEachDay === false);

console.log("\n3) 传参数后行为真的变");
const relaxed = sanitizeParams({
  maxLegMin: 180,
  maxDaySpanKm: 80,
  farLimitKm: 150,
  farOneWayCapByDays: { twoOrLess: 200, three: 240, longer: 300 },
});
ok("farOneWayCap 可放大到 200", farOneWayCap(2, relaxed) === 200);
ok("farLimitKm 可放大到 150", farLimitKm([], relaxed) === 150);
ok("span 参数生效", relaxed.maxDaySpanKm === 80);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：默认值零回归 + 乱值收敛 + 参数生效");
