/**
 * 持久化缓存的通用层回归。
 *
 * 背景：`cache.ts` 的 `cached()` 是进程内 Map，重启即失效。
 * 天气、路线、候选池这三类数据都是「同一输入永远同一结果」的外部查询，
 * 每次重启重问一遍纯属浪费。这里把「内存 + 磁盘」两层封装成一处，
 * 避免每个调用点各写一遍（也就各错一遍）。
 *
 * 跑法：npx tsx scripts/check-persistent-cache.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { clearDiskCache } from "../src/lib/disk-cache";
import {
  forgetPersistentCacheMemory,
  persistentCache,
  persistentCacheStats,
  resetPersistentCache,
} from "../src/lib/persistent-cache";

const ROOT = path.join(process.cwd(), ".cache-persistent-check");
process.env.MC_CACHE_ROOT = ROOT;

const DIR = path.join(ROOT, "probe");

async function main() {
  // 每次从干净目录开始：否则上一轮留下的 probe-a 会让第 1 条直接命中旧值。
  // 只清本测试目录下的 .json，不碰别处。
  clearDiskCache(DIR);
  resetPersistentCache();

  console.log("1) 首次未命中会真的去取，并落盘");
  let loads = 0;
  const first = await persistentCache({
    dir: DIR,
    key: "probe-a",
    ttlMs: 60_000,
    load: async () => {
      loads += 1;
      return { value: 42 };
    },
  });
  assert.equal(first.value, 42);
  assert.equal(loads, 1);
  const files = existsSync(DIR) ? readdirSync(DIR).filter((n) => n.endsWith(".json")) : [];
  assert.equal(files.length, 1, "反空转：必须真的写出缓存文件");
  console.log(`  ✓ 取值成功且落盘（${files.length} 个文件）`);

  console.log("2) 同进程二次访问走内存，不再调用 load");
  const second = await persistentCache({
    dir: DIR,
    key: "probe-a",
    ttlMs: 60_000,
    load: async () => {
      loads += 1;
      return { value: 99 };
    },
  });
  assert.equal(second.value, 42, "应命中缓存，而不是重新 load");
  assert.equal(loads, 1, "load 不该被再次调用");
  console.log("  ✓ 内存命中，load 未被重复调用");

  console.log("3) 模拟重启：清内存后从磁盘恢复，仍然不调用 load");
  forgetPersistentCacheMemory();
  const third = await persistentCache({
    dir: DIR,
    key: "probe-a",
    ttlMs: 60_000,
    load: async () => {
      loads += 1;
      return { value: 7 };
    },
  });
  assert.equal(third.value, 42, "重启后应从磁盘恢复同一结果");
  assert.equal(loads, 1, "重启后也不该重新 load");
  console.log("  ✓ 跨进程命中，未重跑外部请求");

  console.log("4) TTL 过期后重新 load");
  forgetPersistentCacheMemory();
  const expired = await persistentCache({
    dir: DIR,
    key: "probe-a",
    ttlMs: 0,
    load: async () => {
      loads += 1;
      return { value: 123 };
    },
  });
  assert.equal(expired.value, 123, "TTL=0 视为过期，应重新取");
  assert.equal(loads, 2);
  console.log("  ✓ 过期后重取，语义与内存缓存一致");

  console.log("5) 不同 key 互不串味");
  forgetPersistentCacheMemory();
  const other = await persistentCache({
    dir: DIR,
    key: "probe-b",
    ttlMs: 60_000,
    load: async () => ({ value: -1 }),
  });
  assert.equal(other.value, -1);
  console.log("  ✓ 独立键独立取值");

  console.log("6) cacheIf 拒绝时不落盘（避免把一次失败钉死）");
  forgetPersistentCacheMemory();
  const before = persistentCacheStats(DIR).count;
  await persistentCache({
    dir: DIR,
    key: "probe-empty",
    ttlMs: 60_000,
    load: async () => ({ items: [] as number[] }),
    cacheIf: (value) => value.items.length > 0,
  });
  const after = persistentCacheStats(DIR).count;
  assert.equal(after, before, "cacheIf 拒绝的结果不该写进磁盘");
  console.log("  ✓ 空结果不落盘");

  console.log("7) load 抛错时向上抛，且不写脏数据");
  forgetPersistentCacheMemory();
  await assert.rejects(
    persistentCache({
      dir: DIR,
      key: "probe-fail",
      ttlMs: 60_000,
      load: async () => {
        throw new Error("upstream down");
      },
    }),
    /upstream down/,
  );
  console.log("  ✓ 失败原样抛出，不吞错");

  console.log("8) 非法键被拒，不会写到目录外");
  const unsafe = await persistentCache({
    dir: DIR,
    key: "../../etc/passwd",
    ttlMs: 60_000,
    load: async () => ({ value: "x" }),
  });
  assert.equal(unsafe.value, "x", "非法键应退化为「不缓存」，但仍返回结果");
  assert.equal(persistentCacheStats(DIR).count, before, "非法键不该新增文件");
  console.log("  ✓ 非法键退化为纯内存，不越界写盘");

  console.log("9) Map 必须能原样往返（JSON 会把它变成 {}，比没缓存更糟）");
  forgetPersistentCacheMemory();
  await persistentCache({
    dir: DIR,
    key: "probe-map",
    ttlMs: 60_000,
    load: async () => ({
      kind: "forecast" as const,
      days: new Map([["2026-12-05", { mm: 1.2 }]]),
    }),
    serialize: (value) => ({ kind: value.kind, days: [...value.days.entries()] }),
    deserialize: (raw) => {
      const record = raw as { kind: "forecast"; days: [string, { mm: number }][] };
      return { kind: record.kind, days: new Map(record.days) };
    },
  });
  forgetPersistentCacheMemory();
  const restored = await persistentCache({
    dir: DIR,
    key: "probe-map",
    ttlMs: 60_000,
    load: async () => ({ kind: "forecast" as const, days: new Map<string, { mm: number }>() }),
    serialize: (value) => ({ kind: value.kind, days: [...value.days.entries()] }),
    deserialize: (raw) => {
      const record = raw as { kind: "forecast"; days: [string, { mm: number }][] };
      return { kind: record.kind, days: new Map(record.days) };
    },
  });
  assert.equal(restored.days.size, 1, "Map 往返后必须仍有内容");
  assert.equal(restored.days.get("2026-12-05")?.mm, 1.2);
  console.log("  ✓ Map 内容完整往返（未退化成空对象）");

  resetPersistentCache();
  console.log(
    "\n通过：落盘 / 内存命中 / 跨进程命中 / TTL / 键隔离 / cacheIf / 抛错 / 非法键 / Map 往返",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
