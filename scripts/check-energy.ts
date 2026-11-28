/**
 * 能量模型回归检查（npx tsx scripts/check-energy.ts）。
 *
 * 不追求「算得准」——没有真值可标定；只锁住四条方向性事实：
 *   1. 晚出发 / 后几天 / 带小孩，起点体力更低
 *   2. 爬山比逛馆更耗电，咖啡与餐饮是恢复点
 *   3. 体力低时重体力点位才降时长，正常时段一秒都不动
 *   4. 一天的曲线是单调下降的（除餐饮/茶歇），且不会掉到 0
 */
import {
  applyEnergy,
  baseCostOf,
  effortOf,
  energyDelta,
  energyDwellScale,
  energyNote,
  energyPenalty,
  initialEnergy,
  summarizeEnergy,
  timeDrain,
} from "../src/lib/plan/energy";
import type { Category, Place } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(id: string, name: string, category: Category, over: Partial<Place> = {}): Place {
  return {
    id,
    name,
    category,
    lat: 24.45,
    lng: 118.09,
    source: "demo",
    city: "厦门",
    ...over,
  };
}

const museum = place("m1", "市博物馆", "museum");
const hill = place("h1", "五老峰登山步道", "nature", { note: "爬山 登顶 石阶" });
const street = place("s1", "老城步行街", "street");
const cafe = place("c1", "街角咖啡馆", "cafe");
const lunch = place("l1", "本地小吃店", "food");
const big = place("a1", "植物园", "attraction", { note: "半天" });

console.log("1) 起点体力：首日晚到、后几天、带小孩都更低");
const early = initialEnergy({ startMin: 8 * 60 + 30, dayIndex: 1, pace: "balanced" });
const late = initialEnergy({ startMin: 14 * 60, dayIndex: 1, pace: "balanced" });
const day3 = initialEnergy({ startMin: 8 * 60 + 30, dayIndex: 3, pace: "balanced" });
const withKid = initialEnergy({
  startMin: 8 * 60 + 30,
  dayIndex: 1,
  pace: "balanced",
  children: 1,
});
ok("首日 14 点出门比 8:30 出门起点低", late < early, `${late} < ${early}`);
// 下午两点到达 ≈ 55：这是方案里定的锚点，不是拍脑袋。
ok("首日 14:00 到达，起点约 55", Math.abs(late - 55) <= 2, `${late}`);
ok("第 3 天起点比第 1 天低", day3 < early, `${day3} < ${early}`);
ok("带一个小孩起点更低", withKid < early, `${withKid} < ${early}`);
// 后面几天出发晚是排线自己安排的（把日落那天上午空出来），不是「路上累过」。
// 不加 dayIndex 判断就会把这种日子误判成体力见底——真实排线里踩到过。
const day2Late = initialEnergy({ startMin: 14 * 60 + 30, dayIndex: 2, pace: "balanced" });
const day2Early = initialEnergy({ startMin: 8 * 60 + 30, dayIndex: 2, pace: "balanced" });
ok(
  "第 2 天 14:30 出门不再被当成「累了一上午」",
  day2Late === day2Early,
  `${day2Late} vs ${day2Early}`,
);
const floor = initialEnergy({ startMin: 20 * 60, dayIndex: 10, pace: "packed", seniors: 3, children: 2 });
ok("再糟也不会低于 35（否则所有点都被判「走不动」）", floor >= 35, `${floor}`);
ok("满格不超过 100", early <= 100);

console.log("\n2) 消耗与恢复的方向");
ok("爬山属于重体力", effortOf(hill, "厦门") === "hard");
ok("博物馆属于轻体力", effortOf(museum, "厦门") === "light");
ok("咖啡馆是恢复点", effortOf(cafe, "厦门") === "restore");
ok("爬山扣得比逛馆多", energyDelta(hill, "厦门", 120) < energyDelta(museum, "厦门", 120));
ok("咖啡为正", energyDelta(cafe, "厦门", 40) > 0);
ok("正餐恢复更多", energyDelta(lunch, "厦门", 60) > energyDelta(cafe, "厦门", 40));
ok("大景区停留久，扣得更多", energyDelta(big, "厦门", 240) < energyDelta(big, "厦门", 60));

