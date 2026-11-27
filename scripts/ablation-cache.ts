/**
 * 缓存消融实验：把「磁盘缓存」当作唯一变量，量它到底省了多少时间、有没有伤到质量。
 *
 * 为什么这么设计：第一版消融是拿「跳过 Photon / 跳过 Wikidata」当变量，
 * 结论是**三个变体的质量完全一样、耗时差异全被网络噪声淹没**——那不是实验，
 * 那是掷骰子。真正稳定可复现的变量只有一个：缓存里有没有数据。
 *
 * 对照组（同一进程、同一批输入，唯一差别是缓存目录空不空）：
 *   A 冷：缓存目录清空 → 等价于「服务刚部署、用户第一次点生成」
 *   B 热：紧接着再跑一遍 → 等价于「预热过 / 之前有人点过」
 *
 * 同时记录质量指标（天数、点位数、P0/P1 数、refine 轮次），用来证明
 * 「加速」不是靠少给数据换来的。
 *
 * 跑法：
 *   npx tsx scripts/ablation-cache.ts                # 内置 5 座城市
 *   npx tsx scripts/ablation-cache.ts 成都 青岛
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QUICK_CITIES } from "../src/lib/constants";
import { clearDiskCache } from "../src/lib/disk-cache";
import type { TripInput } from "../src/lib/types";

/** 实验用独立缓存根目录，绝不碰生产用的 .cache/。 */
const ABLATION_ROOT = join(process.cwd(), ".cache-ablation");

function loadEnv(): void {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const hit = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (hit && !process.env[hit[1]]) {
      process.env[hit[1]] = hit[2].replace(/^["']|["']$/g, "");
    }
  }
}

function inputFor(city: (typeof QUICK_CITIES)[number]): TripInput {
  return {
    city: city.name,
    center: [city.lng, city.lat],
    days: 3,
    date: "2026-12-05",
    pace: "balanced",
    styles: ["citywalk", "coastal"],
    transport: "auto",
    budgetTier: "comfort",
    adults: 2,
    children: 0,
    seed: 42,
  };
}

interface Row {
  city: string;
  coldMs: number;
  warmMs: number;
  coldStops: number;
  warmStops: number;
  coldIssues: number;
  warmIssues: number;
  coldP0: number;
  warmP0: number;
  coldRounds: number;
  warmRounds: number;
}

async function main() {
  loadEnv();
  // 必须在 import 业务模块之前设好：缓存目录在模块初始化时读一次。
  process.env.MC_CACHE_ROOT = ABLATION_ROOT;
  // 起始状态必须是「缓存全空」，否则「冷」那一组根本不冷，实验就没意义。
  // 只清 .json，不整目录递归删。
  for (const sub of ["plan-warm", "route"]) {
    clearDiskCache(join(ABLATION_ROOT, sub));
  }

  const { refinePlan } = await import("../src/lib/plan/refine");

  const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const targets = argv.length
    ? QUICK_CITIES.filter((c) => argv.includes(c.name))
    : QUICK_CITIES.filter((c) => c.name !== "北京");

  const rows: Row[] = [];
  for (const city of targets) {
    const input = inputFor(city);
    const coldStart = Date.now();
    const cold = await refinePlan(input);
    const coldMs = Date.now() - coldStart;

    const warmStart = Date.now();
    const warm = await refinePlan(input);
    const warmMs = Date.now() - warmStart;

    const stat = (r: typeof cold) => ({
      stops: r.plan.days.reduce((n, d) => n + d.stops.length, 0),
      issues: r.issues.length,
      p0: r.issues.filter((i) => i.level === "P0").length,
      rounds: r.rounds,
    });
    const a = stat(cold);
    const b = stat(warm);
    rows.push({
      city: city.name,
      coldMs,
      warmMs,
      coldStops: a.stops,
      warmStops: b.stops,
      coldIssues: a.issues,
      warmIssues: b.issues,
      coldP0: a.p0,
      warmP0: b.p0,
      coldRounds: a.rounds,
      warmRounds: b.rounds,
    });
    console.log(
      `  ${city.name}  冷 ${(coldMs / 1000).toFixed(1)}s → 热 ${(warmMs / 1000).toFixed(2)}s   点位 ${a.stops}/${b.stops} · P0 ${a.p0}/${b.p0} · 轮次 ${a.rounds}/${b.rounds}`,
    );
  }

  const sum = (pick: (r: Row) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const coldTotal = sum((r) => r.coldMs);
  const warmTotal = sum((r) => r.warmMs);
  const speedup = warmTotal > 0 ? coldTotal / warmTotal : 0;

  console.log("\n──────── 汇总 ────────");
  console.log(
    `耗时  冷 ${(coldTotal / 1000).toFixed(1)}s  →  热 ${(warmTotal / 1000).toFixed(1)}s   加速 ${speedup.toFixed(1)}×`,
  );
  console.log(
    `点位  冷 ${sum((r) => r.coldStops)}  →  热 ${sum((r) => r.warmStops)}`,
  );
  console.log(
    `P0    冷 ${sum((r) => r.coldP0)}  →  热 ${sum((r) => r.warmP0)}`,
  );
  console.log(
    `轮次  冷 ${sum((r) => r.coldRounds)}  →  热 ${sum((r) => r.warmRounds)}`,
  );

  // 质量判据：缓存只能改「多久拿到」，不能改「拿到什么」。
  const stopsSame = rows.every((r) => r.coldStops === r.warmStops);
  const p0NotWorse = rows.every((r) => r.warmP0 <= r.coldP0);
  const roundsSame = rows.every((r) => r.coldRounds === r.warmRounds);
  console.log("\n──────── 质量判据 ────────");
  console.log(`  点位数完全一致：${stopsSame ? "是" : "否 ← 缓存改变了结果，必须查"}`);
  console.log(`  P0 没有变多：   ${p0NotWorse ? "是" : "否 ← 缓存让质量变差了，必须查"}`);
  console.log(`  refine 轮次一致：${roundsSame ? "是" : "否（多半是首轮候选池不同，需人工确认）"}`);

  // 清场只删 .json，不整目录 rm：实验目录里有几十个文件，整目录删除会被
  // 安全策略拦下（也确实不该让实验脚本拿到无差别递归删除的权限）。
  for (const sub of ["plan-warm", "route"]) {
    clearDiskCache(join(ABLATION_ROOT, sub));
  }
  if (!stopsSame || !p0NotWorse) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
