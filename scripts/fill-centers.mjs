#!/usr/bin/env node
/**
 * 给缺城市中心的 enrichment 包回填权威中心坐标（只读补充，不改景点坐标）。
 * 坐标来源：腾讯地图 POI / 中国主要城市经纬度表（见下方 source 注释）。
 * 只填 center 缺失的文件；已有 center 的一律不动（尊重 agent 的核实结果）。
 *
 * 用法：node scripts/fill-centers.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ENRICH = path.join(ROOT, "data", "knowledge", "enrichment");

// [lng, lat] —— 均为联网核实过的城市/区域代表中心
const CENTERS = {
  南昌: [115.858, 28.682],      // 中国主要城市经纬度表 115°52'E,28°41'N
  南宁: [108.35, 22.78],        // 108°21'E,22°47'N
  重庆: [106.55, 29.55],        // 106°33'E,29°33'N
  洛阳: [112.45, 34.72],        // 112°26'E,34°43'N
  大同: [113.22, 40.12],        // 113°13'E,40°07'N
  秦皇岛: [119.6, 39.94],       // 腾讯地图「秦皇岛市中心」119.600949,39.935088
  千岛湖: [119.078, 29.607],    // 腾讯地图「千岛湖镇」119.078234,29.606922
  峨眉山: [103.486, 29.6],      // 峨眉山市政府：城区中心 103°29'E,29°36'N
  敦煌: [94.662, 40.142],       // 腾讯地图「敦煌市」94.662328,40.142066
  普陀山: [122.391, 30.002],    // 腾讯地图「普陀山风景区」122.391101,30.001892
  蓬莱: [120.829, 37.796],      // 腾讯地图「蓬莱区」120.829141,37.795697
  黔东南: [107.981, 26.566],    // 腾讯地图「凯里市」107.981409,26.5662（黔东南州府）
  川藏: [91.13, 29.65],         // 拉萨代表点（川藏线终点）；区域名，仅作距离防护参考
};

let filled = 0;
let skipped = 0;
for (const [city, center] of Object.entries(CENTERS)) {
  const file = path.join(ENRICH, `${city}.json`);
  if (!fs.existsSync(file)) { console.log(`  · ${city}: 文件还没生成，跳过`); skipped++; continue; }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { console.log(`  ✗ ${city}: JSON 损坏，跳过`); skipped++; continue; }
  if (Array.isArray(doc.center) && doc.center.length === 2) { skipped++; continue; }
  doc.center = center;
  doc.centerSource = "联网核实（腾讯地图/城市经纬度表）";
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
  console.log(`  ✓ ${city}: 补中心 [${center.join(", ")}]`);
  filled++;
}
console.log(`\n回填 ${filled} 个，跳过 ${skipped} 个（已有中心或文件未生成）`);
