import https from "node:https";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const globalForCache = globalThis as typeof globalThis & {
  __manchengCache?: Map<string, CacheEntry<unknown>>;
  __manchengPending?: Map<string, Promise<unknown>>;
};

const cacheStore =
  globalForCache.__manchengCache ??
  (globalForCache.__manchengCache = new Map<string, CacheEntry<unknown>>());
const pendingStore =
  globalForCache.__manchengPending ??
  (globalForCache.__manchengPending = new Map<string, Promise<unknown>>());

export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options: { cacheIf?: (value: T) => boolean } = {},
): Promise<T> {
  const now = Date.now();
  const hit = cacheStore.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  const pending = pendingStore.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = loader()
    .then((value) => {
      if (!options.cacheIf || options.cacheIf(value)) {
        cacheStore.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    })
    .finally(() => {
      pendingStore.delete(key);
    });

  pendingStore.set(key, promise as Promise<unknown>);
  return promise;
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<T> {
  const headers: Record<string, string> = {
    "User-Agent": "ManchengTravelPlanner/1.0",
    Accept: "application/json",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers,
      cache: "no-store",
    });
  } catch (error) {
    // 超时不要走 https 兜底。
    //
    // 兜底那条路是给「连接池复用了被上游关掉的空闲连接」（UND_ERR_SOCKET）准备的，
    // 属于「立刻失败」的场景；而超时是「已经等满了 timeout」——
    // undici 把 abort 包成 TypeError: fetch failed，会被下面的正则误判成 socket 错误，
    // 于是又用 https 重来一遍，12 秒直接变 24 秒。
    // 实测厦门跨海步行段（鼓浪屿 ↔ 中山路）每次冷启动都要付这笔钱。
    if (controller.signal.aborted) {
      clearTimeout(timer);
      throw error;
    }
    if (!isSocketLevelError(error)) {
      clearTimeout(timer);
      throw error;
    }
    const fallback = await httpsGetJson<T>(url, headers, timeoutMs);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`上游请求失败（${response.status}）`);
  }
  return (await response.json()) as T;
}

function isSocketLevelError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? "";
  return (
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ECONNREFUSED" ||
    /other side closed|socket hang up|fetch failed/i.test(
      `${(error as Error)?.message ?? ""}`,
    )
  );
}

function httpsGetJson<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`上游请求失败（${res.statusCode ?? 0}）`));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch {
          reject(new Error("上游返回的不是合法 JSON"));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("上游请求超时")));
  });
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
