/**
 * 锚点挑选回归检查（npx tsx scripts/check-anchors.ts）。
 *
 * 背景（一条真踩过的坑）：傍晚型点位（日落台/夜市/窗口全在 13 点后的街区）
 * 原来可以当某一天的主景，而锚点是一天一个。于是那天最早的可用时段就是 16:00，
 * 排程只能把出发时间推到下午——真实厦门 2 天排线出现过
 * 「D2 14:30–22:12，只有 3 站，上午整块空着」。
 *
 * 修法：白天的点够分这几天时，傍晚型退回「顺路收尾」，不占锚点。
 *
 * 这里守的是那条修法的**兜底分支**：海边小城全城只有日落点，
 * 不能因为「傍晚型不当锚点」就连一天都排不出来。
 * （「傍晚不再独占一天」这个效果本身没法在这一层断言：selectDays 不暴露
 *  结构锚点，而傍晚型和白天型最后都会进同一天，集合相同、只有出发时刻不同。
 *   它是端到端验证的：真实候选池 143 个点位，14:30 起步的半天日程已消失。）
 */
import { selectDays } from "../src/lib/plan/select";
import { rhythmOf } from "../src/lib/plan/rhythm/profile";
import type { Place } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(over: Partial<Place> & { id: string; name: string }): Place {
  return {
    category: "attraction",
    lat: 24.48,
    lng: 118.09,
    source: "demo",
    city: "厦门",
    ...over,
  };
}

const hotel: Place = place({ id: "hotel", name: "市中心", category: "hotel" });

console.log("1) 全城只有傍晚点位时，仍然排得出来");
// 海边小城的真实形态：能看的只有日落和海滨夜市。这时候必须允许傍晚点当主景。
const eveningOnlyPool: Place[] = [
  place({ id: "e1", name: "西湾日落台", category: "street", popularity: 4.7, lat: 24.53, lng: 118.14 }),
  place({ id: "e2", name: "东岸夜市街", category: "street", popularity: 4.6, lat: 24.44, lng: 118.05 }),
];
const first = rhythmOf("厦门", eveningOnlyPool[0]);
ok(
  "夹具确实是「傍晚才有窗口」",
  first.windows.length > 0 && Math.min(...first.windows.map(([s]) => s)) >= 12 * 60 + 30,
  first.windows.map(([a, b]) => `${a}-${b}`).join(" "),
);

const fallback = selectDays({
  sights: eveningOnlyPool,
  hotel,
  days: 2,
  pace: "balanced",
  styles: ["citywalk"],
  seed: 42,
  radiusKm: 30,
  transport: "auto",
  city: "厦门",
});
ok(
  "没有白天点位也照样给出每天的主景，而不是空行程",
  fallback.days.length === 2 && fallback.days.every((day) => day.places.length > 0),
  fallback.days.map((day) => day.places.map((p) => p.name).join("/")).join(" | "),
);
ok(
  "两个傍晚点位都被用上（没有为了凑白天内容把它们丢掉）",
  ["西湾日落台", "东岸夜市街"].every((name) =>
    fallback.days.some((day) => day.places.some((p) => p.name === name)),
  ),
  fallback.days.map((day) => day.places.map((p) => p.name).join("/")).join(" | "),
);

console.log("\n2) 白天点位够用时，傍晚型不会把白天点位挤出局");
const mixedPool: Place[] = [
  place({ id: "a-street", name: "滨海观景街", category: "street", popularity: 4.8, lat: 24.53, lng: 118.14 }),
  place({ id: "a-museum", name: "老城博物馆", category: "museum", popularity: 4.5, rating: 4.7, lat: 24.535, lng: 118.145 }),
  place({ id: "b-street", name: "江畔夜市街", category: "street", popularity: 4.8, lat: 24.44, lng: 118.05 }),
  place({ id: "b-park", name: "城西公园", category: "park", popularity: 4.5, rating: 4.7, lat: 24.445, lng: 118.055 }),
];
const mixed = selectDays({
  sights: mixedPool,
  hotel,
  days: 2,
  pace: "balanced",
  styles: ["citywalk"],
  seed: 42,
  radiusKm: 30,
  transport: "auto",
  city: "厦门",
});
ok(
  "两个片区都排出来了，白天点位一个没丢",
  mixed.days.length === 2 &&
    ["老城博物馆", "城西公园"].every((name) =>
      mixed.days.some((day) => day.places.some((p) => p.name === name)),
    ),
  mixed.days.map((day) => day.places.map((p) => p.name).join("/")).join(" | "),
);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：只有日落时仍可排 + 白天点位不被挤出局");
