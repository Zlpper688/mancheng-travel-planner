#!/usr/bin/env node
/**
 * 用高德 district 接口，把攻略语料里出现的所有城市补上中心坐标。
 *
 * 产物：data/city-centers.json  { "成都": { "center": [104.066, 30.657], "level": "city", "adcode": "510100" }, ... }
 *
 * 用法：node scripts/amap-city-centers.mjs [--force]
 *   - 默认只补缺失的城市，已有坐标不动
 *   - --force 全部重取
 *   - AMAP_KEY 从 .env.local 读
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "data", "city-centers.json");
const GUIDE_DIR = path.join(ROOT, "data", "guides");

function readEnv(key) {
  for (const file of [".env.local", ".env"]) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return process.env[key]?.trim() || "";
}

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

/** 省级名字（云南/新疆…）没有「市」级中心，取省会所在市中心即可 */
const PROVINCE_HINT = /^(云南|新疆|西藏|广西|青海|甘肃|四川|贵州|华北|华东|华南|东北|西北|西南|川藏)/;

async function lookup(city, key) {
  const url = new URL("https://restapi.amap.com/v3/config/district");
  url.searchParams.set("keywords", city);
  url.searchParams.set("subdistrict", "1");
  url.searchParams.set("extensions", "base");
  url.searchParams.set("key", key);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (data.status !== "1") {
    return { error: `${data.info || "请求失败"}(${data.infocode || ""})` };
  }
  const list = data.districts ?? [];
  if (!list.length) return { error: "未找到" };
  const hit =
    list.find((d) => d.name === city) ||
    list.find((d) => d.name?.startsWith(city)) ||
    list[0];
  const center = String(hit.center || "").split(",").map(Number);
  if (center.length !== 2 || !Number.isFinite(center[0])) {
    return { error: "无中心点" };
  }
  return {
    center: [Number(center[0].toFixed(4)), Number(center[1].toFixed(4))],
    level: hit.level || "",
    adcode: hit.adcode || "",
    name: hit.name || city,
  };
}

async function main() {
  const key = readEnv("AMAP_KEY");
  if (!key) {
    console.error("缺少 AMAP_KEY：请在 .env.local 里填 AMAP_KEY=xxx");
    process.exit(1);
  }
  const force = process.argv.includes("--force");
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  const cities = citiesFromGuides();
  console.log(`攻略语料里共 ${cities.length} 个城市，开始取中心坐标…`);

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
      const info = await lookup(city, key);
      if (info.error) {
        failed.push([city, info.error]);
      } else {
        result[city] = {
          center: info.center,
          level: info.level,
          adcode: info.adcode,
          resolvedName: info.name,
          provinceLike: PROVINCE_HINT.test(city),
        };
        ok += 1;
      }
    } catch (error) {
      failed.push([city, error?.message || String(error)]);
    }
    // 个人 Key 的 QPS 很低，留出余量
    await new Promise((r) => setTimeout(r, 260));
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  console.log(`完成：新增 ${ok}，已有 ${skipped}，失败 ${failed.length} → ${OUT}`);
  for (const [city, reason] of failed.slice(0, 20)) console.log(`  ✗ ${city}: ${reason}`);
}

main();
