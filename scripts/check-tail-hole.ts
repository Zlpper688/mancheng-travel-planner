/**
 * 尾段空洞识别回归检查（npx tsx scripts/check-tail-hole.ts）。
 *
 * 背景：厦门实测第 1 天 15:34 就散场，午饭之后什么都没有、也不吃晚饭。
 * 原因不是「松弛节奏允许留白」，而是排程为了不赶路连砍两个点，
 * 砍完就收工——而补点逻辑只认「两个停留点之间」的空洞，尾段空着它看不见。
 *
 * 断言：
 *   1. 中间空洞照旧能识别（不能因为改尾段把原逻辑弄坏）
 *   2. 尾段空洞：没吃晚饭 + 17 点前收工 → 识别出来，目标是补到 18:30
 *   3. 已经有晚饭的不算尾段空洞
 *   4. 17 点之后收工属于正常下午结束，不补
 *   5. 回家上限早于 18:30 时，补到上限为止；上限太早就不补
 */
import { afternoonHole } from "../src/lib/plan/schedule";
import type { Category, Place, StopPlan } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(name: string, category: Category): Place {
  return {
    id: name,
    name,
    category,
    lat: 24.44,
    lng: 118.08,
    source: "demo",
    city: "测试城",
  };
}

function stop(
  name: string,
  startMin: number,
  endMin: number,
  slot?: StopPlan["slot"],
): StopPlan {
  const category: Category = slot ? "food" : "attraction";
  return {
    id: name,
    place: place(name, category),
    kind: slot ? "meal" : "sight",
    order: 0,
    startMin,
    endMin,
    dwellMin: endMin - startMin,
    slot,
  };
}

const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

console.log("1) 中间空洞照旧识别");
const between = afternoonHole([
  stop("上午点", 9 * 60, 11 * 60),
  stop("午饭", 11 * 60 + 30, 12 * 60 + 30, "lunch"),
  stop("日落点", 17 * 60 + 30, 18 * 60),
]);
ok("识别到了", Boolean(between));
ok("是中间空洞（有 next）", Boolean(between?.next));
ok(
  "空洞从午后开始",
  (between?.startMin ?? 0) === 12 * 60 + 30,
  between ? hm(between.startMin) : "-",
);

console.log("\n2) 尾段空洞：吃完午饭就散场");
const tail = afternoonHole([
  stop("厦门大学", 10 * 60 + 30, 12 * 60 + 45),
  stop("午饭", 13 * 60 + 10, 14 * 60 + 15, "lunch"),
]);
ok("识别到了", Boolean(tail));
ok("没有 next（只能往末尾补）", tail?.next === null);
ok("从最后一段结束起算", (tail?.startMin ?? 0) === 14 * 60 + 15, tail ? hm(tail.startMin) : "-");
ok("目标补到 18:30", (tail?.endMin ?? 0) === 18 * 60 + 30, tail ? hm(tail.endMin) : "-");

console.log("\n3) 已经有晚饭的：不是尾段空洞，但中间空档照样要补");
const withDinner = afternoonHole([
  stop("厦门大学", 10 * 60 + 30, 12 * 60 + 45),
  stop("午饭", 13 * 60 + 10, 14 * 60 + 15, "lunch"),
  stop("晚饭", 17 * 60 + 30, 18 * 60 + 30, "dinner"),
]);
ok("不当作尾段（有 next）", Boolean(withDinner?.next));
ok(
  "认的是 14:15–17:30 那段",
  (withDinner?.startMin ?? 0) === 14 * 60 + 15,
  withDinner ? hm(withDinner.startMin) : "-",
);

console.log("\n4) 17 点之后收工是正常的");
const lateEnough = afternoonHole([
  stop("鼓浪屿", 10 * 60, 14 * 60),
  stop("午饭", 14 * 60 + 30, 15 * 60 + 30, "lunch"),
  stop("海边", 17 * 60 + 10, 17 * 60 + 40),
]);
ok("不补", lateEnough === null, lateEnough ? hm(lateEnough.startMin) : "");

console.log("\n5) 回家上限早于 18:30 时按上限收");
const tight = afternoonHole(
  [stop("厦门大学", 13 * 60, 15 * 60)],
  16 * 60 + 20,
);
ok("上限太早就不补了", tight === null, tight ? hm(tight.endMin) : "");
const looser = afternoonHole([stop("厦门大学", 13 * 60, 15 * 60)], 17 * 60 + 20);
ok(
  "上限 17:20 时补到 17:20",
  (looser?.endMin ?? 0) === 17 * 60 + 20,
  looser ? hm(looser.endMin) : "-",
);
const roomy = afternoonHole([stop("厦门大学", 13 * 60, 15 * 60)], 18 * 60);
ok("上限 18:00 时补到 18:00", (roomy?.endMin ?? 0) === 18 * 60, roomy ? hm(roomy.endMin) : "-");

console.log(
  failed === 0
    ? "\n通过：中间空洞、尾段空洞、晚饭、时间上限都对"
    : `\n失败 ${failed} 项`,
);
process.exit(failed === 0 ? 0 : 1);
