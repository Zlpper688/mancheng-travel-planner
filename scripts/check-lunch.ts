/**
 * 午饭时间回归检查（npx tsx scripts/check-lunch.ts）。
 *
 * 背景：用户验收时指出「午饭太晚这种事不应该发生，哪个城市都不应该」。
 * 实测 6 城 × 3 节奏 × 3 天，54 个旅行日里有 9 天午饭晚于 14:00，
 * 最晚 16:20 —— 成因不是某一条分支写错，而是粗排时间一律低估真实耗时，
 * 于是一个大景点（鼓浪屿 240 分钟、科技馆 150 分钟）就能把午饭顶到下午。
 *
 * 断言：
 *   1. 长景点吞掉午间 → 在景点里吃（拆段），切点落在 12:00 附近
 *   2. 普通点吞掉午间 → 把午饭挪到它前面，不拆
 *   3. 前面有好几个点被吞 → 一次往前挪一格，由调用方重排复核
 *   4. 只到 13:30 为止都算按时，不该动
 *   5. 午饭是第一站却到得太早 → 整天晚点出门，别在饭馆干等
 *   6. 一个点都挪不动时不硬掰（那是出发时间的账）
 *   7. 体检：13:30 之后算硬伤；过了午饭时段才出门的日子不报「漏了午饭」
 */
