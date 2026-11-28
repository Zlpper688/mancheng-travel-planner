/**
 * 发现阶段的磁盘热缓存。
 *
 * 为什么需要它：`src/lib/cache.ts` 的 `cached()` 是进程内 Map，服务一重启就清空，
 * 于是每次冷启动第一单都要重新打一轮外部地图接口（实测 8~55s）。而 discover 的结果
 * 在同一座城市、同一批参数下几乎是常量——它没有理由为每次部署重算一遍。
 *
 * 设计取舍：
 * 1. **同步读写**。调用点就在 discover 热路径上，异步只会多一层 await，没有收益。
 * 2. **失败即降级**。只读文件系统（云端容器）、磁盘满、JSON 损坏，一律当作 miss，
 *    绝不因为缓存坏掉而让整座城市排不出行程。
 * 3. **只缓存非空结果**。上游超时返回空列表时落盘，会让这座城市在 TTL 内一直空着。
 * 4. **TTL + 陈旧命中**。TTL 内直接当新数据用；过期但文件还在时交给调用方做
 *    stale-while-revalidate——先把旧结果顶上，后台再补新的，用户不必等网络。
 *
 * 缓存键只放「provider 真正消费的字段」，这条不变量由
 * `scripts/check-warm-cache.ts` 第 4 项守：它扫 provider 源码，一旦有人开始读
 * `options.days` / `options.styles`，测试立刻变红并提示把字段加回键里。
 */
import { createHash } from "node:crypto";
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
import path from "node:path";
import type { DiscoverResult } from "../providers/types";

/**
 * 缓存键的输入 = provider 实际拿去查外部接口的那几项。
 *
 * 刻意**不含** days / styles：它们只通过 `discoverRadius()` 改变搜索半径，
 * 半径已经在键里；再各放一份只会让「同一份候选池」被拆成好几条缓存。
 * 实测这个差别很实在——只换风格不换半径时，多一个字段就是 10ms 与 9s 的差距。
 */
export interface WarmKeyInput {
  provider: string;
  city: string;
  center: [number, number];
  /** 落脚点。amap 的餐饮检索是围着它转的，不是围着 city center。 */
  hotel: [number, number];
  radiusKm: number;
}

export interface WarmEntry {
  value: DiscoverResult;
  savedAt: number;
  ageMs: number;
}

interface WarmRecord {
  savedAt: number;
  key: string;
  value: DiscoverResult;
}

/**
 * 缓存目录的优先级：
 *   1. `MC_WARM_DIR` —— 显式指定（测试、消融实验）
 *   2. `MC_CACHE_ROOT` —— 整个缓存根换位置
 *   3. `data/warm/` —— **随仓库分发的演示预热包**。答辩电脑换了、断网了，
 *      只要这份文件在，第一次排线也是热的。这是它和 .cache/ 的关键区别：
 *      .cache/ 被 .gitignore 忽略，换台机器就没了。
 *   4. `.cache/plan-warm` —— 本地默认
 */
function cacheDir(): string {
  const explicit = process.env.MC_WARM_DIR?.trim();
  if (explicit) return explicit;
  const root = process.env.MC_CACHE_ROOT?.trim();
  if (root) return path.join(root, "plan-warm");
  const shipped = path.join(process.cwd(), "data", "warm", "plan-warm");
  if (existsSync(shipped)) return shipped;
  return path.join(process.cwd(), ".cache", "plan-warm");
}
/** 景点数据不是行情，一周内不会变；超过一周就转成「陈旧命中」，先顶上再后台刷。 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 上限只用来防目录无限膨胀，正常城市量级远到不了。 */
const MAX_FILES = 200;

/** 键只允许十六进制 + 连字符，顺带挡掉路径穿越。 */
function isSafeKey(key: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(key);
}

export function warmKeyOf(input: WarmKeyInput): string {
  const payload = [
    "warm-v2",
    input.provider,
    input.city,
    input.center[0].toFixed(3),
    input.center[1].toFixed(3),
    input.hotel[0].toFixed(3),
    input.hotel[1].toFixed(3),
    input.radiusKm,
  ].join("|");
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

/**
 * 读缓存条目，**不检查 TTL**——过期与否交给调用方判断。
 * 供 stale-while-revalidate 使用；只需要「新数据」的调用方请用 `readWarmCache`。
 */
export function readWarmCacheEntry(key: string): WarmEntry | null {
  if (!isSafeKey(key)) return null;
  const file = path.join(cacheDir(), `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as WarmRecord;
    if (!record || typeof record.savedAt !== "number") return null;
    if (!record.value || !Array.isArray(record.value.sights)) return null;
    // 空结果不进缓存，但万一历史文件里是空的，当作 miss 处理。
    if (record.value.sights.length === 0) return null;
    return {
      value: record.value,
      savedAt: record.savedAt,
      ageMs: Math.max(0, Date.now() - record.savedAt),
    };
  } catch {
    // 半截写入、JSON 损坏、权限不足——都是 miss，不是错误。
    return null;
  }
}

/** 读 TTL 内的缓存；过期或不存在返回 null。 */
export function readWarmCache(key: string, ttlMs = TTL_MS): DiscoverResult | null {
  const entry = readWarmCacheEntry(key);
  if (!entry) return null;
  if (entry.ageMs > ttlMs) return null;
  return entry.value;
}

/**
 * 落盘。**永不抛错**：缓存是加速手段，不是正确性前提。
 * 空结果（上游超时）直接跳过，避免把一次网络抖动钉死一周。
 */
export function writeWarmCache(key: string, value: DiscoverResult): void {
  if (!isSafeKey(key)) return;
  if (!value || !Array.isArray(value.sights) || value.sights.length === 0) return;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const file = path.join(cacheDir(), `${key}.json`);
    // 先写临时文件再 rename：进程被杀时不会留下半截 JSON 被下次当成有效缓存。
    const tmp = `${file}.${process.pid}.tmp`;
    const record: WarmRecord = { savedAt: Date.now(), key, value };
    writeFileSync(tmp, JSON.stringify(record), "utf8");
    renameSync(tmp, file);
    prune();
  } catch (error) {
    // 只读文件系统（云端容器）下预热缓存失效，只是慢一点，不影响结果。
    if (process.env.MC_WARM_DEBUG) {
      console.error("[warm-cache] 写入失败", error);
    }
  }
}

/** 超过 MAX_FILES 时按 mtime 从旧到新删，只动本目录的 .json。 */
function prune(): void {
  try {
    const files = readdirSync(cacheDir()).filter((name) => name.endsWith(".json"));
    if (files.length <= MAX_FILES) return;
    const stamped = files
      .map((name) => {
        const full = path.join(cacheDir(), name);
        try {
          return { full, mtime: statSync(full).mtimeMs };
        } catch {
          return { full, mtime: 0 };
        }
      })
      .sort((a, b) => a.mtime - b.mtime);
    for (const item of stamped.slice(0, files.length - MAX_FILES)) {
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

/** 给运维/脚本用：当前缓存了多少条、目录在哪。 */
export function warmCacheStats(): { dir: string; count: number } {
  try {
    const count = readdirSync(cacheDir()).filter((name) => name.endsWith(".json")).length;
    return { dir: cacheDir(), count };
  } catch {
    return { dir: cacheDir(), count: 0 };
  }
}