console.log("\n2b) 定下来的能量表逐项对齐");
// 这张表是产品定义，不是调参空间：改这里必须有理由。
ok("爬山 -18", baseCostOf(hill, "厦门", "core") === -18, `${baseCostOf(hill, "厦门", "core")}`);
ok("大景区 -10", baseCostOf(big, "厦门") === -10, `${baseCostOf(big, "厦门")}`);
ok("博物馆 -6", baseCostOf(museum, "厦门") === -6, `${baseCostOf(museum, "厦门")}`);
ok("步行街 -4", baseCostOf(street, "厦门") === -4, `${baseCostOf(street, "厦门")}`);
ok("咖啡馆 +8", baseCostOf(cafe, "厦门") === 8, `${baseCostOf(cafe, "厦门")}`);
ok(
  "午休 +12（固定值，不按分钟折算）",
  energyDelta(lunch, "厦门", 40, null, "lunch") === 12 &&
    energyDelta(lunch, "厦门", 90, null, "lunch") === 12,
  `${energyDelta(lunch, "厦门", 40, null, "lunch")}`,
);
ok(
  "午休比随手一杯咖啡恢复得多",
  energyDelta(lunch, "厦门", 60, null, "lunch") >
    energyDelta(cafe, "厦门", 60, null, "cafe"),
);

console.log("\n3) 只有体力低时才动时长");
ok("满电时不缩短", energyDwellScale(90, hill, "厦门") === 1);
ok("体力 40 时爬山收 15%", energyDwellScale(40, hill, "厦门") === 0.85);
ok("体力 40 时逛馆不收", energyDwellScale(40, museum, "厦门") === 1);
ok("低体力逛馆不给解释（没必要吓人）", energyNote(40, museum, "厦门") === null);
ok("低体力爬山会解释", Boolean(energyNote(30, hill, "厦门")));

console.log("\n4) 排序代价：体力不够才罚");
ok("满电排爬山不罚", energyPenalty(100, hill, "厦门") === 0);
ok("半电排爬山要罚", energyPenalty(45, hill, "厦门") > 0);
ok("半电排逛馆罚得更轻", energyPenalty(45, museum, "厦门") < energyPenalty(45, hill, "厦门"));
ok("轻点位不罚", energyPenalty(20, street, "厦门") === 0);

console.log("\n5) 全天曲线");
let energy = initialEnergy({ startMin: 9 * 60, dayIndex: 1, pace: "balanced" });
const seq = [
  { place: hill, dwellMin: 120 },
  { place: lunch, dwellMin: 60 },
  { place: museum, dwellMin: 90 },
  { place: cafe, dwellMin: 40 },
  { place: street, dwellMin: 60 },
];
const flow = summarizeEnergy(seq, energy, "厦门");
ok("出门值等于传入值", flow.start === energy);
ok("一天走完必然下降", flow.end < flow.start, `${flow.start} → ${flow.end}`);
ok("最低点不会负", flow.low >= 0);
ok("最低点出现在某个点位之后", Boolean(flow.lowPlaceId));
const clamped = applyEnergy(5, hill, "厦门", 180);
ok("能量被夹在 0 以上", clamped >= 0);
const full = applyEnergy(95, cafe, "厦门", 120);
ok("最多补回 100", full <= 100);

console.log("\n5b) 在路上的时间也在消耗");
ok("在外面待三小时要扣分", timeDrain(9 * 60, 12 * 60) >= 4, `${timeDrain(9 * 60, 12 * 60).toFixed(1)}`);
ok("时间没走就不扣", timeDrain(9 * 60, 9 * 60) === 0);
const withGap = summarizeEnergy(
  [
    { place: hill, dwellMin: 60, startMin: 9 * 60, endMin: 10 * 60 },
    { place: street, dwellMin: 60, startMin: 14 * 60, endMin: 15 * 60 },
  ],
  100,
  "厦门",
  8 * 60,
);
const noGap = summarizeEnergy(
  [
    { place: hill, dwellMin: 60, startMin: 9 * 60, endMin: 10 * 60 },
    { place: street, dwellMin: 60, startMin: 10 * 60, endMin: 11 * 60 },
  ],
  100,
  "厦门",
  8 * 60,
);
ok(
  "同样的点位，中间空档越长越累",
  withGap.end < noGap.end,
  `${withGap.end} < ${noGap.end}`,
);
ok(
  "只算停留不算路上，会高估剩余体力",
  summarizeEnergy(
    [{ place: hill, dwellMin: 60 }, { place: street, dwellMin: 60 }],
    100,
    "厦门",
  ).end > withGap.end,
);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：起点/消耗/时长/代价/曲线五组方向都对");
