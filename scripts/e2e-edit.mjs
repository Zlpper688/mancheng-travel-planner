// 验证「单点锁定 / 换一个 / 移除」三条编辑能力是否真的生效
const BASE = "http://127.0.0.1:3000";

async function plan(body) {
  const res = await fetch(BASE + "/api/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json();
  if (!res.ok || !data.plan) {
    throw new Error(`plan 失败 ${res.status}: ${data.error ?? ""}`);
  }
  return data.plan;
}

const stopsOf = (p, day) => p.days.find((d) => d.index === day)?.stops ?? [];
const names = (list) => list.map((s) => `${s.place.name}(${s.kind})`).join(" / ");

// 先用真实搜索拿到一间酒店，优先取市中心一带，避免落在远郊导致候选池过小
const s = await fetch(
  BASE + "/api/search?q=" + encodeURIComponent("酒店") + "&kind=hotel&city=" + encodeURIComponent("成都"),
).then((r) => r.json());
const hotels = (s.results ?? []).filter((r) => /酒店|宾馆/.test(r.name));
const central = /锦江|春熙|天府|青羊|武侯|市中心|东大街|盐市口/;
const hotel =
  hotels.find((r) => central.test(`${r.name}${r.address ?? ""}`)) ?? hotels[0];
if (!hotel) throw new Error("没搜到酒店");
console.log(`落脚点：${hotel.name}${hotel.address ? `（${hotel.address}）` : ""}\n`);

const base = {
  city: "成都",
  hotel,
  days: 2,
  date: "2026-11-20",
  pace: "balanced",
  styles: ["citywalk", "classic"],
  transport: "auto",
  budgetTier: "comfort",
  adults: 2,
  children: 0,
  seed: 42,
};

let fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) fail++;
};

// ---------- 基线 ----------
const p0 = await plan(base);
const day1 = stopsOf(p0, 1);
console.log(`[基线] Day1 ${day1.length} 站：${names(day1)}\n`);

const victimSight = day1.find((st) => st.kind === "sight");
if (!victimSight) throw new Error("Day1 没有景点，无法测试");

// ---------- 1. 移除：该点必须消失，且当天景点少一个 ----------
// 只数景点：餐食由时间窗驱动，会随行程长度自然增减，不适合作为断言口径。
const sightsOf = (list) => list.filter((st) => st.kind === "sight");
const p1 = await plan({ ...base, excludeIds: [victimSight.place.id], slimDays: { 1: 1 } });
const day1AfterRemove = stopsOf(p1, 1);
const stillThere = day1AfterRemove.some((st) => st.place.id === victimSight.place.id);
check(!stillThere, `移除「${victimSight.place.name}」后不再出现`);
check(
  sightsOf(day1AfterRemove).length === sightsOf(day1).length - 1,
  `Day1 景点从 ${sightsOf(day1).length} 降到 ${sightsOf(day1AfterRemove).length}（移除不被兜底补回）`,
);
console.log(`       移后 Day1：${names(day1AfterRemove)}\n`);

// ---------- 2. 换一个：该点消失，但当天站数基本保持 ----------
const p2 = await plan({ ...base, excludeIds: [victimSight.place.id] });
const day1AfterReplace = stopsOf(p2, 1);
const replaced = day1AfterReplace.filter((st) => st.place.id !== victimSight.place.id);
check(
  !day1AfterReplace.some((st) => st.place.id === victimSight.place.id),
  `换掉「${victimSight.place.name}」后不再出现`,
);
check(
  day1AfterReplace.length >= day1.length - 1,
  `换一个后 Day1 仍有 ${day1AfterReplace.length} 站（换一个会补位，移除不会）`,
);
console.log(`       换后 Day1：${names(day1AfterReplace)}\n`);

// ---------- 3. 锁定：跨重排必须留在原定那天 ----------
const lockTarget = stopsOf(p0, 2).find((st) => st.kind === "sight");
if (!lockTarget) throw new Error("Day2 没有景点");
const p3 = await plan({
  ...base,
  seed: 977, // 换 seed，模拟用户点「换一版」
  lockedPlaces: [{ place: lockTarget.place, day: 2 }],
});
const day2Locked = stopsOf(p3, 2);
check(
  day2Locked.some((st) => st.place.id === lockTarget.place.id),
  `换 seed 重排后，「${lockTarget.place.name}」仍锁在 Day2`,
);
check(
  day2Locked.length > 1,
  `锁定只固定这一个点，Day2 仍有 ${day2Locked.length} 站（没有退化成整天单点）`,
);
console.log(`       锁定后 Day2：${names(day2Locked)}\n`);

// ---------- 4. 锁定不能污染其它天 ----------
const elsewhere = p3.days
  .filter((d) => d.index !== 2)
  .some((d) => d.stops.some((st) => st.place.id === lockTarget.place.id));
check(!elsewhere, "被锁定的点没有同时出现在其它天");

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
