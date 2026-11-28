/**
 * 跨天去重回归检查（npx tsx scripts/check-crossday.ts）。
 *
 * 背景：厦门实测把「鼓浪屿万国建筑群」排进了第 1 天，第 2 天又是「鼓浪屿」，
 * 同一座岛买两趟轮渡。audit 只会在事后提醒，这里要求在选点阶段就换掉。
 *
 * 断言的重点是「换得守规矩」，不是「换得多」：
 *   1. 名字互相包含就算同一片（高德 POI 没有 island 字段，只能靠名字）
 *   2. 名字短的是上位：去掉的是「万国建筑群」，不是「鼓浪屿」
 *   3. 同一天里的重复不归这里管，不该被误删
 *   4. 远足日整组不动
 *   5. 一天只剩一个点时不碰，宁可留重复也不把那天清空
 *   6. 补位点不能落进别的天已经占住的片区
 */
import { dedupeAcrossDays } from "../src/lib/plan/select/crossday";
import type { ScoredPlace } from "../src/lib/plan/select/shared";
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
  name: string,
  category: Category,
  lat: number,
  lng: number,
  over: Partial<Place> = {},
): Place {
  return {
    id,
    name,
    category,
    lat,
    lng,
    source: "demo",
    city: "测试城",
    ...over,
  };
}

const gulangyu = place("g", "鼓浪屿", "attraction", 24.4472, 118.0619, {
  popularity: 5,
});
const villas = place(
  "v",
  "鼓浪屿万国建筑群（万国建筑博物馆·三一堂）",
  "attraction",
  24.4455,
  118.0665,
  { popularity: 4.7 },
);
const xmu = place("x", "厦门大学", "attraction", 24.4365, 118.0955, {
  popularity: 4.9,
});
const nanputuo = place("n", "南普陀寺", "temple", 24.4415, 118.0895, {
  popularity: 4.8,
});
const huli = place("h", "胡里山炮台", "attraction", 24.4305, 118.0785, {
  popularity: 4.6,
});
const zhongshan = place("z", "中山路步行街", "street", 24.4565, 118.0795, {
  popularity: 4.8,
});

function scored(place: Place, score = 8): ScoredPlace {
  return { place, score, distance: 12 };
}
const pool = [gulangyu, villas, xmu, nanputuo, huli, zhongshan].map((p) =>
  scored(p),
);

console.log("1) 同一片被拆到两天：去掉更具体的那个");
const r1 = dedupeAcrossDays({
  days: [
    { day: 1, places: [villas, xmu], frozen: false },
    { day: 2, places: [gulangyu, zhongshan], frozen: false },
  ],
  scored: pool,
  clusterKm: 6,
});
const d1 = r1.days.get(1) ?? [];
const d2 = r1.days.get(2) ?? [];
ok(
  "第 1 天不再有「鼓浪屿万国建筑群」",
  !d1.some((p) => p.id === "v"),
  d1.map((p) => p.name).join(" / "),
);
ok(
  "第 2 天的「鼓浪屿」留着（名字短的是上位）",
  d2.some((p) => p.id === "g"),
  d2.map((p) => p.name).join(" / "),
);
ok("换进来的是鼓浪屿之外的点位", d1.every((p) => p.id !== "g"));
ok("记了一条改动", r1.changes.length === 1, JSON.stringify(r1.changes));

console.log("\n2) 同一天里的重复不归这里管");
const r2 = dedupeAcrossDays({
  days: [
    { day: 1, places: [xmu, xmu], frozen: false },
    { day: 2, places: [zhongshan], frozen: false },
  ],
  scored: pool,
  clusterKm: 6,
});
ok("原样返回", (r2.days.get(1) ?? []).length === 2);
ok("没有改动记录", r2.changes.length === 0);

console.log("\n3) 远足日整组不动");
const r3 = dedupeAcrossDays({
  days: [
    { day: 1, places: [villas, xmu], frozen: false },
    { day: 2, places: [gulangyu, zhongshan], frozen: true },
  ],
  scored: pool,
  clusterKm: 6,
});
ok(
  "冻结那天仍然完整",
  (r3.days.get(2) ?? []).length === 2,
  (r3.days.get(2) ?? []).map((p) => p.name).join(" / "),
);

console.log("\n4) 只剩一个点的那天不清空");
const r4 = dedupeAcrossDays({
  days: [
    { day: 1, places: [gulangyu], frozen: false },
    { day: 2, places: [villas], frozen: false },
  ],
  scored: pool,
  clusterKm: 6,
});
const kept = (r4.days.get(2) ?? []).length + (r4.days.get(1) ?? []).length;
ok("两天都还有点", kept >= 2, `共 ${kept} 个`);

console.log("\n5) 补位点不落进别的天已经占住的片区");
const r5 = dedupeAcrossDays({
  days: [
    { day: 1, places: [villas, xmu], frozen: false },
    { day: 2, places: [gulangyu, zhongshan], frozen: false },
  ],
  // 候补池里塞一个就在鼓浪屿上的点，不该被当作第 1 天的补位
  scored: [...pool, scored(place("k", "皓月园", "attraction", 24.4432, 118.0702))],
  clusterKm: 6,
});
const day1Names = (r5.days.get(1) ?? []).map((p) => p.name);
ok("没有把皓月园补进第 1 天", !day1Names.includes("皓月园"), day1Names.join(" / "));

console.log(
  failed === 0
    ? "\n通过：名字包含、上位优先、冻结保护、不清空、片区约束都对"
    : `\n失败 ${failed} 项`,
);
process.exit(failed === 0 ? 0 : 1);
