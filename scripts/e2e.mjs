// 端到端验证：走真实 HTTP 接口，确认 Amap 数据进入排线结果
const BASE = "http://127.0.0.1:3000";

async function getJson(path) {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: { raw: text.slice(0, 300) } };
  }
}

// 1) 地点搜索（真实 POI）
const s1 = await getJson(
  "/api/search?q=" + encodeURIComponent("宽窄巷子") + "&kind=any&city=" + encodeURIComponent("成都")
);
console.log(`\n[1] 地点搜索  status=${s1.status} 结果数=${s1.data.results?.length ?? 0}`);
for (const r of (s1.data.results ?? []).slice(0, 3)) {
  console.log(`    · ${r.name} | source=${r.source} | 评分=${r.rating ?? "-"} 人均=${r.cost ?? "-"} | ${r.address ?? ""}`);
}

// 2) 酒店搜索（挑一间名字里带「酒店」的，避免把商场当成落脚点）
const s2 = await getJson(
  "/api/search?q=" + encodeURIComponent("酒店") + "&kind=hotel&city=" + encodeURIComponent("成都")
);
const hotel = (s2.data.results ?? []).find((r) => /酒店|宾馆|民宿/.test(r.name)) ?? s2.data.results?.[0];
console.log(`\n[2] 酒店搜索  status=${s2.status} 结果数=${s2.data.results?.length ?? 0}`);
console.log(`    选中: ${hotel?.name} source=${hotel?.source}`);

if (!hotel) {
  console.log("没有搜到酒店，终止");
  process.exit(1);
}

// 3) 生成完整行程
const payload = {
  city: "成都",
  hotel,
  days: 2,
  date: "2026-11-21",
  pace: "balanced",
  styles: ["citywalk", "foodie"],
  transport: "auto",
  budgetTier: "comfort",
  adults: 2,
  children: 0,
  seed: 7,
};
const t0 = Date.now();
const res = await fetch(BASE + "/api/plan", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(180000),
});
const body = await res.json();
console.log(`\n[3] 生成行程  status=${res.status} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (body.error) {
  console.log(`    错误: ${body.error} / ${body.code} / ${body.hint ?? ""}`);
  process.exit(1);
}

const plan = body.plan;
console.log(`    预算字段: ${JSON.stringify(plan.budget ?? {}).slice(0, 200)}`);
let amapStops = 0;
let ratedStops = 0;
let costStops = 0;
for (const day of plan.days ?? []) {
  console.log(`    Day${day.index}: ${day.stops?.length ?? 0} 个停留`);
  for (const stop of day.stops ?? []) {
    const p = stop.place ?? {};
    if (p.source === "amap") amapStops++;
    if (p.rating) ratedStops++;
    if (p.cost) costStops++;
    console.log(
      `      · ${p.name} [${p.category}] 评分=${p.rating ?? "-"} 人均=${p.cost ?? "-"} 停车${stop.dwellMin ?? "?"}min`
    );
  }
  for (const leg of (day.legs ?? []).slice(0, 2)) {
    console.log(
      `      → ${leg.fromName} → ${leg.toName}: ${leg.mode} ${leg.durationMin}min ${leg.distanceKm}km ¥${leg.cost}${leg.estimated ? " (估算)" : ""}`
    );
  }
}
console.log(`\n数据来源统计: 高德点位=${amapStops} | 带评分=${ratedStops} | 带人均=${costStops}`);

// 抽样看首个高德点位
outer: for (const day of plan.days ?? []) {
  for (const stop of day.stops ?? []) {
    if (stop.place?.source === "amap") {
      console.log(`样本: ${stop.place.name} 评分=${stop.place.rating ?? "-"} 人均=${stop.place.cost ?? "-"} 营业=${stop.place.openHours ?? "-"}`);
      break outer;
    }
  }
}
