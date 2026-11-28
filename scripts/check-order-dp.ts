/**
 * 带时间窗排序回归检查（npx tsx scripts/check-order-dp.ts）。
 *
 * 这套断言直接针对「日落被排到天黑」这个老毛病：
 * 只要是排序的问题，就该在排序这一层被抓出来，而不是靠事后剔除来掩盖。
 */
import { XIAMEN_SIGHTS, DEMO_HOTELS } from "../src/content/demo-xiamen";
import { composeDay } from "../src/lib/plan/rhythm/compose";
import type { RhythmProfile } from "../src/lib/plan/rhythm/profile";
import {
  DP_MAX_STOPS,
  orderWithTimeWindows,
  type DpStop,
} from "../src/lib/plan/rhythm/order-dp";
import type { Place } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

const hotel: Place = {
  id: "hotel",
  name: "测试酒店",
  category: "hotel",
  lat: 24.4798,
  lng: 118.0894,
  source: "demo",
  city: "厦门",
};

function profile(over: Partial<RhythmProfile> = {}): RhythmProfile {
  return {
    bands: [],
    avoid: [],
    windows: [[9 * 60, 17 * 60]],
    sunrise: false,
    sunset: false,
    quickStop: false,
    heroEligible: true,
    indoor: false,
    marketMorning: false,
    morningOnly: false,
    nightStreet: false,
    earlyBoat: false,
    booking: false,
    gateway: false,
    closingScore: 50,
    durationMin: 90,
    longStay: false,
    ...over,
  };
}

function stop(
  id: string,
  category: Place["category"],
  prof: Partial<RhythmProfile>,
  over: Partial<Place> = {},
): DpStop {
  const place: Place = {
    id,
    name: id,
    category,
    lat: 24.48 + Number(over.popularity ?? 0) * 0.001,
    lng: 118.09,
    source: "demo",
    city: "厦门",
    ...over,
  };
  return {
    place,
    profile: profile(prof),
    dwellMin: over.tags?.length ? 60 : 90,
    crowd: { peak: [], valley: [], factor: 1, source: "heuristic" },
    energy: category === "nature" ? -18 : -8,
  };
}

const base = {
  hotel,
  startMin: 9 * 60,
  city: "厦门",
  pace: "balanced" as const,
  styles: ["citywalk" as const],
  transport: "auto" as const,
  dayIndex: 1,
};

console.log("1) 边界：0/1/超上限");
ok("空列表返回空", orderWithTimeWindows({ ...base, stops: [] }).order.length === 0);
const one = [stop("only", "museum", {})];
const oneResult = orderWithTimeWindows({ ...base, stops: one });
ok("单点原样返回", oneResult.order.length === 1 && oneResult.order[0].place.id === "only");
const many = Array.from({ length: DP_MAX_STOPS + 1 }, (_, index) =>
  stop(`p${index}`, "museum", {}),
);
const manyResult = orderWithTimeWindows({ ...base, stops: many });
ok(
  "超过 DP 上限时不乱序（交给上游兜底）",
  manyResult.order.map((item) => item.place.id).join(",") === many.map((item) => item.place.id).join(","),
);

console.log("\n2) 日落点不再被挤到天黑");
const sunset = stop("sunset", "viewpoint", {
  sunset: true,
  windows: [[16 * 60 + 30, 18 * 60 + 30]],
  closingScore: 90,
});
const museum = stop("museum", "museum", { windows: [[9 * 60, 12 * 60]] });
const street = stop("street", "street", { windows: [[11 * 60, 17 * 60]] });
const scrambled = orderWithTimeWindows({
  ...base,
  stops: [sunset, museum, street],
});
const ids = scrambled.order.map((item) => item.place.id);
ok("日落排在最后", ids[ids.length - 1] === "sunset", ids.join(" → "));
ok("顺序是原集合的一个排列", new Set(ids).size === 3);

