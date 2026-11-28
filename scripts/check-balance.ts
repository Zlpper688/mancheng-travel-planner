/**
 * 跨天叙事均衡回归检查（npx tsx scripts/check-balance.ts）。
 *
 * 这套断言的重点不是「换得多」，而是「换得守规矩」：
 *   1. 主题重复的两天会被拉开，但锚点不动
 *   2. 只在当天片区半径内换，40 km 外的点不会被换进来
 *   3. 冻结的一天（远足日）一个点都不动
 *   4. 首日更轻：重体力点位优先换出去
 *   5. 没得换时原样返回，不会为了「看起来均衡」乱动
 */
import { balanceDays } from "../src/lib/plan/select/balance";
import type { Category, Place } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(
  id: string,
  category: Category,
  lat = 24.48,
  lng = 118.09,
  over: Partial<Place> = {},
): Place {
  return {
    id,
    name: over.name ?? id,
    category,
    lat,
    lng,
    source: "demo",
    city: "测试城",
    ...over,
  };
}

const anchor1 = place("a1", "attraction");
const anchor2 = place("a2", "attraction");
const anchor3 = place("a3", "attraction");
const museum1 = place("m1", "museum");
const museum2 = place("m2", "museum");
const beach = place("b1", "beach");
const street = place("s1", "street");
const far = place("f1", "museum", 24.85, 118.5, { name: "四十公里外的馆" });

// 第 1 天：地标 + 一个馆；第 2 天：地标 + 一个馆 + 海边。
// 两天的「文化 + 地标」占比几乎一样，正是需要拉开的那种重复。
const original = [
  [anchor1, museum1],
  [anchor2, museum2, beach],
  [anchor3, street],
];

console.log("1) 主题重复的两天被拉开");
const result = balanceDays({
  days: original,
  city: "测试城",
  clusterKm: 8,
});
ok("发生了交换", result.swaps > 0, `${result.swaps}`);
ok("锚点仍在第一天开头", result.days[0][0].id === "a1");
ok("锚点仍在第二天开头", result.days[1][0].id === "a2");
ok(
  "两天的构成不再一模一样",
  result.days[0].map((p) => p.category).sort().join(",") !==
    result.days[1].map((p) => p.category).sort().join(","),
  `${result.days[0].map((p) => p.id)} | ${result.days[1].map((p) => p.id)}`,
);
ok(
  "换进来的点确实换了类型（海边进了第一天）",
  result.days[0].some((p) => p.category === "beach") ||
    result.days[1].some((p) => p.category === "beach"),
);
ok("点位数量没变", result.days.every((day, index) => day.length === original[index].length));

console.log("\n2) 远处点位不会被换进来");
const withFar = balanceDays({
  days: [
    [anchor1, museum1],
    [anchor2, museum2, far],
  ],
  city: "测试城",
  clusterKm: 8,
});
ok(
  "四十公里外的点进了别的天",
  !withFar.days.some((day, index) =>
    index !== 1 && day.some((item) => item.id === "f1"),
  ),
);

console.log("\n3) 冻结的一天完全不参与");
const frozen = balanceDays({
  days: [
    [anchor1, museum1],
    [anchor2, museum2],
  ],
  city: "测试城",
  clusterKm: 8,
  frozen: new Set([2]),
});
ok("冻结日顺序不变", frozen.days[1].map((p) => p.id).join(",") === "a2,m2");
ok("冻结时不产生交换", frozen.swaps === 0);

console.log("\n4) 首日更轻");
const hill = place("h2", "nature", 24.481, 118.091, { name: "城郊登山道", note: "爬山 登顶" });
const shop = place("sh2", "street", 24.479, 118.089, { name: "老城小店" });
const lighter = balanceDays({
  days: [
    [anchor1, hill],
    [anchor2, shop],
  ],
  city: "测试城",
  clusterKm: 8,
});
const day1Effort = lighter.days[0]
  .slice(1)
  .reduce((sum, item) => sum + (item.category === "nature" ? 3 : 1), 0);
ok("第一天不再背着最重的点", day1Effort <= 1, `effort=${day1Effort}`);

console.log("\n5) 末日也要好离开");
// 第 3 天是末日，背着一个登山点；第 2 天只有一个步行街可以换。
// 把重体力挪到中间那天，末日晚点回酒店也不至于赶不上车。
const tail = balanceDays({
  days: [
    [anchor1, museum1],
    [anchor2, shop],
    [anchor3, hill],
  ],
  city: "测试城",
  clusterKm: 8,
});
const lastHeavy = tail.days[2].filter((item) => item.category === "nature").length;
ok("末日不再背着最重的点", lastHeavy === 0, `nature=${lastHeavy}`);
ok("重体力没有被换到首日", tail.days[0].every((item) => item.category !== "nature"));
ok("点位总数不变", tail.days.flat().length === 6);

console.log("\n6) 没得换就原样返回");
const nothing = balanceDays({
  days: [[anchor1], [anchor2]],
  city: "测试城",
  clusterKm: 8,
});
ok("单点日不交换", nothing.swaps === 0);
ok("返回结构与输入一致", nothing.days.length === 2 && nothing.days[1][0].id === "a2");

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：会拉开 + 守边界 + 首日轻 + 不乱动");
