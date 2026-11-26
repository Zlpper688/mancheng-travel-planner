#!/usr/bin/env node
/**
 * 本地知识库结构回归检查（TDD：建模与核实包必须可审计）。
 *
 * 检查：
 *   1. index.json 存在且统计与城市文件数一致
 *   2. 每个 cities/<city>.json 有 must/places/routeTemplates，必去点非空
 *   3. 每个 enrichment/<city>.json：places 的 key 都在 must 里；
 *      每条 verified 记录经纬度合法、在中国范围、category 合法
 *   4. 经纬度不写反（中国经度 73-135，纬度 18-54）
 *
 * 用法：node scripts/check-knowledge.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const KB = path.join(ROOT, "data", "knowledge");
const CITIES = path.join(KB, "cities");
const ENRICH = path.join(KB, "enrichment");

const VALID_CATEGORIES = new Set([
  "attraction", "museum", "park", "viewpoint", "beach", "street",
  "temple", "market", "nature", "food", "cafe", "hotel", "other",
]);

const errors = [];
const warns = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warns.push(msg);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(`JSON 损坏或无法读取：${path.relative(ROOT, file)} (${e.message})`);
    return null;
  }
}

function main() {
  const indexPath = path.join(KB, "index.json");
  if (!fs.existsSync(indexPath)) {
    fail("缺 data/knowledge/index.json，请先跑 node scripts/learn-guides.mjs");
    report();
    return;
  }
  const index = readJson(indexPath);
  if (!index || !Array.isArray(index.cities)) {
    fail("index.json 格式不正确（缺 cities 数组）");
    report();
    return;
  }

  const cityFiles = fs.readdirSync(CITIES).filter((f) => f.endsWith(".json"));
  const enrichFiles = fs.readdirSync(ENRICH).filter((f) => f.endsWith(".json"));
  console.log(`索引城市 ${index.cities.length}，城市文件 ${cityFiles.length}，核实包 ${enrichFiles.length}`);
  if (index.cityCount !== cityFiles.length) {
    warn(`index.cityCount=${index.cityCount} 与城市文件数 ${cityFiles.length} 不一致`);
  }

  // 每城结构
  for (const item of index.cities) {
    const file = path.join(CITIES, `${item.city}.json`);
    if (!fs.existsSync(file)) { fail(`索引里的城市缺文件：${item.city}`); continue; }
    const doc = readJson(file);
    if (!doc) continue;
    if (!Array.isArray(doc.must)) fail(`${item.city}: 缺 must 数组`);
    else if (doc.must.length === 0) warn(`${item.city}: must 为空`);
    if (!Array.isArray(doc.places)) fail(`${item.city}: 缺 places 数组`);
    if (!Array.isArray(doc.routeTemplates)) fail(`${item.city}: 缺 routeTemplates 数组`);
  }

  // 核实包
  let verifiedTotal = 0;
  let unverifiedTotal = 0;
  for (const file of enrichFiles) {
    const city = file.replace(/\.json$/, "");
    const doc = readJson(path.join(ENRICH, file));
    if (!doc) continue;
    if (!doc.places || typeof doc.places !== "object") { fail(`${city}: 缺 places 对象`); continue; }
    const cityDocFile = path.join(CITIES, `${city}.json`);
    const mustNames = new Set(
      fs.existsSync(cityDocFile)
        ? (readJson(cityDocFile)?.must ?? []).map((m) => m.name)
        : [],
    );
    for (const [key, p] of Object.entries(doc.places)) {
      if (mustNames.size && !mustNames.has(key)) {
        warn(`${city}: places key「${key}」不在 must 列表里`);
      }
      if (p.verified === true) {
        verifiedTotal += 1;
        const { lng, lat } = p;
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
          fail(`${city}/${key}: verified 但坐标不是数字`);
          continue;
        }
        if (lng < 73 || lng > 135) fail(`${city}/${key}: 经度 ${lng} 超出中国范围（疑似纬度经度写反）`);
        if (lat < 18 || lat > 54) fail(`${city}/${key}: 纬度 ${lat} 超出中国范围（疑似纬度经度写反）`);
        if (p.category && !VALID_CATEGORIES.has(p.category)) {
          fail(`${city}/${key}: 非法 category「${p.category}」`);
        }
      }
    }
    unverifiedTotal += (doc.unverified ?? []).length;
  }

  console.log(`已核实坐标 ${verifiedTotal} 个，明确留白 ${unverifiedTotal} 个`);
  report();
}

function report() {
  console.log("");
  for (const w of warns) console.log(`  ⚠ ${w}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  if (errors.length) {
    console.log(`\n失败：${errors.length} 个错误，${warns.length} 个警告`);
    process.exit(1);
  }
  console.log(`\n通过：0 错误，${warns.length} 个警告`);
}

main();
