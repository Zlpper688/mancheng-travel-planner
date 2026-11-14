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
): Promise<T> {
  const now = Date.now();
  const hit = cacheStore.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  const pending = pendingStore.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = loader()
    .then((value) => {
      cacheStore.set(key, { value, expiresAt: Date.now() + ttlMs });
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": "ManchengTravelPlanner/1.0",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`上游请求失败（${response.status}）`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
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
