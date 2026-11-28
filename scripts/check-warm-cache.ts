/**
 * 规划预热缓存回归。
 *
 * 跑法：npx tsx scripts/check-warm-cache.ts
 *
 * 第 4 项是这套测试里最要紧的一条：它不测缓存本身，而是守「缓存键里可以省掉
 * days / styles」这个**前提**。省掉它们让命中率从「换风格就重算 9 秒」变成
 * 「换风格照样 10 毫秒」，代价是这个前提必须一直成立——所以这里扫 provider
 * 源码，一旦有人开始读这两个字段就变红。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  warmCacheDir,
  warmKeyOf,
  readWarmCache,
  readWarmCacheEntry,
  writeWarmCache,
} from "../src/lib/plan/warm-cache";
import type { DiscoverResult } from "../src/lib/providers/types";

const root = process.cwd();

// 写到临时目录，别往仓库里丢探测文件。
// data/warm/plan-warm 是随仓库分发的演示预热包，这个脚本以前会把
// "预热探针" 真的写进去（跑一次就多一个 untracked json）。
process.env.MC_WARM_DIR = path.join(
  process.env.TEMP ?? process.env.TMPDIR ?? root,
  `mc-check-warm-${process.pid}`,
);
const PROVIDER_DIR = path.join(root, "src", "lib", "providers");

const base = {
  provider: "open",
  city: "成都",
  center: [104.066, 30.657] as [number, number],
  hotel: [104.066, 30.657] as [number, number],
  radiusKm: 17,
};

/** 递归收集 provider 目录下的 .ts（不含 .d.ts）。目录不存在时返回空，交给反空转断言报错。 */
function collectSources(dir: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 路径写错时不要在这里抛 ENOENT——那样「红在别处」，会掩盖反空转断言到底有没有生效。
    return [];
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectSources(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

function main() {
  console.log("1) 缓存键对同一规划输入稳定，且区分真正影响查询的字段");
  const key = warmKeyOf(base);
  assert.equal(key, warmKeyOf(base));
  assert.notEqual(key, warmKeyOf({ ...base, radiusKm: 20 }), "半径变了必须换键");
  assert.notEqual(
    key,
    warmKeyOf({ ...base, center: [104.1, 30.7] }),
    "中心变了必须换键",
  );
  assert.notEqual(
    key,
    warmKeyOf({ ...base, hotel: [104.1, 30.7] }),
    "落脚点变了必须换键（amap 围着它搜餐饮）",
  );
  assert.notEqual(key, warmKeyOf({ ...base, city: "杭州" }), "城市变了必须换键");
  assert.notEqual(key, warmKeyOf({ ...base, provider: "amap" }), "数据源变了必须换键");
  assert.match(key, /^[a-f0-9]{16}$/);
  console.log(`  ✓ ${key} 稳定且区分 radius/center/hotel/city/provider`);

  console.log("2) days / styles 不进键——因为没有任何 provider 读它们");
  const withExtras = { ...base, days: 5, styles: ["foodie"] } as typeof base;
  assert.equal(
    warmKeyOf(withExtras),
    key,
    "days/styles 不应改变键：它们只通过 radiusKm 影响查询，半径已在键里",
  );
  console.log("  ✓ 同半径换风格/天数仍命中同一条缓存");

  console.log("3) 空目录读缓存返回 null");
  const probeKey = `probe-${Date.now()}`;
  assert.equal(readWarmCache(probeKey), null);
  assert.equal(readWarmCacheEntry(probeKey), null);
  console.log("  ✓ miss 返回 null");

  console.log("4) 守卫：provider 源码里没人读 options.days / options.styles");
  const sources = collectSources(PROVIDER_DIR);
  // 反空转：扫不到文件时「没有违规」和「什么都没扫」长得一模一样。
  assert.ok(
    sources.length >= 5,
    `只扫到 ${sources.length} 个 provider 文件，扫描路径可能写错了：${PROVIDER_DIR}`,
  );
  const bodies = sources.map((file) => ({ file, text: readFileSync(file, "utf8") }));

  // 正例控制：确认正则真的能在这些文件里命中——用 provider 一定读的 radiusKm 自检。
  const positiveControl = bodies.filter((item) => /options\.radiusKm/.test(item.text));
  assert.ok(
    positiveControl.length >= 1,
    "自检失败：连 options.radiusKm 都搜不到，说明扫描或正则坏了，「没违规」不可信",
  );

  const offenders = bodies.filter((item) =>
    /options\.(days|styles)\b/.test(item.text),
  );
  assert.deepEqual(
    offenders.map((item) => path.relative(root, item.file)),
    [],
    "有 provider 开始读 options.days / options.styles 了：请把它们加回 warmKeyOf 的键里，" +
      "否则会命中另一套参数算出来的候选池",
  );
  console.log(
    `  ✓ 扫了 ${sources.length} 个文件，正例命中 ${positiveControl.length} 个，违规 0 个`,
  );

  console.log("5) 写入后可原样读回");
  const fake: DiscoverResult = {
    sights: [
      {
        id: "warm-probe",
        name: "预热探针景点",
        category: "attraction",
        lat: 30.65,
        lng: 104.07,
        source: "osm",
        city: "成都",
      },
    ],
    meals: [],
    notes: ["预热探针"],
    source: "open",
    sourceNote: "预热缓存",
  };
  writeWarmCache(probeKey, fake);
  const hit = readWarmCache(probeKey);
  assert.ok(hit, "应命中缓存");
  assert.equal(hit.sights[0].name, "预热探针景点");
  assert.equal(hit.notes?.[0], "预热探针");
  console.log("  ✓ 命中且内容一致");

  console.log("6) 空结果不落盘（一次网络抖动不该钉死一周）");
  const emptyKey = `empty-${Date.now()}`;
  writeWarmCache(emptyKey, { ...fake, sights: [] });
  assert.equal(readWarmCache(emptyKey), null, "空景点列表必须拒绝写入");
  console.log("  ✓ 空结果被拒写");

  console.log("7) 非法键不落盘也不读（挡路径穿越）");
  const evilKey = "../../etc/passwd";
  writeWarmCache(evilKey, fake);
  assert.equal(readWarmCache(evilKey), null);
  assert.equal(readWarmCacheEntry(evilKey), null);
  console.log("  ✓ 非法键被忽略");

  // 断言「写到当前解析出来的目录」，而不是自己拼一条路径：
  // 目录优先级改过一次（多了 data/warm/plan-warm），拼路径的写法当场失配。
  const cacheDir = warmCacheDir();
  assert.ok(existsSync(cacheDir), `缓存目录应存在：${cacheDir}`);
  console.log("  ✓ 缓存落在 " + path.relative(root, cacheDir));

  console.log("\n通过：键契约 + 守卫 + 读写往返 + 拒写空结果 + 拒写非法键");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
