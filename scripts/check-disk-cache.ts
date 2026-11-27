/**
 * 通用磁盘 KV 缓存回归。
 *
 * 用途：把「同一输入永远同一结果」的外部查询落到磁盘，进程重启后仍能命中。
 * 目前服务两处：规划预热（discover 候选池）与路径规划（OSRM 每段路线）。
 *
 * 跑法：npx tsx scripts/check-disk-cache.ts
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  clearDiskCache,
  diskCacheStats,
  readDiskJson,
  writeDiskJson,
} from "../src/lib/disk-cache";

const root = process.cwd();
const DIR = path.join(root, ".cache", "kv-probe");

function main() {
  console.log("1) miss 返回 null");
  clearDiskCache(DIR);
  assert.equal(readDiskJson(DIR, "nope", 60_000), null);
  console.log("  ✓ 空目录返回 null");

  console.log("2) 写入后可原样读回（含嵌套结构与数组）");
  const value = { a: 1, b: ["x", "y"], c: { d: true }, geo: [[1.5, 2.5], [3.5, 4.5]] };
  writeDiskJson(DIR, "roundtrip", value);
  assert.deepEqual(readDiskJson(DIR, "roundtrip", 60_000), value);
  console.log("  ✓ 往返一致");

  console.log("3) 过期返回 null，但文件仍在（供 stale 使用）");
  assert.equal(readDiskJson(DIR, "roundtrip", 0), null, "TTL=0 应当过期");
  assert.ok(existsSync(path.join(DIR, "roundtrip.json")), "过期不等于删除");
  console.log("  ✓ TTL 生效且不删文件");

  console.log("4) 非法键既不写也不读（挡路径穿越）");
  for (const evil of ["../../etc/passwd", "a/b", "", "x".repeat(200)]) {
    writeDiskJson(DIR, evil, value);
    assert.equal(readDiskJson(DIR, evil, 60_000), null, `非法键应被忽略：${evil}`);
  }
  console.log("  ✓ 非法键被忽略");

  console.log("5) 损坏的 JSON 当作 miss，不抛错");
  writeDiskJson(DIR, "broken", value);
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(path.join(DIR, "broken.json"), "{ not json", "utf8");
  assert.equal(readDiskJson(DIR, "broken", 60_000), null);
  console.log("  ✓ 损坏文件降级为 miss");

  console.log("6) 超上限按最旧淘汰");
  for (let i = 0; i < 8; i++) writeDiskJson(DIR, `k${i}`, { i }, 3);
  const stats = diskCacheStats(DIR);
  assert.ok(stats.count <= 3, `上限 3，实际 ${stats.count}`);
  console.log(`  ✓ 只保留 ${stats.count} 条`);

  console.log("7) 只读/不存在目录下写入不抛错");
  const readOnly = path.join(root, ".cache", "kv-probe-ro");
  assert.doesNotThrow(() => writeDiskJson(readOnly, "x", value));
  console.log("  ✓ 写入永不抛错");

  clearDiskCache(DIR);
  clearDiskCache(readOnly);
  console.log("\n通过：往返 / TTL / 非法键 / 损坏降级 / 淘汰 / 永不抛错");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
