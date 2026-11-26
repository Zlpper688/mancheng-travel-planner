#!/usr/bin/env node
/**
 * 目的地形态分析与分类（测量驱动，先看分布再定阈值）。
 *
 * 输出 data/knowledge/destination-forms.json：
 *   { "<city>": { form, evidence: {...}, label } }
 *
 * 形态：
 *   city-hub              单城漫游（景点集中在市中心 25km 内）
 *   outskirt-day          城市 + 一个远郊点（主城密集 + 1 个 30-120km 的名点）
 *   small-town-big-sight  小城大景点（县城小、一个重量级景区在 30-150km）
 *   scenic-base           景区基地（住宿与游玩都围绕一个景区，城区不是主角）
 *   multi-city            多城联游（must 里出现 2 个以上其他城市名）
 *   region-loop           区域环线（跨度 >250km，跨省/大区）
 *
 * 用法：node scripts/classify-destinations.mjs [--verbose]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const KB = path.join(ROOT, "data", "knowledge");
const CITIES = path.join(KB, "cities");
const ENRICH = path.join(KB, "enrichment");
const OUT = path.join(KB, "destination-forms.json");
const verbose = process.argv.includes("--verbose");

const R = (x) => (x * Math.PI) / 180;
function haversine(a, b) {
  const dLat = R(b[1] - a[1]);
  const dLng = R(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(R(a[1])) * Math.cos(R(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

const BIG_SIGHT = /景区|风景名胜|国家公园|世界遗产|保护区|森林公园|地质公园|古城|古镇|大峡谷|雪山|草原|沙漠|湖|沟|岛|山$/;
const CITY_SUFFIX = /市$/;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function classify(city, doc) {
  const places = Object.entries(doc.places ?? {})
    .filter(([, p]) => p && p.verified !== false && Number.isFinite(p.lng) && Number.isFinite(p.lat))
    .map(([key, p]) => ({ key, ...p }));
  const center = doc.center;
  if (!places.length) return { form: "city-hub", evidence: { reason: "无核实坐标，兜底" } };
  if (!center) return { form: "region-loop", evidence: { reason: "无中心，按区域处理" } };

  const dists = places.map((p) => haversine([p.lng, p.lat], center)).sort((a, b) => a - b);
  const p50 = percentile(dists, 0.5);
  const p90 = percentile(dists, 0.9);
  const max = dists[dists.length - 1];
  const nearShare = dists.filter((d) => d <= 25).length / dists.length;
  const farSights = places.filter((p) => {
    const d = haversine([p.lng, p.lat], center);
    return d > 30 && d < 160 && BIG_SIGHT.test(p.name ?? p.key);
  });
  const veryFarShare = dists.filter((d) => d > 250).length / dists.length;

  // must 里出现其他城市名（用全部城市名做词表）
  const cityNames = new Set(
    fs.readdirSync(CITIES).map((f) => f.replace(/\.json$/, "")).filter((c) => c !== city),
  );
  const foreign = new Set();
  for (const p of places) {
    const name = String(p.name ?? p.key);
    for (const c of cityNames) {
      if (c.length >= 2 && name.includes(c)) foreign.add(c);
    }
  }

  let form = "city-hub";
  let reason = "";
  if (max > 250 || veryFarShare >= 0.35) {
    form = "region-loop";
    reason = `最远 ${Math.round(max)}km，${Math.round(veryFarShare * 100)}% 的点在 250km 外`;
  } else if (foreign.size >= 2 && p90 > 60) {
    form = "multi-city";
    reason = `must 含 ${foreign.size} 个其他城市名（${[...foreign].slice(0, 4).join("、")}）`;
  } else if (nearShare < 0.45 && p50 > 20) {
    form = "scenic-base";
    reason = `主簇离中心 ${Math.round(p50)}km，城区不是主角`;
  } else if (farSights.length >= 1 && nearShare >= 0.5 && p90 > 30) {
    form = "small-town-big-sight";
    reason = `城区密集(${Math.round(nearShare * 100)}% 在25km内) + 大景区「${farSights[0].name ?? farSights[0].key}」${Math.round(haversine([farSights[0].lng, farSights[0].lat], center))}km`;
  } else if (farSights.length >= 1 && nearShare < 0.5) {
    form = "outskirt-day";
    reason = `主城 + 远郊点「${farSights[0].name ?? farSights[0].key}」`;
  } else {
    form = "city-hub";
    reason = `${Math.round(nearShare * 100)}% 的点在中心 25km 内`;
  }

  return {
    form,
    evidence: {
      reason,
      count: places.length,
      p50: Math.round(p50),
      p90: Math.round(p90),
      max: Math.round(max),
      nearShare: Math.round(nearShare * 100),
      foreignCities: [...foreign].slice(0, 6),
      farSights: farSights.slice(0, 4).map((p) => p.name ?? p.key),
    },
  };
}

const LABELS = {
  "city-hub": "单城漫游",
  "outskirt-day": "城郊一日",
  "small-town-big-sight": "小城大景点",
  "scenic-base": "景区基地",
  "multi-city": "多城联游",
  "region-loop": "区域环线",
};

const files = fs.readdirSync(ENRICH).filter((f) => f.endsWith(".json"));
const result = {};
const byForm = {};
for (const file of files) {
  const city = file.replace(/\.json$/, "");
  const doc = JSON.parse(fs.readFileSync(path.join(ENRICH, file), "utf8"));
  const { form, evidence } = classify(city, doc);
  result[city] = { form, label: LABELS[form], evidence };
  (byForm[form] ??= []).push(city);
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
console.log(`分类 ${files.length} 城 -> ${OUT}\n`);
for (const [form, cities] of Object.entries(byForm).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${LABELS[form]} (${form}) ${cities.length} 城`);
  console.log(`  ${cities.slice(0, 30).join("、")}${cities.length > 30 ? " …" : ""}`);
}
if (verbose) {
  console.log("\n--- 明细 ---");
  for (const [city, v] of Object.entries(result)) {
    console.log(`${city.padEnd(8)} ${v.form.padEnd(22)} ${v.evidence.reason}`);
  }
}
