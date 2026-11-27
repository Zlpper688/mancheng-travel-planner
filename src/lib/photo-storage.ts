/**
 * 图片结果的客户端持久化缓存。
 *
 * 为什么需要：
 *   排好的行程里每个点位图，首次要走搜图/维基慢源（冷缓存可能 >9s）。
 *   原来 PlacePhoto 把结果只存在模块内存 Map，刷新/切页就没了；
 *   更糟的是把 null 也缓存，撞上一次超时就永久没图，切来切去都出不来。
 *
 * 这一层：
 *   1. 成功的图落 localStorage —— 跨刷新、跨页面切换一直在；
 *   2. 失败不落盘、不缓存 —— 下次切回来能重试；
 *   3. 有容量上限 + 容错解析 —— 存储写满/损坏都不影响主流程。
 *
 * 宪法一致：不做账号，localStorage 即可（同 journal.ts）。
 */

export interface StoredPhoto {
  url: string;
  source: string;
  sourceUrl?: string;
  author?: string;
  license?: string;
  title?: string;
  generic?: boolean;
}

const STORAGE_KEY = "mancheng.photoCache.v1";
const MAX_ENTRIES = 600;

type Store = Record<string, StoredPhoto>;

function safeParse(raw: string | null): Store {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Store = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as StoredPhoto).url === "string" &&
        (value as StoredPhoto).url.length > 0 &&
        typeof (value as StoredPhoto).source === "string"
      ) {
        out[key] = value as StoredPhoto;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** SSR 安全：服务端返回空，不影响渲染（组件在 useEffect 里才读）。 */
export function loadPhotoCache(): Store {
  if (typeof window === "undefined") return {};
  return safeParse(window.localStorage.getItem(STORAGE_KEY));
}

/** 读单条；坏数据当没有。 */
export function getStoredPhoto(key: string): StoredPhoto | null {
  return loadPhotoCache()[key] ?? null;
}

/**
 * 写单条。只接受有 url 的结果——null/失败一律不持久化，
 * 保证冷缓存撞上超时后仍有机会重试。
 * 超过上限时丢掉最早写入的一半（localStorage 没有 LRU，按插入顺序近似）。
 */
export function storePhoto(key: string, photo: StoredPhoto): void {
  if (typeof window === "undefined" || !photo?.url) return;
  const cache = loadPhotoCache();
  cache[key] = photo;
  const keys = Object.keys(cache);
  if (keys.length > MAX_ENTRIES) {
    for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[old];
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // 存储写满/隐私模式：静默失败，不影响图片显示（内存 Map 仍有效）。
  }
}

/** 测试/诊断用：清空缓存。 */
export function clearPhotoCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
