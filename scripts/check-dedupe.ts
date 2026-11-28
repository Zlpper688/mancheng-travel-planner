/**
 * 跨天重复点位回归（npx tsx scripts/check-dedupe.ts）。
 *
 * 背景：实测厦门 3 天里排出了两次厦大、两次沙坡尾，而体检一声没吭。
 * 根因是判重用 id，而同一处景点在 OSM / 维基 / 本地知识库里 id 与名字后缀都不同。
 * 这个脚本锁住三件事：
 *   1. 同名的「厦门大学」与「厦门大学（思明校区）」在 2 km 内会被合并
 *   2. 同名的餐饮不参与合并（连锁店本来就该各算各的）
 *   3. 体检能按「去括号的名字」把跨天重复抓出来
 */
import { dedupePlaces, cleanNameForMatch } from "../src/lib/providers/normalize";
import { mergeLocalKnowledge } from "../src/lib/providers/knowledge";
import { findCrossDayRepeats } from "../src/lib/plan/audit";
import type { Place } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(partial: Partial<Place> & { name: string; lat: number; lng: number }): Place {
  return {
    id: `p-${partial.name}-${partial.lat}`,
    category: "attraction",
    source: "demo",
    ...partial,
  };
}

console.log("1) 同名景点在 2 km 内合并");
const xmuA = place({ id: "demo-xm-xmu", name: "厦门大学", lat: 24.4399, lng: 118.093 });
const xmuB = place({
  id: "knowledge-厦门-厦门大学",
  name: "厦门大学（思明校区）",
  lat: 24.436,
  lng: 118.1027,
});
ok("归一化后同名", cleanNameForMatch(xmuA.name) === cleanNameForMatch(xmuB.name));
const mergedSights = dedupePlaces([xmuA, xmuB]);
ok("只留一个", mergedSights.length === 1, `实际 ${mergedSights.length}`);

console.log("\n2) 同名餐饮不合并");
const cafeA = place({ id: "c1", name: "沙坡尾咖啡", category: "cafe", lat: 24.4399, lng: 118.0829 });
const cafeB = place({ id: "c2", name: "沙坡尾咖啡", category: "cafe", lat: 24.445, lng: 118.088 });
ok("两家分店都保留", dedupePlaces([cafeA, cafeB]).length === 2);

console.log("\n3) 知识库并入时不再重复");
const merged = mergeLocalKnowledge([xmuA], [xmuB]);
ok("并入 0 条", merged.added === 0, `实际 ${merged.added}`);
ok("没有出现两条厦大", merged.places.length === 1);
const mergedOther = mergeLocalKnowledge([xmuA], [place({ name: "鼓浪屿", lat: 24.447, lng: 118.067 })]);
ok("不同景点仍会并入", mergedOther.added === 1);

console.log("\n4) 跨天重复能被抓出来");
const day2 = {
  index: 2,
  stops: [{ kind: "sight" as const, place: xmuB }],
};
const day3 = {
  index: 3,
  stops: [{ kind: "sight" as const, place: xmuA }],
};
const repeats = findCrossDayRepeats([day2, day3] as never);
ok("抓到 1 条", repeats.length === 1, `实际 ${repeats.length}`);
ok("天数正确", repeats[0]?.days.join(",") === "2,3", JSON.stringify(repeats[0]?.days));

console.log("\n5) 单次到访不误报");
const single = findCrossDayRepeats([
  { index: 1, stops: [{ kind: "sight" as const, place: xmuA }] },
  { index: 2, stops: [{ kind: "sight" as const, place: place({ name: "鼓浪屿", lat: 24.447, lng: 118.067 }) }] },
] as never);
ok("没有重复", single.length === 0, JSON.stringify(single));

console.log("\n6) 名字不同但几乎同点也能抓到");
const repeatsNear = findCrossDayRepeats([
  { index: 1, stops: [{ kind: "sight" as const, place: place({ name: "厦门大学东门", lat: 24.4399, lng: 118.093 }) }] },
  { index: 2, stops: [{ kind: "sight" as const, place: place({ name: "厦门大学", lat: 24.4403, lng: 118.0934 }) }] },
] as never);
ok("按 150m 兜底命中", repeatsNear.length === 1, `实际 ${repeatsNear.length}`);

console.log("\n7) 餐饮跨天不算重复景点");
const foodRepeat = findCrossDayRepeats([
  { index: 1, stops: [{ kind: "meal" as const, place: cafeA }] },
  { index: 2, stops: [{ kind: "meal" as const, place: cafeA }] },
] as never);
ok("只统计 sight", foodRepeat.length === 0);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：同名景点合并 + 餐饮不合并 + 知识库去重 + 跨天重复检测 + 不误报");
