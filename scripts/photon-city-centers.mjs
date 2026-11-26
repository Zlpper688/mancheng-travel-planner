#!/usr/bin/env node
/**
 * 用 Photon（基于 OSM，免 Key）为攻略语料里的城市补中心坐标。
 *
 * 产物与 amap-city-centers.mjs 完全同构：
 *   data/city-centers.json  { "成都": { "center": [104.0753, 30.6592], ... }, ... }
 *
 * 用法：
 *   node scripts/photon-city-centers.mjs          # 只补缺失
 *   node scripts/photon-city-centers.mjs --force  # 全部重取
 *   node scripts/photon-city-centers.mjs --only=成都,杭州
 *
 * 高德 Key 到位后可用 amap-city-centers.mjs 覆盖成更准的行政区中心。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "data", "city-centers.json");
const GUIDE_DIR = path.join(ROOT, "data", "guides");
const args = process.argv.slice(2);
const force = args.includes("--force");
const onlyArg = args.find((a) => a.startsWith("--only="));
const ONLY = onlyArg
  ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const PROVINCE_HINT =
  /^(云南|新疆|西藏|广西|青海|甘肃|四川|贵州|华北|华东|华南|东北|西北|西南|川藏)/;
const CITY_TYPES = new Set([
  "city", "town", "state", "region", "county", "district", "locality", "municipality",
]);

function citiesFromGuides() {
  const set = new Set();
  for (const file of fs.readdirSync(GUIDE_DIR)) {
    if (!/^g-.+\.json$/.test(file)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(GUIDE_DIR, file), "utf8"));
      const city = String(doc.city || "").trim();
      if (city) set.add(city);
    } catch {
      /* 跳过坏文件 */
    }
  }
  return [...set].sort();
}

/** 在中国大陆范围内才认，避免 Photon 把同名外国城市排在前面 */
function inChina(lng, lat) {
  return lng > 73 && lng < 136 && lat > 17 && lat < 54;
}

async function lookup(city) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", city);
  url.searchParams.set("limit", "15");
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data = await res.json();
  const short = city.replace(/[市区县]$/g, "").trim();
  let best = null;

  for (const feature of data.features ?? []) {
    const p = feature.properties ?? {};
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length !== 2) continue;
    const [lng, lat] = coords;
    if (!inChina(lng, lat)) continue;

    const name = String(p.name || "");
    const type = String(p.type || "");
    const osmKey = String(p.osm_key || "");
    let score = 0;
    if (name === city || name === short) score += 20;
    else if (name.includes(short) || short.includes(name)) score += 12;
    if (CITY_TYPES.has(type)) score += 10;
    if (osmKey === "place") score += 6;
    if (p.country === "中国" || p.state?.includes(city)) score += 2;
    if (p.extent?.length === 4) score += 2;
    if (!best || score > best.score) {
      best = { score, name, type, center: [lng, lat], osmKey };
    }
  }

  if (!best || best.score < 12) return { error: "Photon 没找到可信的城市中心" };
  return {
    center: [Number(best.center[0].toFixed(4)), Number(best.center[1].toFixed(4))],
    level: best.type,
    resolvedName: best.name,
    source: "photon",
  };
}

async function main() {
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  let cities = citiesFromGuides();
  if (ONLY.length) cities = cities.filter((c) => ONLY.includes(c));
  console.log(`待处理 ${cities.length} 个城市（源：Photon，免 Key）`);

  const result = { ...existing };
  let ok = 0;
  let skipped = 0;
  const failed = [];

  for (const city of cities) {
    if (!force && existing[city]?.center?.length === 2) {
      skipped += 1;
      continue;
    }
    try {
      const info = await lookup(city);
      if (info.error) failed.push([city, info.error]);
      else {
        result[city] = { ...info, provinceLike: PROVINCE_HINT.test(city) };
        ok += 1;
      }
    } catch (error) {
      failed.push([city, error?.message || String(error)]);
    }
    // Photon 公共端点宽松，但 122 城串行还是留一点礼貌间隔
    await new Promise((r) => setTimeout(r, 120));
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  console.log(`完成：新增 ${ok}，已有 ${skipped}，失败 ${failed.length} → ${OUT}`);
  for (const [city, reason] of failed.slice(0, 20)) console.log(`  ✗ ${city}: ${reason}`);
}

main();