import { auditDay } from "../src/lib/plan/audit";
import { lunchFix } from "../src/lib/plan/schedule";
import type { Category, DayPlan, Place, RouteLeg, StopPlan } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(name: string, category: Category): Place {
  return { id: name, name, category, lat: 24.44, lng: 118.08, source: "demo", city: "测试城" };
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

/** 只填 lunchFix / audit 会读的字段，其余留给类型断言。 */
function legsOf(arrives: number[]): RouteLeg[] {
  return arrives.map((arriveMin) => ({ arriveMin }) as unknown as RouteLeg);
}

const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const base = { startMin: 9 * 60, latestStart: 10 * 60 + 30 };

console.log("1) 长景点吞掉午间：在景点里吃");
const island = {
  stops: [stop("鼓浪屿", 10 * 60, 14 * 60), stop("午饭", 15 * 60 + 5, 16 * 60 + 10, "lunch")],
  legs: legsOf([10 * 60, 15 * 60 + 5]),
};
const inside = lunchFix(island, base);
ok("判定为景点内吃饭", inside?.kind === "inside", JSON.stringify(inside));
ok(
  "切在 12:00 前后（前段 120 分钟）",
  inside?.kind === "inside" && inside.firstMin === 120,
  inside?.kind === "inside" ? String(inside.firstMin) : "-",
);
ok(
  "前后两段加起来还是原来的停留",
  inside?.kind === "inside" && inside.firstMin + inside.restMin === 240,
  inside?.kind === "inside" ? `${inside.firstMin}+${inside.restMin}` : "-",
);

console.log("\n2) 普通点吞掉午间：把午饭挪到它前面");
const shortSight = {
  stops: [stop("鹿回头", 11 * 60 + 55, 13 * 60 + 20), stop("午饭", 14 * 60 + 40, 15 * 60 + 45, "lunch")],
  legs: legsOf([11 * 60 + 55, 14 * 60 + 40]),
};
const earlier = lunchFix(shortSight, base);
ok("判定为前移", earlier?.kind === "earlier", JSON.stringify(earlier));
ok("挪到第一站之前", earlier?.kind === "earlier" && earlier.before === 0);
ok("不走拆段（85 分钟的点拆了没意义）", earlier?.kind !== "inside");

console.log("\n3) 前面好几个点：一次挪一格");
const many = {
  stops: [
    stop("A", 9 * 60, 10 * 60),
    stop("B", 10 * 60 + 30, 11 * 60 + 30),
    stop("C", 14 * 60 + 30, 15 * 60 + 45),
    stop("午饭", 16 * 60 + 20, 17 * 60 + 25, "lunch"),
  ],
  legs: legsOf([9 * 60, 10 * 60 + 30, 14 * 60 + 30, 16 * 60 + 20]),
};
const stepwise = lunchFix(many, base);
ok("判定为前移", stepwise?.kind === "earlier", JSON.stringify(stepwise));
ok(
  "前移到倒数第二个景点之前",
  stepwise?.kind === "earlier" && stepwise.before === 2,
  stepwise?.kind === "earlier" ? String(stepwise.before) : "-",
);

console.log("\n4) 按时的不动");
const onTime = {
  stops: [stop("A", 9 * 60, 11 * 60), stop("午饭", 12 * 60, 13 * 60 + 5, "lunch")],
  legs: legsOf([9 * 60, 12 * 60]),
};
ok("12:00 不动", lunchFix(onTime, base) === null);
const justInTime = {
  stops: [stop("A", 9 * 60, 13 * 60), stop("午饭", 13 * 60 + 30, 14 * 60 + 35, "lunch")],
  legs: legsOf([9 * 60, 13 * 60 + 30]),
};
ok("13:30 整仍算按时", lunchFix(justInTime, base) === null);

console.log("\n5) 第一站就是午饭，到得太早");
const tooEarly = {
  stops: [stop("午饭", 11 * 60, 12 * 60 + 5, "lunch"), stop("图书馆", 13 * 60 + 30, 15 * 60)],
  legs: legsOf([9 * 60 + 30, 12 * 60 + 40]),
};
const shift = lunchFix(tooEarly, base);
ok("判定为整体后移", shift?.kind === "later-start", JSON.stringify(shift));
ok(
  "后移量足以消掉大半空等",
  shift?.kind === "later-start" && shift.shift >= 60,
  shift?.kind === "later-start" ? String(shift.shift) : "-",
);
const slightlyEarly = {
  stops: [stop("午饭", 11 * 60, 12 * 60 + 5, "lunch")],
  legs: legsOf([10 * 60 + 45]),
};
ok("只早了 15 分钟就不折腾", lunchFix(slightlyEarly, base) === null);

console.log("\n6) 一个景点都挪不动时不硬掰");
const noSight = {
  stops: [stop("午饭", 15 * 60, 16 * 60, "lunch")],
  legs: legsOf([15 * 60]),
};
ok("没有前站可挪就返回 null（交给出发时间那套逻辑）", lunchFix(noSight, base) === null);
const noLunch = { stops: [stop("A", 9 * 60, 11 * 60)], legs: legsOf([9 * 60]) };
ok("没有午饭也返回 null", lunchFix(noLunch, base) === null);

console.log("\n7) 拆段门限：145 分钟的点不值得拆");
const borderline = {
  stops: [stop("某景区", 11 * 60, 13 * 60 + 25), stop("午饭", 14 * 60, 15 * 60, "lunch")],
  legs: legsOf([11 * 60, 14 * 60]),
};
ok("145 分钟走前移", lunchFix(borderline, base)?.kind === "earlier");

function dayOf(stops: StopPlan[], startMin: number, endMin: number): DayPlan {
  return {
    index: 1,
    date: "2026-11-27",
    theme: "",
    area: "",
    color: "#000",
    stops,
    legs: legsOf(stops.map((item) => item.startMin)),
    stats: { stopCount: stops.length, sightCount: 0, distanceKm: 0, travelMin: 0, walkKm: 0, ticket: 0 },
    startMin,
    endMin,
    tip: "",
  } as DayPlan;
}

console.log("\n8) 体检口径");
const late = auditDay(
  dayOf(
    [stop("景区", 10 * 60, 14 * 60), stop("午饭", 15 * 60 + 5, 16 * 60 + 10, "lunch")],
    9 * 60,
    18 * 60,
  ),
  { pace: "chill" },
);
const lateIssue = late.find((issue) => issue.code === "LUNCH_LATE");
ok("15:05 的午饭报 LUNCH_LATE", Boolean(lateIssue));
ok("而且是硬伤，不是提醒", lateIssue?.severity === "error", lateIssue?.severity ?? "-");

const fine = auditDay(
  dayOf([stop("景区", 9 * 60, 12 * 60), stop("午饭", 12 * 60 + 15, 13 * 60 + 20, "lunch")], 9 * 60, 18 * 60),
  { pace: "chill" },
);
ok("12:15 的午饭不报", !fine.some((issue) => issue.code === "LUNCH_LATE"));

const afternoonStart = auditDay(
  dayOf([stop("日落点", 16 * 60, 17 * 60)], 14 * 60, 18 * 60),
  { pace: "chill" },
);
ok(
  "下午才出门的那天不报「漏了午饭」",
  !afternoonStart.some((issue) => issue.code === "NO_LUNCH"),
  afternoonStart.map((issue) => issue.code).join(","),
);

console.log(
  failed ? `\n失败 ${failed} 条` : "\n通过：拆段、前移、后移、按时、体检口径都对",
);
if (failed) process.exitCode = 1;
