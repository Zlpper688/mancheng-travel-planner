/**
 * 落地支持回归（npx tsx scripts/check-booking.ts）。
 * 只测纯函数：导航链接、查票链接、行前待办汇总。
 */
import {
  bookingSummary,
  collectBookings,
  hasTicketInfo,
  navUrl,
  reservationCount,
  ticketSearchUrl,
} from "../src/lib/booking";
import type { PlanResult, Place, StopPlan } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(name: string, city: string, id = name): Place {
  return {
    id,
    name,
    city,
    category: "attraction",
    lat: 30.6,
    lng: 104.1,
    source: "demo",
  };
}

function sight(p: Place, startMin = 9 * 60, ticket?: number): StopPlan {
  return {
    id: `s-${p.id}`,
    place: p,
    kind: "sight",
    order: 0,
    startMin,
    endMin: startMin + 60,
    dwellMin: 60,
    ticket,
  };
}

console.log("1) 导航与查票链接（不碰支付，只跳转）");
const gulangyu = place("鼓浪屿", "厦门");
const nav = navUrl(gulangyu);
ok("导航走高德官方 URI", nav.startsWith("https://uri.amap.com/marker?"));
ok("带经纬度", new URL(nav).searchParams.get("position") === "104.100000,30.600000");
ok("带名称", new URL(nav).searchParams.get("name") === "鼓浪屿");
ok("带来源标记", new URL(nav).searchParams.get("src") === "mancheng");
ok("能唤起原生 App", new URL(nav).searchParams.get("callnative") === "1");
const ticket = ticketSearchUrl(gulangyu, "厦门");
ok("查票走搜索", ticket.startsWith("https://uri.amap.com/search?"));
ok("搜索词含城市+景点+门票", (new URL(ticket).searchParams.get("keyword") ?? "").includes("厦门鼓浪屿"));

console.log("\n2) 行前待办：从 profile 汇总（不新造数据）");
// 鼓浪屿的 profile 是「船票实名预约」，故宫需查证；用鼓浪屿做必须提前约的正例。
const plan = {
  meta: { city: "厦门", title: "厦门 2 日" },
  days: [
    {
      index: 1,
      date: "2026-12-01",
      stops: [sight(gulangyu), sight(place("日光岩", "厦门"))],
    },
    {
      index: 2,
      date: "2026-12-02",
      stops: [sight(place("完全不存在的景点XYZ", "厦门"))],
    },
  ],
} as unknown as PlanResult;

const items = collectBookings(plan, "厦门");
ok("抓到鼓浪屿", items.some((i) => i.placeName === "鼓浪屿"));
ok("鼓浪屿标记为需预约", items.find((i) => i.placeName === "鼓浪屿")?.needsReservation === true);
ok("不存在的景点不进清单", !items.some((i) => i.placeName.includes("XYZ")));
ok("必须预约的排前面", items.length === 0 || items[0].needsReservation || !items.some((i) => i.needsReservation));
ok("带来源说明", items.every((i) => Boolean(i.source)));
ok("reservationCount 计数正确", reservationCount(items) === items.filter((i) => i.needsReservation).length);
const summary = bookingSummary(items);
ok("有摘要", Boolean(summary));
ok("摘要提到提前约", summary?.includes("预约") === true, summary ?? "");
ok("空清单无摘要", bookingSummary([]) === null);

console.log("\n3) 查票入口判定");
ok("有票价的点显示查票", hasTicketInfo(sight(gulangyu, 540, 50), "厦门"));
ok("餐点不显示", hasTicketInfo({ ...sight(gulangyu), kind: "meal" }, "厦门") === false);
ok("无信息的点不显示", hasTicketInfo(sight(place("某条小巷", "厦门")), "厦门") === false);

console.log("\n4) 行程里没有需预约项目时，摘要不吓人");
const plainPlan = {
  meta: { city: "某城", title: "x" },
  days: [{ index: 1, date: "2026-12-01", stops: [sight(place("无名公园", "某城"))] }],
} as unknown as PlanResult;
ok("无待办时返回空清单", collectBookings(plainPlan, "某城").length === 0);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：跳转链接 + 待办汇总 + 查票判定 + 空态");
