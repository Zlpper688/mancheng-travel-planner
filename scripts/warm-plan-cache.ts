/**
 * 预热规划缓存：把常用城市的「发现」结果算好落到 MC_WARM_DIR（默认 data/warm/plan-warm/），
 * 用户第一次点生成时直接读盘（实测 13.6s → 8ms），而不是现打一轮外部地图。
 *
 * 跑法：
 *   npx tsx scripts/warm-plan-cache.ts                 # 内置 6 座常用城市，默认参数
 *   npx tsx scripts/warm-plan-cache.ts 成都 杭州        # 只预热指定城市
 *   npx tsx scripts/warm-plan-cache.ts --days 2,3,4     # 多预热几档天数
 *
 * 为什么只预热「默认参数」：缓存键里含天数与风格，而天数和风格会改变搜索半径
 * （`discoverRadius`），半径不同就是另一份候选池。全组合会指数膨胀，
 * 所以只覆盖最常被点的那一档，其余组合交给 stale-while-revalidate 兜。
 */
import { QUICK_CITIES } from "../src/lib/constants";
import { refinePlan } from "../src/lib/plan/refine";
import { warmCacheStats } from "../src/lib/plan/warm-cache";
import { cacheRoot, diskCacheStats } from "../src/lib/disk-cache";
import path from "node:path";
import type { StyleId, TripInput } from "../src/lib/types";

/** 与 PlannerApp 的初始 state 保持一致，这样预热出来的键正好对上首屏那一单。 */
const DEFAULT_STYLES: StyleId[] = ["citywalk", "coastal"];
/** 跟着 cacheRoot() 走：`MC_CACHE_ROOT` / 仓库里的 data/warm/cache 都能生效。 */
const routeDir = () => path.join(cacheRoot(), "route");

function parseDays(argv: string[]): number[] {
  const index = argv.indexOf("--days");
  if (index < 0) return [3];
  const raw = argv[index + 1] ?? "";
  const days = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 10);
  return days.length ? days : [3];
}

function inputFor(city: (typeof QUICK_CITIES)[number], days: number): TripInput {
  return {
    city: city.name,
    center: [city.lng, city.lat],
    days,
    // 日期只影响天气与节假日，不进发现阶段的缓存键；给个稳定值即可。
    date: "2026-12-05",
    pace: "balanced",
    styles: DEFAULT_STYLES,
    transport: "auto",
    budgetTier: "comfort",
    adults: 2,
    children: 0,
    seed: 42,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const dayOptions = parseDays(argv);
  const named = argv.filter((arg) => !arg.startsWith("--") && !/^\d/.test(arg));
  const targets = named.length
    ? QUICK_CITIES.filter((city) => named.includes(city.name))
    : QUICK_CITIES;

  if (!targets.length) {
    console.error(`没找到要预热的城市。可用：${QUICK_CITIES.map((c) => c.name).join("、")}`);
    process.exitCode = 1;
    return;
  }

  const before = warmCacheStats().count;
  console.log(
    `预热 ${targets.length} 座城市 × ${dayOptions.length} 档天数，风格 ${DEFAULT_STYLES.join("+")}，现有缓存 ${before} 条。\n`,
  );

  let slowest = 0;
  let failed = 0;
  for (const city of targets) {
    for (const days of dayOptions) {
      const started = Date.now();
      const routesBefore = diskCacheStats(routeDir()).count;
      try {
        // 跑整条排线链路，而不是只跑 discover：
        // 用户点「生成」等的是完整行程，光预热候选池只能省掉其中一段，
        // 路线（OSRM）那一大块仍然要现算。
        const result = await refinePlan(inputFor(city, days));
        const ms = Date.now() - started;
        slowest = Math.max(slowest, ms);
        const stops = result.plan.days.reduce((n, day) => n + day.stops.length, 0);
        const newRoutes = diskCacheStats(routeDir()).count - routesBefore;
        // 点位太少说明上游没兜住、靠本地知识库勉强支撑——这种城市要单独提醒。
        const thin = stops < 6;
        if (thin) failed += 1;
        console.log(
          `  ${thin ? "!" : "✓"} ${city.name} ${days} 天  ${String(ms).padStart(6)}ms  天 ${result.plan.days.length} · 点位 ${String(stops).padStart(2)} · 轮次 ${result.rounds} · 新路线 ${String(newRoutes).padStart(3)}${thin ? "  ← 候选池偏薄，上游多半没兜住" : ""}`,
        );
      } catch (error) {
        failed += 1;
        console.log(
          `  ✗ ${city.name} ${days} 天  失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const after = warmCacheStats();
  const routes = diskCacheStats(routeDir());
  console.log(
    `\n完成：候选池缓存 ${before} → ${after.count} 条 @ ${after.dir}\n      路线缓存共 ${routes.count} 条 @ ${routes.dir}\n最慢一次 ${(slowest / 1000).toFixed(1)}s；用户首屏从此走磁盘，约 10ms 量级。`,
  );
  if (failed) {
    console.log(
      `注意：有 ${failed} 组候选池偏薄（点位 < 6）。上游地图没兜住时靠本地知识库支撑，\n      行程仍然可用，但可选点位比预热好的城市少；配置高德 Key 可以补上。`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
