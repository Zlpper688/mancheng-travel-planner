/**
 * 人流时段回归检查（npx tsx scripts/check-crowd.ts）。
 *
 * 要锁住的是「说话的分寸」：
 *   · 有名气的点才提醒，普通街边公园别天天喊人多
 *   · 撞上高峰要直说，排进低谷要肯定，其余情况闭嘴
 *   · 文案只说规律，不编造人数与排队分钟数
 */
import {
  crowdDwellFactor,
  crowdNote,
  crowdOf,
  crowdPenaltyAt,
} from "../src/lib/plan/crowd";
import { CROWD_HOURS } from "../src/content/crowd-hours";
import type { Category, Place } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(category: Category, over: Partial<Place> = {}): Place {
  return {
    id: over.id ?? `${category}-1`,
    name: over.name ?? "某景点",
    category,
    lat: 24.45,
    lng: 118.09,
    source: "demo",
    city: "厦门",
    ...over,
  };
}

console.log("1) 只给有名气的点做人流推断");
const famous = crowdOf(place("attraction", { popularity: 4.8, rating: 4.7 }));
ok("热门景点有高峰时段", famous.peak.length > 0);
ok("热门景点有低谷时段", famous.valley.length > 0);
ok("标成推断而非实测", famous.source === "heuristic");
ok("拥挤会拉长停留", famous.factor > 1);
const ordinary = crowdOf(place("attraction", { popularity: 3.1, rating: 3.9 }));
ok("普通点位不硬造人流", ordinary.peak.length === 0 && ordinary.valley.length === 0);
ok("普通点位也没有提示", crowdNote(ordinary, 10 * 60, 60) === null);

console.log("\n2) 不同类别的规律不同");
const market = crowdOf(place("market", { popularity: 4.6 }));
ok("早市高峰在上午 9–11 点", market.peak.some(([s, e]) => s === 9 * 60 && e === 11 * 60));
const museum = crowdOf(place("museum", { popularity: 4.6 }));
ok("博物馆高峰不在开馆第一小时", museum.peak.every(([s]) => s >= 11 * 60));
const temple = crowdOf(place("temple", { popularity: 4.4 }));
ok("寺庙高峰在 9 点后", temple.peak.every(([s]) => s >= 9 * 60));

console.log("\n3) 排序代价：撞高峰 > 落低谷");
const peakPenalty = crowdPenaltyAt(famous, 10 * 60 + 30, 90);
const valleyPenalty = crowdPenaltyAt(famous, 8 * 60 + 30, 60);
ok("高峰时段被罚", peakPenalty > 0, peakPenalty.toFixed(2));
ok("低谷时段不被罚（甚至轻微减罚）", valleyPenalty <= 0, valleyPenalty.toFixed(2));
ok("高峰罚得比低谷重", peakPenalty > valleyPenalty);

console.log("\n4) 文案分寸");
const peakNote = crowdNote(famous, 10 * 60 + 30, 90);
ok("撞高峰时直说人最多", Boolean(peakNote && peakNote.includes("人最多")), peakNote ?? "null");
const valleyNote = crowdNote(famous, 8 * 60 + 30, 60);
ok(
  "落低谷时给肯定而不是警告",
  Boolean(valleyNote && /人相对少|刚好/.test(valleyNote)),
  valleyNote ?? "null",
);
ok(
  "文案不带具体排队分钟数（没有依据就不编）",
  ![peakNote, valleyNote].some((note) => note && /\d+\s*分钟/.test(note)),
);
const neutralNote = crowdNote(famous, 12 * 60 + 30, 30);
ok("不上不下时不硬凑一句话", neutralNote === null, neutralNote ?? "null");

console.log("\n5) 拥挤对停留时长的作用范围");
// 推断出来的规律只用来排序和写提示；只有人工核实的时段数据才允许拉长停留。
// 否则「10 点人最多」会因为拉长停留而把下午一起顺延，等于自己造下一个高峰。
ok(
  "推断的拥挤不会改变停留时长",
  crowdDwellFactor(famous, 10 * 60 + 30, 90) === 1,
  `${crowdDwellFactor(famous, 10 * 60 + 30, 90)}`,
);
const verified = {
  peak: [[10 * 60, 12 * 60]] as Array<[number, number]>,
  valley: [] as Array<[number, number]>,
  factor: 1.4,
  source: "data" as const,
};
ok(
  "核实过的数据在高峰会拉长停留",
  crowdDwellFactor(verified, 10 * 60 + 15, 90) > 1,
  `${crowdDwellFactor(verified, 10 * 60 + 15, 90).toFixed(2)}`,
);
ok(
  "只是擦到一点高峰就不拉长",
  crowdDwellFactor(verified, 11 * 60 + 50, 60) === 1,
  `${crowdDwellFactor(verified, 11 * 60 + 50, 60).toFixed(2)}`,
);
ok(
  "放大系数有上限，不会无限膨胀",
  crowdDwellFactor({ ...verified, factor: 3 }, 10 * 60 + 30, 120) <= 1.5,
);

console.log("\n4b) 采样数据表：一旦录入就必须合法");
// 这张表是唯一会被当成「实测」的来源，格式错了会静默退回推断——
// 那意味着「我们以为在按实测排，其实还在按猜的排」。所以先守住格式。
const bad: string[] = [];
const clockPattern = /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/;
for (const entry of CROWD_HOURS) {
  const label = entry.name || "（未命名）";
  if (!entry.city) bad.push(`${label}: 缺 city`);
  if (!entry.name) bad.push(`${label}: 缺 name`);
  if (!Array.isArray(entry.peak) || !entry.peak.length)
    bad.push(`${label}: peak 不能为空`);
  for (const window of [...(entry.peak ?? []), ...(entry.valley ?? [])]) {
    if (!clockPattern.test(window)) bad.push(`${label}: 时段格式错 ${window}`);
  }
  if (
    entry.factor !== undefined &&
    (!Number.isFinite(entry.factor) || entry.factor < 1 || entry.factor > 1.5)
  ) {
    bad.push(`${label}: factor 必须落在 1–1.5`);
  }
  if (!entry.sampledAt) bad.push(`${label}: 缺采样日期`);
  if (!["manual", "api", "official"].includes(entry.source))
    bad.push(`${label}: source 只能是 manual/api/official`);
}
ok(
  `已录入的采样条目全部合法（当前 ${CROWD_HOURS.length} 条）`,
  bad.length === 0,
  bad.join("; "),
);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：推断克制 + 代价方向 + 文案分寸");
