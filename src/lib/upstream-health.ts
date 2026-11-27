/**
 * 上游端点健康记忆（熔断器）。
 *
 * 起因（实测数据，2026-11-27）：overpass-api.de 在本机网络下 40 秒无响应，
 * 而镜像 maps.mail.ru 7.7 秒就返回同样 60 条点位。原实现固定「主站先试 6s 超时、
 * 失败再换镜像」，于是**每个冷启动请求都要为一个已知死掉的端点白等 6 秒**。
 *
 * 这里只做一件很小的事：记住「谁刚挂过」，把它排到队尾。
 *
 * 刻意不做的三件事：
 * 1. **不删端点**。熔断只改顺序，候选列表长度不变——否则一次网络抖动会永久少一个数据源。
 * 2. **不返回空**。全部端点都在冷却时退回原顺序，宁可多等一次超时也不要断流。
 * 3. **不按状态码细分**。超时、5xx、连接重置对这个场景是同一件事：这次没拿到数据。
 *
 * 为什么要落盘（2026-11-27 补）：
 * 最初只存在 globalThis 里，于是「overpass-api.de 已经死了」这条结论**每个新进程都要重学一遍**。
 * Next.js 每次重启、每个 worker 都是新进程，代价就是每个冷请求白等 6 秒。
 * 知识应该只学一次。落盘后，重启后的第一个请求就直接走镜像。
 */
import path from "node:path";
import { cacheRoot, readDiskJson, writeDiskJson } from "./disk-cache";

type Health = {
  /** 连续失败次数；成功一次即清零。 */
  fails: number;
  /** 冷却截止时间戳。 */
  downUntil: number;
};

/** 落盘目录与文件名。键要过 disk-cache 的白名单，只用小写字母和连字符。 */
const HEALTH_KEY = "upstream-health";
function healthDir(): string {
  return path.join(cacheRoot(), "health");
}

const globalForHealth = globalThis as typeof globalThis & {
  __manchengUpstreamHealth?: Map<string, Health>;
  /** 是否已经从磁盘加载过；每个进程只加载一次。 */
  __manchengUpstreamHealthLoaded?: boolean;
};

const store =
  globalForHealth.__manchengUpstreamHealth ??
  (globalForHealth.__manchengUpstreamHealth = new Map<string, Health>());

/**
 * 从磁盘恢复健康记录。每个进程只做一次，之后是纯内存操作。
 * 过期的记录直接丢掉：一条「两小时前挂过」的记录对现在没有指导意义。
 */
function ensureLoaded(now = Date.now()): void {
  if (globalForHealth.__manchengUpstreamHealthLoaded) return;
  globalForHealth.__manchengUpstreamHealthLoaded = true;
  const saved = readDiskJson<Record<string, Health>>(healthDir(), HEALTH_KEY, 24 * 60 * 60 * 1000);
  if (!saved) return;
  for (const [url, health] of Object.entries(saved)) {
    if (!health || typeof health.downUntil !== "number") continue;
    // 冷却已过期、且失败次数是首次级别 —— 这条记录已经没用了，不恢复。
    if (health.downUntil <= now) continue;
    store.set(url, { fails: health.fails ?? 1, downUntil: health.downUntil });
  }
}

/** 把当前内存状态写回磁盘。永不抛错（writeDiskJson 自己兜住）。 */
function persist(): void {
  const payload: Record<string, Health> = {};
  for (const [url, health] of store) payload[url] = health;
  writeDiskJson(healthDir(), HEALTH_KEY, payload);
}

/**
 * 按失败次数递进的冷却时长。
 *
 * 首次只关 2 分钟：单次失败很可能是瞬时抖动，关太久会白白错过一个健康端点。
 * 连续失败才说明真的不可达，逐级拉长到 30 分钟封顶。
 */
const COOLDOWN_MS = [0, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const MAX_COOLDOWN_MS = 60 * 60_000;

function cooldownFor(fails: number): number {
  const index = Math.min(Math.max(fails, 0), COOLDOWN_MS.length - 1);
  return Math.min(COOLDOWN_MS[index], MAX_COOLDOWN_MS);
}

export function isEndpointDown(url: string, now = Date.now()): boolean {
  ensureLoaded(now);
  const health = store.get(url);
  if (!health) return false;
  return health.downUntil > now;
}

export function noteEndpointFailure(url: string): void {
  ensureLoaded();
  const previous = store.get(url);
  const fails = (previous?.fails ?? 0) + 1;
  store.set(url, { fails, downUntil: Date.now() + cooldownFor(fails) });
  persist();
}

export function noteEndpointSuccess(url: string): void {
  ensureLoaded();
  // 成功就是最强的反证：历史失败记录不该继续影响后面的请求。
  if (store.delete(url)) persist();
}

/**
 * 把健康端点排到前面，冷却中的端点保留但退后。
 *
 * 全部处于冷却时返回原数组（不是空数组）——这是这个模块最重要的一条安全边界：
 * 健康记录只是「猜测」，不能让猜测变成「没有数据源」。
 */
export function orderTargets<T extends { url: string }>(targets: T[]): T[] {
  const now = Date.now();
  ensureLoaded(now);
  const up: T[] = [];
  const down: T[] = [];
  for (const target of targets) {
    if (isEndpointDown(target.url, now)) down.push(target);
    else up.push(target);
  }
  if (!up.length) return targets;
  return [...up, ...down];
}

/**
 * 所有给定端点是否都在冷却中。
 *
 * 用途与 `orderTargets` 不同，别混用：
 * - `orderTargets` 用于**关键数据源**，全故障时退回原顺序（宁可多试一次也不断流）。
 * - 这个函数用于**可选补充源**（比如餐饮点位）：既然注定拿不到，就别让用户
 *   为它白等一次超时。实测餐饮查询在主站死掉时每个冷请求固定烧 5s，返回的永远是空。
 */
export function allEndpointsDown(urls: string[], now = Date.now()): boolean {
  if (!urls.length) return false;
  ensureLoaded(now);
  return urls.every((url) => isEndpointDown(url, now));
}

/** 测试与排障用。 */
export function upstreamHealthSnapshot(): Record<
  string,
  { fails: number; downForMs: number }
> {
  ensureLoaded();
  const now = Date.now();
  const result: Record<string, { fails: number; downForMs: number }> = {};
  for (const [url, health] of store) {
    result[url] = {
      fails: health.fails,
      downForMs: Math.max(0, health.downUntil - now),
    };
  }
  return result;
}

/** 清空内存**和**磁盘。测试之间要彻底隔离时用这个。 */
export function resetUpstreamHealth(): void {
  store.clear();
  globalForHealth.__manchengUpstreamHealthLoaded = true;
  persist();
}

/** 只清内存，保留磁盘。用来在测试里模拟「进程重启」。 */
export function forgetUpstreamHealthMemory(): void {
  store.clear();
  globalForHealth.__manchengUpstreamHealthLoaded = false;
}

/** 强制从磁盘重新加载（模拟重启后的首次访问）。 */
export function reloadUpstreamHealth(): void {
  store.clear();
  globalForHealth.__manchengUpstreamHealthLoaded = false;
  ensureLoaded();
}
