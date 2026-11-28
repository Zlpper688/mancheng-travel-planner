/**
 * 通用磁盘 KV 缓存：把「同一输入永远同一结果」的外部查询落到磁盘。
 *
 * 为什么不是直接用 `cache.ts` 的 `cached()`：那是进程内 Map，服务一重启就清空。
 * 而景点候选池、两点之间的步行路径这些东西，重启后重新问一遍外部接口纯属浪费——
 * 实测厦门一趟 3 天的排线，光 OSRM 路线就要 10.9s，重启后又得重来一遍。
 *
 * 设计取舍：
 * 1. **同步读写**。调用点都在热路径上，异步只多一层 await。
 * 2. **永不抛错**。只读文件系统、磁盘满、JSON 损坏一律当 miss。
 * 3. **过期不删**。TTL 只决定「算不算新」，文件留着让调用方可以做 stale-while-revalidate。
 * 4. **键要白名单**。只接受 `[a-z0-9_-]`，顺带挡掉路径穿越。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

interface DiskRecord<T> {
  savedAt: number;
  value: T;
}

const KEY_PATTERN = /^[a-z0-9_-]{1,80}$/;

/**
 * 缓存根目录。默认 `.cache/`（跟着 cwd 走）；
 * `MC_CACHE_ROOT` 供消融实验切到独立目录，跑冷/热两组对照而不互相污染。
 */
export function cacheRoot(): string {
  const explicit = process.env.MC_CACHE_ROOT?.trim();
  if (explicit) return explicit;
  // 函数计算 / 托管容器里只有临时目录可写，cwd 通常是只读的。
  // 不认出来也不至于崩（写入本来就 try/catch），但每次请求都白撞一次墙没必要。
  if (isServerless()) return path.join(os.tmpdir(), "mancheng-cache");
  return path.join(process.cwd(), ".cache");
}

/**
 * 随仓库分发的演示缓存目录（`data/warm/cache`），**只读**。
 *
 * 区分「读」和「写」是为了不让运行时把缓存写回版本库：
 * 早先 cacheRoot() 直接返回这个目录，结果开发服务器每跑一次排线，
 * 天气和没查到的路线就多几个 json 文件挂在 git status 里。
 * 现在读的时候先看这里（换台电脑首屏即热），写永远落到 .cache/。
 */
export function shippedCacheRoot(): string | null {
  const shipped = path.join(process.cwd(), "data", "warm", "cache");
  return existsSync(shipped) ? shipped : null;
}

/** 托管环境判定：只用来选一个能写的缓存目录，不参与业务逻辑。 */
function isServerless(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.K_SERVICE ||
      process.env.FUNCTION_TARGET,
  );
}

function isSafeKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function fileFor(dir: string, key: string): string {
  return path.join(dir, `${key}.json`);
}

/**
 * 读一条记录。`ttlMs` 内才算命中；`ttlMs = 0` 表示一律视为过期（用来取陈旧值）。
 * 不存在、损坏、过期都返回 null。
 */
export function readDiskJson<T>(dir: string, key: string, ttlMs: number): T | null {
  if (!isSafeKey(key)) return null;
  const file = fileFor(dir, key);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as DiskRecord<T>;
    if (!record || typeof record.savedAt !== "number") return null;
    // 边界取 `>=`：写和读落在同一毫秒时（CI 上很常见）age 是 0，
    // `0 > 0` 不成立，于是 `ttlMs = 0` 会返回「新鲜」的值——和上面写的
    // 「0 表示一律视为过期」相反，`check-disk-cache` 因此在 CI 里随机红。
    if (Date.now() - record.savedAt >= ttlMs) return null;
    return record.value;
  } catch {
    // 半截写入、JSON 损坏、权限不足——都是 miss，不是错误。
    return null;
  }
}

/** 读一条记录，**不看 TTL**，连 savedAt 一起返回。给 stale-while-revalidate 用。 */
export function readDiskJsonEntry<T>(
  dir: string,
  key: string,
): { value: T; savedAt: number; ageMs: number } | null {
  if (!isSafeKey(key)) return null;
  const file = fileFor(dir, key);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as DiskRecord<T>;
    if (!record || typeof record.savedAt !== "number") return null;
    return {
      value: record.value,
      savedAt: record.savedAt,
      ageMs: Math.max(0, Date.now() - record.savedAt),
    };
  } catch {
    return null;
  }
}

/**
 * 落盘。**永不抛错**。`maxFiles` 传 0 或省略表示不淘汰。
 */
export function writeDiskJson<T>(
  dir: string,
  key: string,
  value: T,
  maxFiles = 0,
): void {
  if (!isSafeKey(key)) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = fileFor(dir, key);
    // 先写临时文件再 rename：进程被杀时不会留下半截 JSON 被下次当成有效缓存。
    const tmp = `${file}.${process.pid}.tmp`;
    const record: DiskRecord<T> = { savedAt: Date.now(), value };
    writeFileSync(tmp, JSON.stringify(record), "utf8");
    renameSync(tmp, file);
    if (maxFiles > 0) pruneDiskDir(dir, maxFiles);
  } catch {
    // 只读文件系统（云端容器）下缓存失效，只是慢一点，不影响结果。
  }
}

/** 超过 maxFiles 时按 mtime 从旧到新删，只动本目录的 .json。 */
export function pruneDiskDir(dir: string, maxFiles: number): void {
  try {
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    if (files.length <= maxFiles) return;
    const stamped = files
      .map((name) => {
        const full = path.join(dir, name);
        try {
          return { full, mtime: statSync(full).mtimeMs };
        } catch {
          return { full, mtime: 0 };
        }
      })
      .sort((a, b) => a.mtime - b.mtime);
    for (const item of stamped.slice(0, files.length - maxFiles)) {
      try {
        unlinkSync(item.full);
      } catch {
        // 删不掉就算了，下一轮还会尝试。
      }
    }
  } catch {
    // 目录读不到时什么都不做。
  }
}

export function diskCacheStats(dir: string): { dir: string; count: number } {
  try {
    const count = readdirSync(dir).filter((name) => name.endsWith(".json")).length;
    return { dir, count };
  } catch {
    return { dir, count: 0 };
  }
}

/** 测试用：清空一个缓存目录。 */
export function clearDiskCache(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        unlinkSync(path.join(dir, name));
      } catch {
        // 忽略
      }
    }
  } catch {
    // 目录不存在就是空的
  }
}