console.log("\n3) 早市与「上午限定」被推到前面");
const market = stop("market", "market", {
  marketMorning: true,
  windows: [[7 * 60, 9 * 60]],
});
const afternoon = stop("afternoon", "street", { windows: [[13 * 60, 18 * 60]] });
const marketFirst = orderWithTimeWindows({
  ...base,
  startMin: 7 * 60 + 30,
  stops: [afternoon, market],
});
ok(
  "早市排第一",
  marketFirst.order[0].place.id === "market",
  marketFirst.order.map((item) => item.place.id).join(" → "),
);

console.log("\n4) 确定性 + 不重不漏");
const again = orderWithTimeWindows({ ...base, stops: [sunset, museum, street] });
ok(
  "同样输入两次结果一致",
  again.order.map((item) => item.place.id).join(",") === ids.join(","),
);
const five = [
  stop("a", "museum", { windows: [[9 * 60, 12 * 60]] }),
  stop("b", "street", { windows: [[11 * 60, 17 * 60]] }),
  stop("c", "park", { windows: [[8 * 60, 18 * 60]] }),
  stop("d", "viewpoint", { sunset: true, windows: [[16 * 60, 18 * 60]] }),
  stop("e", "temple", { windows: [[7 * 60, 11 * 60]], morningOnly: true }),
];
const fiveResult = orderWithTimeWindows({ ...base, stops: five });
ok("五个点一个不少", fiveResult.order.length === 5);
ok(
  "没有重复",
  new Set(fiveResult.order.map((item) => item.place.id)).size === 5,
);
ok("有等待时等待时间不为负", fiveResult.waitMin >= 0);

console.log("\n5) 接进 composeDay 仍然成立");
const picks = XIAMEN_SIGHTS.slice(0, 4);
const composed = composeDay({
  places: picks,
  hotel: DEMO_HOTELS[0],
  city: "厦门",
  pace: "balanced",
  styles: ["citywalk"],
  transport: "auto",
  dayIndex: 2,
  seed: 42,
});
ok("composeDay 不丢点", composed.places.length === picks.length);
ok(
  "composeDay 输出是一组不重复的点位",
  new Set(composed.places.map((place) => place.id)).size === picks.length,
);
ok("起点时间落在合理区间", Boolean(composed.startMinHint), String(composed.startMinHint));

console.log("\n6) DP 接管后，结构性规则仍然成立");
// DP 只优化代价，不知道「夜市必须收尾」「日出必须首站」。
// 这几条原来由 beam search 的 hardPenalty 把住，换成 DP 之后靠
// compose.ts 的 structurallySane 复核，不合法就退回启发式。
// 这里用真实点位守住结果，防止哪天护栏被删了还没人发现。
const byName = (name: string) => {
  const found = XIAMEN_SIGHTS.find((place) => place.name === name);
  if (!found) throw new Error(`演示数据里找不到 ${name}`);
  return found;
};
const structural = composeDay({
  places: [
    byName("中山路步行街"),
    byName("黄厝海滩"),
    byName("白城沙滩"),
    byName("华侨博物院"),
  ],
  hotel: DEMO_HOTELS[0],
  city: "厦门",
  pace: "balanced",
  styles: ["citywalk"],
  transport: "auto",
  dayIndex: 2,
  seed: 42,
});
const structuralIds = structural.places.map((place) => place.id);
const structuralNames = structural.places.map((place) => place.name);
ok(
  "夜市排在最后",
  structuralNames[structuralNames.length - 1] === "中山路步行街",
  structuralNames.join(" → "),
);
ok(
  "日出点排在第一",
  structuralNames[0] === "黄厝海滩",
  structuralNames.join(" → "),
);
const sunsetIndex = structuralNames.indexOf("白城沙滩");
ok(
  "日落点落在末两位",
  sunsetIndex >= structuralNames.length - 2,
  `${sunsetIndex} / ${structuralNames.length}`,
);
ok("结构检查没丢点", structuralIds.length === 4, structuralNames.join(" → "));

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：边界 + 日落归位 + 早市前置 + 确定性 + 集成");
