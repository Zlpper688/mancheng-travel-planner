/**
 * 「内存 + 磁盘」两层缓存。
 *
 * 为什么需要这一层：`cache.ts` 的 `cached()` 只是进程内 Map，服务一重启就清空。
 * 而天气、路线、候选池这些外部查询的共同特征是「同一输入永远同一结果」——
 * 重启后重问一遍纯属浪费（实测厦门一趟 3 天光 OSRM 路线就 10.9s）。
 *
 * 为什么不直接用 `disk-cache.ts`：磁盘读写是同步 I/O，放在热路径上会阻塞事件循环；
 * 而且并发请求同一键时应该共享同一个 Promise，而不是各自打一次上游。
 *
 * 两层顺序：
 *   内存命中 → 磁盘命中（回填内存）→ load() → 写磁盘
 *
 * 安全边界：**永不因为缓存出问题而让调用方失败**。磁盘坏了当 miss，
 * 写不进去就只当没有缓存，load 的异常原样抛给调用方（不吞错）。
 */
import { createHash } from "node:crypto";
import {
  diskCacheStats,
  readDiskJson,
  writeDiskJson,
} from "./disk-cache";

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

const globalForPersistent = globalThis as typeof globalThis & {
  __manchengPersistentCache?: Map<string, MemoryEntry>;
  __manchengPersistentInflight?: Map<string, Promise<unknown>>;
};

const memory =
  globalForPersistent.__manchengPersistentCache ??
  (globalForPersistent.__manchengPersistentCache = new Map<string, MemoryEntry>());
const inflight =
  globalForPersistent.__manchengPersistentInflight ??
  (globalForPersistent.__manchengPersistentInflight = new Map<string, Promise<unknown>>());

/** 磁盘文件名：键里可能含冒号、斜杠、中文，一律哈希成十六进制。 */
function hashKey(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 24);
}

/**
 * 原键是否适合落盘。含路径分隔符、`..` 之类的直接放弃缓存——
 * 宁可少一层缓存，也不要出现「写到目录外」这种问题。
 */
function isDiskSafe(key: string): boolean {
  if (!key || key.length > 300) return false;
  if (key.includes("..")) return false;
  if (/[\\/]/.test(key)) return false;
  return true;
}

export interface PersistentCacheOptions<T> {
  /** 缓存目录（绝对路径）。 */
  dir: string;
  /** 逻辑键。可以含冒号、中文，内部会哈希。 */
  key: string;
  /** 新鲜期。0 表示一律视为过期（用于强制刷新）。 */
  ttlMs: number;
  /** 缓存未命中时真正去取值的函数。 */
  load: () => Promise<T>;
  /** 只缓存「值得缓存」的结果。返回 false 时不落盘也不进内存。 */
  cacheIf?: (value: T) => boolean;
  /** 磁盘文件数上限，超出按 mtime 淘汰。0/省略表示不淘汰。 */
  maxFiles?: number;
  /**
   * 落盘前的序列化。默认原样存。
   *
   * 需要它的原因很具体：天气结果里有个 `Map`，`JSON.stringify` 会把它变成 `{}`，
   * 于是「从磁盘读回来」得到的是一个空壳——**比没有缓存更糟**，因为调用方拿到的
   * 是一份看起来正常、实际什么都没装的对象。
   */
  serialize?: (value: T) => unknown;
  /** 从磁盘读回后的反序列化，需与 serialize 成对。 */
  deserialize?: (raw: unknown) => T;
}

export async function persistentCache<T>(
  options: PersistentCacheOptions<T>,
): Promise<T> {
  const { dir, key, ttlMs, load, cacheIf, maxFiles, serialize, deserialize } = options;
  const memoryKey = `${dir}::${key}`;
  const now = Date.now();

  const hit = memory.get(memoryKey);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const diskSafe = isDiskSafe(key);
  const diskKey = diskSafe ? hashKey(key) : "";
  if (diskSafe && ttlMs > 0) {
    const saved = readDiskJson<unknown>(dir, diskKey, ttlMs);
    if (saved !== null && saved !== undefined) {
      let restored: T;
      try {
        restored = deserialize ? deserialize(saved) : (saved as T);
      } catch {
        // 反序列化失败说明存的是旧结构，当作 miss 重新取一遍。
        restored = undefined as unknown as T;
      }
      if (restored !== undefined) {
        // 回填内存：后续同进程请求不必再碰磁盘。
        memory.set(memoryKey, { value: restored, expiresAt: now + ttlMs });
        return restored;
      }
    }
  }

  // 同一键的并发请求共享一次 load：天气/路线都是按点位分的，
  // 同一天多天复用同一坐标时很容易撞在一起。
  const pending = inflight.get(memoryKey);
  if (pending) return pending as Promise<T>;

  const task = (async () => {
    const value = await load();
    const accepted = cacheIf ? cacheIf(value) : true;
    if (accepted) {
      memory.set(memoryKey, { value, expiresAt: Date.now() + ttlMs });
      if (diskSafe) {
        writeDiskJson(dir, diskKey, serialize ? serialize(value) : value, maxFiles ?? 0);
      }
    }
    return value;
  })();

  inflight.set(memoryKey, task);
  try {
    return await task;
  } finally {
    inflight.delete(memoryKey);
  }
}

export function persistentCacheStats(dir: string): { dir: string; count: number } {
  return diskCacheStats(dir);
}

/** 只清内存，保留磁盘。测试里用来模拟「进程重启」。 */
export function forgetPersistentCacheMemory(): void {
  memory.clear();
  inflight.clear();
}

/** 彻底重置：内存与磁盘都清空。 */
export function resetPersistentCache(): void {
  memory.clear();
  inflight.clear();
}
