#!/usr/bin/env node
/**
 * 全城市「必去点位覆盖」审计。
 *
 * 对 data/guides 里每个城市跑一次真实排线（2 天 balanced），
 * 比对攻略主推路线的必去点位，输出：
 *   - docs/city-reports/coverage.md   逐城覆盖表 + 每个缺失点的原因
 *   - 控制台摘要
 *
 * 用法：
 *   node scripts/city-audit.mjs                 # 全量
 *   node scripts/city-audit.mjs --only=成都,杭州
 *   node scripts/city-audit.mjs --days=3 --limit=20
 *   node scripts/city-audit.mjs --base=http://127.0.0.1:3000
 *
 * 前提：data/city-centers.json 已用 scripts/amap-city-centers.mjs 生成。
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};

const ROOT = process.cwd();
const GUIDE_DIR = path.join(ROOT, "data", "guides");
const CENTERS = path.join(ROOT, "data", "city-centers.json");
const OUT_DIR = path.join(ROOT, "docs", "city-reports");
const BASE = arg("base", "http://127.0.0.1:3000");
const DAYS = Number(arg("days", "2"));
const ONLY = arg("only", "").split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(arg("limit", "0"));
const TIMEOUT = Number(arg("timeout", "120000"));

const NOISE =
  /^(各地|当地|酒店|住处|住宿|午餐|晚餐|早餐|午饭|晚饭|用餐|自由活动|返程|出发|集合|入住|退房|温泉|轻轨|地铁|机场|车站|码头|市区|老街|古镇漫步)$/;

function mustLists() {
  const map = new Map();
  for (const file of fs.readdirSync(GUIDE_DIR)) {
    if (!/^g-.+\.json$/.test(file)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(GUIDE_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const city = String(doc.city || "").trim();
    if (!city) continue;
    const entry = map.get(city) || { city, must: [], routes: 0 };
    entry.routes += (doc.routes || []).length;
    for (const route of doc.routes || []) {
      if (route.id !== doc.canonicalRouteId) continue;
      for (const day of route.days || []) {
        for (const stop of day.stops || []) {
          const name = String(stop.name || "").trim();
          if (!name || name.length < 2 || NOISE.test(name) || name === city) continue;
          if (!entry.must.includes(name)) entry.must.push(name);
        }
      }
    }
    map.set(city, entry);
  }
  for (const entry of map.values()) entry.must = entry.must.slice(0, 10);
  return map;
}

function hit(must, names) {
  const target = must.replace(/[（(].*?[)）]/g, "").trim();
  if (target.length < 2) return false;
  return names.some((n) => n.includes(target) || target.includes(n));
}

async function planOnce(city, center) {
  const body = {
    city,
    center,
    days: DAYS,
    date: arg("date", "2026-12-01"),
    pace: "balanced",
    adults: 2,
    children: 0,
    budgetTier: "comfort",
    transport: "auto",
    seed: 42,
  };
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const data = await res.json().catch(() => ({}));
    const ms = Date.now() - started;
    if (data?.error) {
      return { status: data.code || "ERROR", message: data.error, ms };
    }
    const plan = data?.plan;
    if (!plan?.days) return { status: "EMPTY", message: "返回里没有行程", ms };
    const names = [];
    for (const day of plan.days) {
      for (const stop of day.stops || []) {
        if (stop.place?.name) names.push(stop.place.name);
      }
    }
    return { status: "OK", names, ms, notes: plan.meta?.dataNotes || [] };
  } catch (error) {
    return { status: "TIMEOUT", message: error?.message || String(error), ms: Date.now() - started };
  }
}

function reasonFor(result, missing) {
  if (result.status === "OK") return `候选池里没排进来：${missing.join("、")}`;
  if (result.status === "NO_SIGHTS") return "该城市候选池为空（数据源未返回点位），无法排线";
  if (result.status === "TIMEOUT") return "排线超时（数据源无响应）";
  return `${result.status}：${result.message || "未知错误"}`;
}

async function main() {
  if (!fs.existsSync(CENTERS)) {
    console.error("缺少 data/city-centers.json，请先跑：node scripts/amap-city-centers.mjs");
    process.exit(1);
  }
  const centers = JSON.parse(fs.readFileSync(CENTERS, "utf8"));
  const musts = mustLists();

  let cities = [...musts.values()]
    .filter((e) => e.must.length)
    .map((e) => e.city)
    .filter((c) => centers[c]?.center?.length === 2);
  if (ONLY.length) cities = cities.filter((c) => ONLY.includes(c));
  if (LIMIT > 0) cities = cities.slice(0, LIMIT);

  const noCenter = [...musts.keys()].filter(
    (c) => musts.get(c).must.length && centers[c]?.center?.length !== 2,
  );

  console.log(`审计 ${cities.length} 个城市（有坐标），${noCenter.length} 个缺坐标跳过`);
  const rows = [];
  for (const [i, city] of cities.entries()) {
    const must = musts.get(city).must;
    const result = await planOnce(city, centers[city].center);
    const names = result.names || [];
    const covered = must.filter((m) => hit(m, names));
    const missing = must.filter((m) => !hit(m, names));
    rows.push({
      city,
      must: must.length,
      covered: covered.length,
      missing,
      status: result.status,
      ms: result.ms,
      reason: reasonFor(result, missing),
    });
    console.log(
      `${String(i + 1).padStart(3)}/${cities.length} ${city}  ${result.status}  ${covered.length}/${must.length}  ${Math.round(result.ms / 100) / 10}s`,
    );
  }

  const okRows = rows.filter((r) => r.status === "OK");
  const full = okRows.filter((r) => r.missing.length === 0);
  const bad = rows.filter((r) => r.status !== "OK");

  const md = [
    "# 全城市必去点位覆盖审计",
    "",
    `- 执行时间：${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
    `- 参数：${DAYS} 天 / balanced / seed 42`,
    `- 有坐标并参与审计：**${rows.length}** 城；缺坐标跳过：**${noCenter.length}** 城`,
    `- 排线成功：**${okRows.length}**；必去点全覆盖：**${full.length}**；数据源失败：**${bad.length}**`,
    "",
    "## 一、数据源失败的城市（这些城市这次一条候选都没拿到）",
    "",
    bad.length
      ? ["| 城市 | 状态 | 说明 |", "| --- | --- | --- |", ...bad.map((r) => `| ${r.city} | ${r.status} | ${r.reason} |`)].join("\n")
      : "_无_",
    "",
    "## 二、排线成功但仍有缺口",
    "",
    okRows.filter((r) => r.missing.length).length
      ? [
          "| 城市 | 命中 | 缺失点位 |",
          "| --- | --- | --- |",
          ...okRows
            .filter((r) => r.missing.length)
            .sort((a, b) => a.covered / a.must - b.covered / b.must)
            .map((r) => `| ${r.city} | ${r.covered}/${r.must} | ${r.missing.join("、")} |`),
        ].join("\n")
      : "_无_",
    "",
    "## 三、必去点全覆盖",
    "",
    full.length ? full.map((r) => `${r.city}（${r.must}/${r.must}）`).join("、") : "_无_",
    "",
    "## 四、全部结果",
    "",
    "| 城市 | 状态 | 命中 | 用时 | 说明 |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) => `| ${r.city} | ${r.status} | ${r.covered}/${r.must} | ${(r.ms / 1000).toFixed(1)}s | ${r.reason} |`,
    ),
    "",
    noCenter.length ? `## 五、缺坐标未审计\n\n${noCenter.join("、")}\n` : "",
  ].join("\n");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "coverage.md");
  fs.writeFileSync(outFile, md, "utf8");
  console.log(`\n报告：${outFile}`);
  console.log(`成功 ${okRows.length} / 全覆盖 ${full.length} / 数据源失败 ${bad.length}`);
}

main();
