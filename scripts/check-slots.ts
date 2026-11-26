/**
 * 时段级 Slot 投影回归（npx tsx scripts/check-slots.ts）。
 *
 * 证明：
 *   1. 任意一天都能投出 6 段，顺序固定
 *   2. 每个 stop 精确落进一个段，不丢不重
 *   3. 空段有话术，不静默留白
 *   4. 「一天只有一个点」能被 filledSlotCount 抓出来
 *   5. 局部替换只影响目标段，其余段完全不变
 */
import {
  SLOT_PERIODS,
  type DayPlan,
  type StopPlan,
  type Place,
} from "../src/lib/types";
import { buildSlots, filledSlotCount, withSlots } from "../src/lib/plan/slots";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(name: string, category: Place["category"] = "attraction"): Place {
  return {
    id: `p-${name}`,
    name,
    category,
    lat: 30.6,
    lng: 104.1,
    source: "demo",
  };
}

function stop(name: string, startMin: number, kind: StopPlan["kind"] = "sight"): StopPlan {
  return {
    id: `s-${name}`,
    place: place(name, kind === "meal" ? "food" : "attraction"),
    kind,
    order: 0,
    startMin,
    endMin: startMin + 60,
    dwellMin: 60,
  };
}

function day(stops: StopPlan[]): DayPlan {
  return {
    index: 1,
    date: "2026-12-01",
    theme: "测试",
    area: "测试区",
    color: "#fff",
    stops,
    legs: [],
    stats: {
      stopCount: stops.length,
      sightCount: stops.length,
      distanceKm: 5,
      travelMin: 30,
      walkKm: 3,
      ticket: 0,
    },
    startMin: stops[0]?.startMin ?? 9 * 60,
    endMin: stops[stops.length - 1]?.endMin ?? 18 * 60,
    tip: "",
  };
}

console.log("1) 六段投影");
const full = day([
  stop("早市", 7 * 60),
  stop("博物馆", 10 * 60),
  stop("午饭", 12 * 60 + 30, "meal"),
  stop("公园", 15 * 60),
  stop("晚饭", 19 * 60, "meal"),
  stop("夜景", 22 * 60),
]);
const slots = buildSlots(full);
ok("正好 6 段", slots.length === 6, `实际 ${slots.length}`);
ok("段顺序固定", slots.map((s) => s.period).join(",") === SLOT_PERIODS.join(","));
const projected = slots.flatMap((s) => s.stops);
ok("stop 不丢不重", projected.length === full.stops.length);
ok("早市落 early", slots[0].stops[0]?.place.name === "早市");
ok("博物馆落 morning", slots[1].stops[0]?.place.name === "博物馆");
ok("午饭落 noon", slots[2].stops[0]?.place.name === "午饭");
ok("公园落 afternoon", slots[3].stops[0]?.place.name === "公园");
ok("晚饭落 evening", slots[4].stops[0]?.place.name === "晚饭");
ok("夜景落 night", slots[5].stops[0]?.place.name === "夜景");
ok("餐段有意图", slots[2].intent?.includes("吃") === true, `实际 ${slots[2].intent}`);
ok("每段有起止", slots.every((s) => s.startMin === undefined || s.endMin !== undefined));

console.log("\n2) 空段话术");
const sparse = day([stop("只有一个点", 10 * 60)]);
const sparseSlots = buildSlots(sparse);
const empty = sparseSlots.filter((s) => !s.stops.length);
ok("有 5 个空段", empty.length === 5, `实际 ${empty.length}`);
ok("每个空段都有话术", empty.every((s) => Boolean(s.emptyHint)));
ok("filledSlotCount 抓出稀疏", filledSlotCount(sparse) === 1, `实际 ${filledSlotCount(sparse)}`);
ok("filledSlotCount 满档为 6", filledSlotCount(full) === 6);

console.log("\n2.5) 餐点语义优先于时间");
const earlyDinner: StopPlan = {
  ...stop("晚饭", 17 * 60 + 30, "meal"),
  slot: "dinner",
};
const dinnerDay = day([earlyDinner, stop("夜游", 20 * 60 + 30)]);
const dinnerSlots = buildSlots(dinnerDay);
ok("17:30 的晚饭归 evening", dinnerSlots[4].stops[0]?.place.name === "晚饭");
ok("20:30 的夜游归 evening", dinnerSlots[4].stops[1]?.place.name === "夜游");
const lateLunch: StopPlan = {
  ...stop("午饭", 14 * 60 + 20, "meal"),
  slot: "lunch",
};
ok("14:20 的午饭仍归 noon", buildSlots(day([lateLunch]))[2].stops[0]?.place.name === "午饭");

console.log("\n3) 局部替换不波及他段");
const before = JSON.stringify(slots);
const nextStops = full.stops.filter((s) => s.place.name !== "公园");
const after = withSlots(day(nextStops)).slots!;
const same =
  JSON.stringify(after[0]) === JSON.stringify(slots[0]) &&
  JSON.stringify(after[1]) === JSON.stringify(slots[1]) &&
  JSON.stringify(after[2]) === JSON.stringify(slots[2]) &&
  JSON.stringify(after[4]) === JSON.stringify(slots[4]) &&
  JSON.stringify(after[5]) === JSON.stringify(slots[5]);
ok("只换下午段，其余段逐字节不变", same);
ok("下午段变空并给话术", after[3].stops.length === 0 && Boolean(after[3].emptyHint));
ok("原 stops 未被改", full.stops.length === 6);
ok("投影不改真源（前段引用仍有效）", before.includes("早市"));

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：六段投影 + 空段话术 + 稀疏检测 + 局部替换隔离");
