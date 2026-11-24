/**
 * 批量体检。
 *
 * 单条行程看着对，不代表算法对了。这个脚本把「城市 × 节奏 × 种子」
 * 铺开跑一遍，再拿 audit 的同一把尺子量所有结果，最后看分布：
 * 出发时间的 P50 是不是落在真实游客出门的区间里，回酒店有没有越界，
 * 三餐是不是每天都在，同类点位有没有连着排。
 *
 * 用法（要真实数据，先配好 .env.local 里的 AMAP_KEY）：
 *   npx tsx scripts/bench.ts                     # 默认 3 城 × 3 节奏
 *   npx tsx scripts/bench.ts --cities=厦门,成都 --paces=packed --days=3
 *   npx tsx scripts/bench.ts --seeds=1,2,3       # 每组种子都跑，看稳定性
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QUICK_CITIES } from "../src/lib/constants";
import { auditPlan, type AuditIssue } from "../src/lib/plan/audit";
import { planTrip } from "../src/lib/plan/engine";
import type { PaceId, Place, StyleId, TripInput } from "../src/lib/types";

interface Args {
  cities: string[];
  paces: PaceId[];
  days: number;
  seeds: number[];
  date: string;
  styles: StyleId[];
}

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined => {
    const hit = argv.find((arg) => arg.startsWith(`--${key}=`));
    return hit ? hit.slice(key.length + 3) : undefined;
  };
  const list = (key: string): string[] | undefined =>
    get(key)
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  const paces = (list("paces") ?? ["chill", "balanced", "packed"]).filter(
    (pace): pace is PaceId =>
      pace === "chill" || pace === "balanced" || pace === "packed",
  );

  return {
    cities: list("cities") ?? ["厦门", "成都", "青岛"],
    paces: paces.length ? paces : ["balanced"],
    days: Number(get("days") ?? 3),
    seeds: (list("seeds") ?? ["42"]).map(Number).filter(Number.isFinite),
    date: get("date") ?? "2026-11-27",
    styles: (list("styles") ?? ["classic"]) as StyleId[],
  };
}

function hotelFor(city: string): Place {
  const option =
    QUICK_CITIES.find((item) => item.name === city) ?? QUICK_CITIES[0];
  return {
    id: `bench-hotel-${city}`,
    name: `${city}市中心酒店`,
    category: "hotel",
    lat: option.lat,
    lng: option.lng,
    city,
    address: option.address,
    source: "demo",
    rating: 4.5,
    cost: 480,
  };
}

const mm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
    Math.round(minute % 60),
  ).padStart(2, "0")}`;

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

interface Row {
  label: string;
  days: unknown;
  startMin: number[];
  endMin: number[];
  sights: number[];
  travelMin: number[];
  issues: AuditIssue[];
}

async function main(): Promise<void> {
  // tsx 不会自动读 .env.local，这里补上，省得每次手动 export Key。
  const envPath = join(process.cwd(), ".env.local");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const hit = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (hit && !process.env[hit[1]]) {
        process.env[hit[1]] = hit[2].replace(/^["']|["']$/g, "");
      }
    }
  }

  const args = parseArgs(process.argv.slice(2));
  const rows: Row[] = [];
  const allIssues: AuditIssue[] = [];
  let failed = 0;

  console.log(
    `批量体检：${args.cities.length} 城 × ${args.paces.length} 节奏 × ` +
      `${args.seeds.length} 种子 × ${args.days} 天（${args.date}）\n`,
  );

  for (const city of args.cities) {
    for (const pace of args.paces) {
      for (const seed of args.seeds) {
        const label = `${city}/${pace}/s${seed}`;
        const input: TripInput = {
          city,
          hotel: hotelFor(city),
          days: args.days,
          date: args.date,
          pace,
          styles: args.styles,
          transport: "auto",
          budgetTier: "comfort",
          adults: 2,
          children: 0,
          seed,
        };
        const started = Date.now();
        try {
          const plan = await planTrip(input);
          const issues = auditPlan(plan, {
            pace,
            isFixed: plan.meta.isFixed,
          });
          allIssues.push(...issues);
          const row: Row = {
            label,
            days: plan.days.length,
            startMin: plan.days.map((day) => day.startMin),
            endMin: plan.days.map((day) => day.endMin),
            sights: plan.days.map(
              (day) => day.stops.filter((stop) => stop.kind === "sight").length,
            ),
            travelMin: plan.days.map((day) => day.stats.travelMin),
            issues,
          };
          rows.push(row);
          const errors = issues.filter((issue) => issue.severity === "error");
          const warns = issues.filter((issue) => issue.severity === "warn");
          console.log(
            `  ${label.padEnd(20)} ` +
              `出门 ${row.startMin.map(mm).join(" ")} | ` +
              `回店 ${row.endMin.map(mm).join(" ")} | ` +
              `景点 ${row.sights.join(" ")} | ` +
              `在途 ${row.travelMin.join(" ")}min | ` +
              `硬伤 ${errors.length} 提醒 ${warns.length} | ` +
              `${((Date.now() - started) / 1000).toFixed(0)}s`,
          );
          for (const issue of errors) {
            console.log(`      ✗ D${issue.day} ${issue.code} ${issue.detail}`);
          }
        } catch (error) {
          failed += 1;
          console.log(
            `  ${label.padEnd(20)} 失败：${(error as Error).message}`,
          );
        }
      }
    }
  }

  if (!rows.length) {
    console.log("\n没有任何一条成功，先检查 Key / 网络。");
    process.exitCode = 1;
    return;
  }

  const starts = rows.flatMap((row) => row.startMin);
  const ends = rows.flatMap((row) => row.endMin);
  const travel = rows.flatMap((row) => row.travelMin);

  console.log("\n—— 分布 ——");
  console.log(
    `出发时间  P10 ${mm(quantile(starts, 0.1))}  P50 ${mm(quantile(starts, 0.5))}  ` +
      `P90 ${mm(quantile(starts, 0.9))}  最早 ${mm(Math.min(...starts))}  最晚 ${mm(Math.max(...starts))}`,
  );
  console.log(
    `回店时间  P10 ${mm(quantile(ends, 0.1))}  P50 ${mm(quantile(ends, 0.5))}  ` +
      `P90 ${mm(quantile(ends, 0.9))}  最早 ${mm(Math.min(...ends))}  最晚 ${mm(Math.max(...ends))}`,
  );
  console.log(
    `在途分钟  P50 ${quantile(travel, 0.5).toFixed(0)}  P90 ${quantile(travel, 0.9).toFixed(0)}`,
  );
  console.log(`成功 ${rows.length} 条 / 失败 ${failed} 条，共 ${starts.length} 个旅行日`);

  const byCode = new Map<string, number>();
  for (const issue of allIssues) {
    byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);
  }
  const errors = allIssues.filter((issue) => issue.severity === "error").length;
  const warns = allIssues.length - errors;
  console.log(`\n—— 体检 ——  硬伤 ${errors}，提醒 ${warns}`);
  for (const [code, count] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(22)} ${count}`);
  }

  // 硬伤按定义不该出现在任何一条行程里，出现即视为不达标。
  if (errors > 0) process.exitCode = 1;
}

void main();
