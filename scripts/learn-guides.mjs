#!/usr/bin/env node
/**
 * 攻略语料 → 本地城市景点知识库（建模第一步，纯本地不联网）。
 *
 * 输入：
 *   data/guides/g-*.json       130 份解析好的攻略（city / routes / canonicalRouteId）
 *   data/city-centers.json     已有的城市中心（缺失留 null，等 agent 补）
 * 输出：
 *   data/knowledge/index.json                城市清单 + 统计
 *   data/knowledge/cities/<city>.json        每城：必去点 / 全景点聚合 / 路线模板
 *   data/knowledge/enrichment/.gitkeep        agent 上网核实信息的落点目录
 *
 * 用法：node scripts/learn-guides.mjs
 *
 * 设计：必去点取攻略「主推路线」(canonicalRouteId)，保序去重；其余路线聚合为候选池。
 * 联游路线（成都→九寨沟、厦门→武夷山）不并进本地景点，单列 excursion。
 * 主推路线不做联游判断——「故宫」既是景点又是语料里的城市名，误判会丢整条。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const GUIDE_DIR = path.join(ROOT, "data", "guides");
const CENTERS_FILE = path.join(ROOT, "data", "city-centers.json");
const OUT_DIR = path.join(ROOT, "data", "knowledge");
const CITIES_DIR = path.join(OUT_DIR, "cities");
const ENRICH_DIR = path.join(OUT_DIR, "enrichment");

const NOISE =
  /^(各地|当地|酒店|住处|住宿|午餐|晚餐|早餐|午饭|晚饭|用餐|自由活动|返程|出发|集合|入住|退房|温泉|轻轨|地铁|机场|车站|码头|市区|老街|古镇漫步)$/;

function clean(name, city) {
  const n = String(name || "").trim();
  if (!n || n.length < 2 || NOISE.test(n) || n === city) return null;
  if (/^(D\d|第.天)$/.test(n)) return null;
  return n;
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, "_").trim();
}

function readGuides() {
  const files = fs.readdirSync(GUIDE_DIR).filter((f) => /^g-.+\.json$/.test(f));
  const docs = [];
  for (const file of files) {
    try {
      docs.push(JSON.parse(fs.readFileSync(path.join(GUIDE_DIR, file), "utf8")));
    } catch {
      /* 坏文件跳过 */
    }
  }
  const allCities = new Set(
    docs.map((d) => String(d.city || "").trim()).filter(Boolean),
  );

  const byCity = new Map();
  for (const doc of docs) {
    const city = String(doc.city || "").trim();
    if (!city) continue;
    if (!byCity.has(city)) {
      byCity.set(city, {
        city,
        region: doc.region || "",
        aliases: [...new Set((doc.cityAliases || []).map((a) => String(a).trim()).filter(Boolean))],
        guides: [],
        mustMap: new Map(),   // name -> {order, kind}
        placeMap: new Map(),  // name -> {kind, frequency, routes:Set}
        routeTemplates: [],
      });
    }
    const entry = byCity.get(city);
    entry.guides.push({
      id: doc.id,
      source: doc.source || "",
      status: doc.status || "",
      routeCount: (doc.routes || []).length,
    });

    for (const route of doc.routes || []) {
      const days = (route.days || []).map((d) => ({
        day: d.day,
        stops: (d.stops || [])
          .map((s) => ({
            name: clean(s.name, city),
            kind: s.kind || "sight",
          }))
          .filter((s) => s.name),
      }));
      const flat = days.flatMap((d) => d.stops.map((s) => s.name));
      const excursion = flat.some(
        (name) =>
          name !== city &&
          [...allCities].some(
            (c) => c !== city && c.length >= 2 && name.includes(c),
          ),
      );
      const canonical = route.id === doc.canonicalRouteId;
      entry.routeTemplates.push({
        id: `${doc.id}:${route.id}`,
        title: route.title || "未命名路线",
        canonical,
        excursion,
        needsReview: Boolean(route.needsReview),
        days,
      });

      // 主推路线：必去点，保序；其余：候选池（跳过联游）
      if (!canonical && excursion) continue;
      let order = 0;
      for (const day of days) {
        for (const stop of day.stops) {
          if (canonical) {
            if (!entry.mustMap.has(stop.name)) {
              entry.mustMap.set(stop.name, { name: stop.name, kind: stop.kind, order: order++ });
            }
          }
          const p = entry.placeMap.get(stop.name) || {
            name: stop.name,
            kind: stop.kind,
            frequency: 0,
            routes: new Set(),
          };
          p.frequency += 1;
          p.routes.add(canonical ? "主推" : route.title || route.id);
          entry.placeMap.set(stop.name, p);
        }
      }
    }
  }
  return byCity;
}

function main() {
  const centers = fs.existsSync(CENTERS_FILE)
    ? JSON.parse(fs.readFileSync(CENTERS_FILE, "utf8"))
    : {};

  fs.mkdirSync(CITIES_DIR, { recursive: true });
  fs.mkdirSync(ENRICH_DIR, { recursive: true });
  const keep = path.join(ENRICH_DIR, ".gitkeep");
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, "", "utf8");

  const byCity = readGuides();
  const index = [];
  let totalPlaces = 0;
  let totalMust = 0;

  for (const [city, entry] of [...byCity.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"))) {
    const must = [...entry.mustMap.values()].sort((a, b) => a.order - b.order);
    const places = [...entry.placeMap.values()]
      .map((p) => ({
        name: p.name,
        kind: p.kind,
        frequency: p.frequency,
        inMust: entry.mustMap.has(p.name),
        routes: [...p.routes].slice(0, 8),
      }))
      .sort((a, b) => b.frequency - a.frequency || a.name.localeCompare(b.name, "zh"));
    const centerInfo = centers[city];
    const doc = {
      city,
      region: entry.region,
      aliases: entry.aliases,
      center: centerInfo?.center?.length === 2 ? centerInfo.center : null,
      centerSource: centerInfo?.source || (centerInfo?.center ? "existing" : null),
      sources: entry.guides,
      must,
      places,
      routeTemplates: entry.routeTemplates,
      stats: {
        guideCount: entry.guides.length,
        routeCount: entry.routeTemplates.length,
        placeCount: places.length,
        mustCount: must.length,
      },
      enrichmentState: centerInfo?.center?.length === 2 ? "needs-geo" : "needs-center-and-geo",
    };
    fs.writeFileSync(
      path.join(CITIES_DIR, `${safeName(city)}.json`),
      JSON.stringify(doc, null, 2),
      "utf8",
    );
    totalPlaces += places.length;
    totalMust += must.length;
    index.push({
      city,
      region: entry.region,
      center: doc.center,
      mustCount: must.length,
      placeCount: places.length,
      guideCount: entry.guides.length,
      file: `cities/${safeName(city)}.json`,
    });
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "index.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        description: "攻略语料本地知识库：必去点 / 全景点聚合 / 路线模板（坐标与详情待 agent 上网核实）",
        cityCount: index.length,
        placeCount: totalPlaces,
        mustCount: totalMust,
        cities: index,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`建模完成：${index.length} 城，${totalPlaces} 个景点聚合，${totalMust} 个必去点`);
  console.log(`  -> ${path.join(OUT_DIR, "index.json")}`);
  console.log(`  -> ${CITIES_DIR}/<city>.json`);
  const noCenter = index.filter((c) => !c.center).length;
  console.log(`  缺中心坐标 ${noCenter} 城（agent 补或等高德 Key）`);
}

main();
