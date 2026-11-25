#!/usr/bin/env node
/**
 * 把 data/guides 的攻略语料，按城市整理成「攻略学习报告」。
 *
 * 输入：
 *   - data/guides/g-*.json          解析好的攻略（city / routes / days / stops）
 *   - .engine-runs/<city>.json      可选，引擎实测结果（用于「攻略必去 vs 引擎实排」对照）
 * 输出：
 *   - docs/city-reports/<city>.md   每城一份
 *   - docs/city-reports/README.md   总览
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const GUIDE_DIR = path.join(ROOT, "data", "guides");
const RUN_DIR = path.join(ROOT, ".engine-runs");
const OUT_DIR = path.join(ROOT, "docs", "city-reports");

// 解析噪声：出发地/住宿/餐食/自由活动这类不是「景点」
const NOISE =
  /^(各地|当地|酒店|住处|住宿|午餐|晚餐|早餐|午饭|晚饭|用餐|自由活动|返程|出发|集合|入住|退房|温泉|轻轨|地铁|机场|车站|码头|市区|老街|古镇漫步)$/;
const CITY_LIKE = /^(成都|北京|上海|西安|广州|重庆|杭州|厦门|南京|武汉|长沙|青岛|三亚|丽江|大理|昆明|哈尔滨|大连|沈阳|天津|苏州|无锡|扬州|宁波|合肥|南昌|太原|大同|兰州|拉萨|乌鲁木齐|贵阳|南宁|海口|福州|郑州|济南|石家庄|呼和浩特|银川|西宁)$/;

function clean(name, city) {
  const n = String(name || "").trim();
  if (!n || n.length < 2) return null;
  if (NOISE.test(n)) return null;
  if (CITY_LIKE.test(n) || n === city) return null;
  if (/^(D\d|第.天)$/.test(n)) return null;
  return n;
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
  const allCities = new Set(docs.map((d) => String(d.city || "").trim()).filter(Boolean));
  const byCity = new Map();
  for (const doc of docs) {
    const city = String(doc.city || "").trim();
    if (!city) continue;
    if (!byCity.has(city)) {
      byCity.set(city, {
        city,
        region: doc.region || "",
        sources: [],
        routes: [],
        stops: new Map(),
        mustStops: new Map(),
        mustList: [],
        dayCount: 0,
        status: doc.status || "",
      });
    }
    const entry = byCity.get(city);
    entry.sources.push({ source: doc.source || "", status: doc.status || "", routes: (doc.routes || []).length });
    for (const route of doc.routes || []) {
      const days = (route.days || []).map((d) => ({
        day: d.day,
        stops: (d.stops || []).map((s) => clean(s.name, city)).filter(Boolean),
      }));
      // 攻略里常带「成都→九寨沟」「上海→宏村」这类联游，别把外地景点算成本地必去。
      const flat = days.flatMap((d) => d.stops);
      const excursion = flat.some((name) => name !== city && [...allCities].some((c) => c !== city && c.length >= 2 && name.includes(c)));
      entry.dayCount += days.length;
      entry.routes.push({ title: route.title || "未命名路线", days, canonical: route.id === doc.canonicalRouteId, excursion });
      // 主推路线就是攻略自己的精华推荐，不做联游判断——「故宫」既是景点又是
      // 语料里的城市名，误判会把北京的主推路线整条丢掉。
      // 其余路线可能混着联游（厦门攻略里夹武夷山、北京攻略里夹坝上），才需要过滤。
      const isCanonical = route.id === doc.canonicalRouteId;
      if (!isCanonical && excursion) continue;
      for (const d of days) {
        for (const name of d.stops) {
          if (isCanonical) {
            entry.mustStops.set(name, (entry.mustStops.get(name) || 0) + 1);
            if (!entry.mustList.includes(name)) entry.mustList.push(name);
          } else {
            entry.stops.set(name, (entry.stops.get(name) || 0) + 1);
          }
        }
      }
    }
  }
  return byCity;
}

function readEngineRun(city) {
  const file = path.join(RUN_DIR, `${city}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const plan = data.plan || data;
    if (!plan?.days) return null;
    const names = [];
    for (const day of plan.days) {
      for (const stop of day.stops || []) {
        const n = stop.place?.name;
        if (n) names.push(n);
      }
    }
    return {
      stops: names,
      warnings: plan.warnings || [],
      days: plan.days.length,
    };
  } catch {
    return null;
  }
}

function hit(mustSee, engineNames) {
  const target = mustSee.replace(/[（(].*?[)）]/g, "").trim();
  if (target.length < 2) return false;
  return engineNames.some((n) => n.includes(target) || target.includes(n));
}

function md(entry, run) {
  // 必去清单 = 主推路线里的点位（去重保序）。主推路线解析不出东西时才退回全量频次。
  const primary = entry.mustStops.size >= 2 ? entry.mustStops : entry.stops;
  const mustList = entry.mustList.length >= 2 ? entry.mustList.slice(0, 10) : [...primary.keys()].slice(0, 10);
  const stops = [...primary.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const must = mustList.map((n) => [n, primary.get(n) || 1]);
  const extras = [...entry.stops.entries()].filter(([n]) => !primary.has(n)).sort((a, b) => b[1] - a[1]);
  const lines = [];

  lines.push(`# ${entry.city} · 攻略学习报告`, "");
  lines.push(
    `- 语料：**${entry.sources.length}** 份攻略（${entry.region || "地区未标注"}），解析出 **${entry.routes.length}** 条路线 / **${entry.dayCount}** 个行程日`,
  );
  lines.push(`- 来源：${entry.sources.map((s) => `\`${s.source}\``).join("、") || "—"}`);
  lines.push("");

  lines.push("## 一、必去清单（攻略主推路线里的点位）", "");
  if (!stops.length) {
    lines.push("_这份攻略没有解析出可用点位。_", "");
  } else {
    lines.push("| 顺序 | 点位 |", "| --- | --- |");
    must.forEach(([name], i) => lines.push(`| ${i + 1} | ${name} |`));
    const rest = stops.map(([n]) => n).filter((n) => !mustList.includes(n));
    if (rest.length) {
      lines.push("", `<sub>主推路线里其余点位：${rest.join("、")}</sub>`);
    }
    if (extras.length) {
      lines.push("", `<sub>其他路线还提到（可能含联游，未计入必去）：${extras.slice(0, 14).map(([n]) => n).join("、")}</sub>`);
    }
    lines.push("");
  }

  lines.push("## 二、典型骨架（攻略里的实际走法）", "");
  const seen = new Set();
  let printed = 0;
  for (const route of entry.routes) {
    const key = route.days.map((d) => d.stops.join("-")).join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    printed += 1;
    if (printed > 5) break;
    lines.push(`**${route.days.length} 天${route.canonical ? "（主推）" : ""}${route.excursion ? "（跨城联游，外地景点不计入本地必去）" : ""}**`);
    for (const d of route.days) {
      lines.push(`- D${d.day}：${d.stops.join(" → ") || "（无可解析点位）"}`);
    }
    lines.push("");
  }
  if (!printed) lines.push("_没有可用的行程骨架。_", "");

  lines.push("## 三、引擎对照（本地实测，2 天 balanced）", "");
  if (!run) {
    lines.push("_本次未跑引擎（只对重点城市做了实测）。_", "");
  } else {
    const rows = must.map(([name], i) => {
      const ok = hit(name, run.stops);
      return `| ${name} | ${i + 1} | ${ok ? "✅ 已选中" : "❌ 缺失"} |`;
    });
    const covered = must.filter(([name]) => hit(name, run.stops)).length;
    lines.push(`命中 **${covered}/${must.length}** 个必去点位。`, "");
    lines.push("| 攻略必去 | 主推顺序 | 引擎 |", "| --- | --- | --- |");
    lines.push(...rows);
    lines.push("", "**引擎实际排出来的点位**：", "", run.stops.map((n) => `\`${n}\``).join("、") || "—");
    if (run.warnings.length) {
      lines.push("", `**提示**：${run.warnings.join("；")}`);
    }
    lines.push("");
    lines.push("## 四、结论", "");
    const missing = must.map(([name]) => name).filter((name) => !hit(name, run.stops));
    if (!missing.length) {
      lines.push("- 必去点全部命中，这份行程对熟悉该城市的人成立。");
    } else {
      lines.push(`- **最大缺口**：${missing.slice(0, 6).join("、")}——这些是攻略里反复出现、本地人/去过的都会提的点，引擎一个都没选。`);
      lines.push("- 原因判断：引擎目前只按距离、类别、开放数据自带的 score 打分，**没有任何「这个城市哪些点是招牌」的知识**；攻略语料正好是这份知识，但还没接进打分。");
      lines.push("- 建议：把本报告的必去清单做成城市名气先验（名称匹配命中即大幅加分），并对商业街区（春熙路、太古里这类 OSM 标成步行街而非景区的点）放宽类别过滤。");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const byCity = readGuides();
  const rows = [];
  for (const [city, entry] of [...byCity.entries()].sort((a, b) => b[1].sources.length - a[1].sources.length || a[0].localeCompare(b[0]))) {
    const run = readEngineRun(city);
    fs.writeFileSync(path.join(OUT_DIR, `${city}.md`), md(entry, run), "utf8");
    const primary = entry.mustStops.size >= 2 ? entry.mustStops : entry.stops;
    const mustList = entry.mustList.length >= 2 ? entry.mustList.slice(0, 10) : [...primary.keys()].slice(0, 10);
    const covered = run ? mustList.filter((n) => hit(n, run.stops)).length : null;
    rows.push({
      city,
      guides: entry.sources.length,
      stops: entry.stops.size,
      top: mustList.slice(0, 3).join("、"),
      coverage: covered === null ? "未实测" : `${covered}/${mustList.length}`,
      tested: Boolean(run),
    });
  }

  const tested = rows.filter((r) => r.tested).sort((a, b) => {
    const pa = Number(a.coverage.split("/")[0]) / Number(a.coverage.split("/")[1] || 1);
    const pb = Number(b.coverage.split("/")[0]) / Number(b.coverage.split("/")[1] || 1);
    return pa - pb;
  });

  const index = [
    "# 城市攻略学习报告 · 总览",
    "",
    `共 **${rows.length}** 个城市，来自 \`data/guides\` 的 ${rows.reduce((s, r) => s + r.guides, 0)} 份攻略。`,
    "",
    "## 已实测城市（必去点命中情况，越靠前越差）",
    "",
    "| 城市 | 语料 | 必去点命中 | 名气最高的几个点 |",
    "| --- | --- | --- | --- |",
    ...tested.map((r) => `| [${r.city}](${encodeURIComponent(r.city)}.md) | ${r.guides} 份 | ${r.coverage} | ${r.top} |`),
    "",
    "## 全部城市",
    "",
    "| 城市 | 攻略 | 去噪后点位数 | 高频点位 | 引擎对照 |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| [${r.city}](${encodeURIComponent(r.city)}.md) | ${r.guides} | ${r.stops} | ${r.top} | ${r.coverage} |`),
    "",
  ].join("\n");

  fs.writeFileSync(path.join(OUT_DIR, "README.md"), index, "utf8");
  console.log(`生成 ${rows.length} 份报告 → ${OUT_DIR}`);
  console.log(`已实测：${tested.map((r) => `${r.city} ${r.coverage}`).join("  ")}`);
}

main();
