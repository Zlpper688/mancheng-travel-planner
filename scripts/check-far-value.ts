/**
 * 远足日价值门槛回归检查（npx tsx scripts/check-far-value.ts）。
 *
 * 背景：厦门原本会把「香山郊野公园 + 宋江文化广场」排成一个远足日，
 * 换来 85.9 km、路上 3 小时 53 分。两个点位都不算差，但也不值得跑这么远。
 * 现在用「分量 ÷ 单程小时」量一遍，主城越够玩，门槛越高。
 *
 * 断言的重点：
 *   1. 分量随「旗舰 / 名气 / 大室外 / 评分」上升，且第二个点边际递减
 *   2. 单程越久，同样的点位越不值
 *   3. 三档门槛的顺序（富城 > 一般 > 稀疏），并且稀疏城市不会被误杀
 *   4. 区域环线的必去点（带 reachMin）不受门槛约束
 */
import {
  farDayValue,
  farDayWorthGoing,
  farValueFloor,
  farGroupWeight,
} from "../src/lib/plan/select/far";
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
  over: Partial<Place> = {},
): Place {
  return {
    id,
    name,
    category,
    lat: 24.48,
    lng: 118.09,
    source: "demo",
    city: "测试城",
    ...over,
  };
}

function scored(place: Place, score = 8): ScoredPlace {
  return { place, score, distance: 20 };
}

// 郊野公园：评分不低，但只是「大室外 + 评分」两项，不是旗舰也不是人人知道。
const park = place("p1", "香山郊野公园", "park", { popularity: 4.6 });
// 广场：只有评分，分量最轻。
const plaza = place("p2", "宋江文化广场", "attraction", { popularity: 4.1 });
// 真旗舰：名录级的山（名字带「风景名胜」，评分也够），四项齐全。
const flagship = place("f1", "黄山国家风景名胜区", "nature", {
  popularity: 5,
  rating: 4.8,
  cost: 190,
});
// 区域环线的必去点。
const region = place("r1", "喀纳斯", "nature", {
  popularity: 5,
  reachMin: 240,
});

console.log("1) 分量：占的项越多越重，第二个点边际递减");
ok("广场最轻", farGroupWeight([scored(plaza)]) < farGroupWeight([scored(park)]));
ok(
  "旗舰最重",
  farGroupWeight([scored(flagship)]) > farGroupWeight([scored(park)]),
);
ok(
  "两点组小于两点独立相加",
  farGroupWeight([scored(park), scored(plaza)]) <
    farGroupWeight([scored(park)]) + farGroupWeight([scored(plaza)]),
  "第二个点不该和主景同权",
);
ok(
  "顺序不影响总分量",
  Math.abs(
    farGroupWeight([scored(park), scored(plaza)]) -
      farGroupWeight([scored(plaza), scored(park)]),
  ) < 1e-9,
);

console.log("\n2) 单程越久越不值");
const near = farDayValue([scored(park), scored(plaza)], 40);
const far = farDayValue([scored(park), scored(plaza)], 100);
ok("分量本身不随路程变", Math.abs(near.weight - far.weight) < 1e-9);
ok("路程翻倍，价值腰斩一半左右", far.value < near.value / 2 + 0.5);
ok("单程极短不会算出无穷大", farDayValue([scored(plaza)], 3).value < 20);

console.log("\n3) 门槛三档：富城最严，稀疏城市最松");
const rich = farValueFloor(9, 3, false);
const normal = farValueFloor(3, 3, false);
const sparse = farValueFloor(1, 3, true);
ok("富城 > 一般", rich > normal, `${rich} vs ${normal}`);
ok("一般 > 稀疏", normal > sparse, `${normal} vs ${sparse}`);

console.log("\n4) 实际取舍");
// 厦门那种组合：单程 59 分钟，富城门槛下不该成行。
const xiamenValue = farDayValue([scored(park), scored(plaza)], 59).value;
ok(
  "郊野公园 + 广场，单程一小时，富城不该为它丢一整天",
  !farDayWorthGoing([scored(park), scored(plaza)], 59, rich),
  `值 ${xiamenValue.toFixed(2)}，门槛 ${rich}`,
);
ok(
  "同样的组合在稀疏城市照旧成行",
  farDayWorthGoing([scored(park), scored(plaza)], 59, sparse),
);
// 黄山：单程 75 分钟，靠 premier 折让过关。
ok(
  "名录级景点即使只有一个，单程 75 分钟也留得住",
  farDayWorthGoing([scored(flagship)], 75, rich),
  `值 ${farDayValue([scored(flagship)], 75).value.toFixed(2)}`,
);
ok(
  "同一个点位去掉名录身份就过不去（评分高 ≠ 值得专程）",
  !farDayWorthGoing(
    [scored({ ...flagship, name: "某郊野公园", rating: undefined, popularity: 4.6 })],
    75,
    rich,
  ),
);

console.log("\n5) 区域环线不受约束");
// 喀纳斯单程 4 小时：按数值肯定过不了门槛，所以要靠 reachMin 豁免。
ok("喀纳斯按数值过不了门槛", farDayValue([scored(region)], 240).value < rich);
ok(
  "但它带 reachMin，属于行程目的，应被豁免",
  farDayWorthGoing([scored(region)], 240, rich),
);

console.log(
  failed === 0
    ? "\n通过：分量、路程折算、三档门槛、区域豁免都对"
    : `\n失败 ${failed} 项`,
);
process.exit(failed === 0 ? 0 : 1);
