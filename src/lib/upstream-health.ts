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
 */
type Health = {
  /** 连续失败次数；成功一次即清零。 */
  fails: number;
  /** 冷却截止时间戳。 */
  downUntil: number;
};

const globalForHealth = globalThis as typeof globalThis & {
  __manchengUpstreamHealth?: Map<string, Health>;
};

const store =
  globalForHealth.__manchengUpstreamHealth ??
  (globalForHealth.__manchengUpstreamHealth = new Map<string, Health>());

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
  const health = store.get(url);
  if (!health) return false;
  return health.downUntil > now;
}

export function noteEndpointFailure(url: string): void {
  const previous = store.get(url);
  const fails = (previous?.fails ?? 0) + 1;
  store.set(url, { fails, downUntil: Date.now() + cooldownFor(fails) });
}

export function noteEndpointSuccess(url: string): void {
  // 成功就是最强的反证：历史失败记录不该继续影响后面的请求。
  store.delete(url);
}

/**
 * 把健康端点排到前面，冷却中的端点保留但退后。
 *
 * 全部处于冷却时返回原数组（不是空数组）——这是这个模块最重要的一条安全边界：
 * 健康记录只是「猜测」，不能让猜测变成「没有数据源」。
 */
export function orderTargets<T extends { url: string }>(targets: T[]): T[] {
  const now = Date.now();
  const up: T[] = [];
  const down: T[] = [];
  for (const target of targets) {
    if (isEndpointDown(target.url, now)) down.push(target);
    else up.push(target);
  }
  if (!up.length) return targets;
  return [...up, ...down];
}

/** 测试与排障用。 */
export function upstreamHealthSnapshot(): Record<
  string,
  { fails: number; downForMs: number }
> {
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

export function resetUpstreamHealth(): void {
  store.clear();
}
