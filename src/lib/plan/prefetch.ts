/**
 * 投机预热：用户还在选城市的时候，后台先把这座城市的候选池取回来。
 *
 * 为什么这件事值得做：冷启动第一单要打一轮外部地图（实测 14–34s），
 * 而用户在「输入城市 → 看选项 → 点生成」之间通常会停留好几秒。
 * 这段等待本来就在发生，只是现在什么也没做。把它用来预热，
 * 用户点「生成」时缓存已经热了（实测 60ms 量级）。
 *
 * 这是**投机**，不是必须：失败、超时、被丢弃都无所谓，绝不能影响搜索响应本身。
 *
 * 三条硬边界：
 * 1. **不阻塞调用方**。fire-and-forget，返回值立刻给出去。
 * 2. **去重 + 限并发**。用户打字时每次输入都会触发搜索，不能每敲一个字就去打一次地图。
 * 3. **失败静默**。预热失败只是「没提前准备好」，不是错误，不该冒泡给用户。
 */

interface PrefetchState {
  /** city -> 最近一次触发时间（去重窗口）。 */
  triggered: Map<string, number>;
  /** 当前在跑的预热数量。 */
  running: number;
  /** 正在预热的城市，避免同一城市并发两次。 */
  active: Set<string>;
}

const globalForPrefetch = globalThis as typeof globalThis & {
  __manchengPrefetch?: PrefetchState;
};

const state =
  globalForPrefetch.__manchengPrefetch ??
  (globalForPrefetch.__manchengPrefetch = {
    triggered: new Map<string, number>(),
    running: 0,
    active: new Set<string>(),
  });

/** 同一城市在这个窗口内只预热一次：用户改一个字就重来会白烧外部请求。 */
const DEDUPE_MS = 10 * 60 * 1000;
/** 同时最多预热两座城市，别把带宽和公共端点配额吃满。 */
const MAX_CONCURRENT = 2;
/** 预热整体上限：超过就放弃，反正用户那边还有正常路径。 */
const PREFETCH_TIMEOUT_MS = 60_000;

export interface PrefetchResult {
  /** 是否真的启动了预热（false = 去重 / 超并发 / 已结束）。 */
  started: boolean;
  reason?: "duplicate" | "busy" | "empty";
}

/**
 * 触发一次预热。**立即返回**，不等预热完成。
 *
 * @param city 城市名，用作去重键。
 * @param warm 真正干活的任务。抛错会被吞掉。
 */
export function prefetchCity(
  city: string,
  warm: () => Promise<unknown>,
  now = Date.now(),
): PrefetchResult {
  const name = city.trim();
  if (!name) return { started: false, reason: "empty" };

  const last = state.triggered.get(name);
  if (last !== undefined && now - last < DEDUPE_MS) {
    return { started: false, reason: "duplicate" };
  }
  if (state.active.has(name)) return { started: false, reason: "duplicate" };
  if (state.running >= MAX_CONCURRENT) return { started: false, reason: "busy" };

  state.triggered.set(name, now);
  state.active.add(name);
  state.running += 1;

  // 注意：这里**故意不 await**。调用方（搜索接口）必须在几十毫秒内返回。
  void (async () => {
    try {
      await Promise.race([
        warm(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("prefetch timeout")), PREFETCH_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // 预热失败只是没提前准备好，不是错误。
    } finally {
      state.active.delete(name);
      state.running -= 1;
    }
  })();

  return { started: true };
}

/** 测试用：重置去重与并发状态。 */
export function resetPrefetchState(): void {
  state.triggered.clear();
  state.active.clear();
  state.running = 0;
}

/* ------------------------------------------------------------------ *
 * 单飞（single-flight）
 *
 * 没有这一层，「后台预热」和「用户真的点了生成」会各算一遍：
 * 预热不但没省时间，还让服务器多干一份活。有了它，用户点下去时
 * 直接挂到已经在跑的那次计算上，等的是剩余时间而不是从头再来。
 * ------------------------------------------------------------------ */

const globalForFlight = globalThis as typeof globalThis & {
  __manchengSingleFlight?: Map<string, Promise<unknown>>;
};
const flights =
  globalForFlight.__manchengSingleFlight ??
  (globalForFlight.__manchengSingleFlight = new Map<string, Promise<unknown>>());

/**
 * 同一个 key 只执行一次 `run`；并发调用共享同一个 Promise。
 *
 * 注意：这里**不缓存结果**，只合并「正在进行中」的调用。
 * 结果该不该留、留多久，由调用方自己的缓存层决定——混在一起会让
 * 语义变模糊（是「还在算」还是「算过且有效」）。
 */
export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;
  const task = run().finally(() => {
    flights.delete(key);
  });
  flights.set(key, task);
  return task;
}

export function singleFlightSize(): number {
  return flights.size;
}

/** 这个键当前是否已有计算在跑。排障与日志用。 */
export function singleFlightHas(key: string): boolean {
  return flights.has(key);
}

export function resetSingleFlight(): void {
  flights.clear();
}

/** 测试/排障用。 */
export function prefetchSnapshot(): { running: number; active: string[]; triggered: string[] } {
  return {
    running: state.running,
    active: [...state.active],
    triggered: [...state.triggered.keys()],
  };
}
