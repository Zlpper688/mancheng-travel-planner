import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

/**
 * 现场搜到的图落盘缓存。
 *
 * 为什么：搜索结果给的是 CDN 直链，首次 1–2s、断网就挂。落盘后
 *  - 二次访问走本地静态文件，几乎零延迟；
 *  - 断网也能看到已经看过的地点；
 *  - CDN 换链/失效不影响已缓存的图。
 *
 * 纪律：写盘是增强，不是依赖。只读文件系统（如某些云部署）写失败时
 * 原样返回 CDN 直链，功能不降级。所有版权字段原样保留，索引记原图页面。
 */

const CACHE_DIR = path.join(process.cwd(), "public", "photos", "live");
const INDEX_FILE = path.join(process.cwd(), "data", "live-photo-cache.json");
const MAX_FILES = 500;
const MAX_BYTES = 40 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 12_000;

export interface LivePhotoLike {
  url: string;
  source: string;
  sourceUrl?: string;
  title?: string;
  license?: string;
  author?: string;
  generic?: boolean;
}

interface CacheEntry {
  hash: string;
  source: string;
  sourceUrl?: string;
  title?: string;
  license?: string;
  author?: string;
  bytes: number;
  cachedAt: number;
}

interface CacheIndex {
  version: number;
  entries: Record<string, CacheEntry>;
}

const pending = new Map<string, Promise<LivePhotoLike>>();
let indexCache: CacheIndex | null = null;

function emptyIndex(): CacheIndex {
  return { version: 1, entries: {} };
}

async function readIndex(): Promise<CacheIndex> {
  if (indexCache) return indexCache;
  try {
    const text = await fs.readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(text) as CacheIndex;
    indexCache = parsed?.version === 1 && parsed.entries ? parsed : emptyIndex();
  } catch {
    indexCache = emptyIndex();
  }
  return indexCache;
}

async function writeIndex(index: CacheIndex): Promise<void> {
  await fs.mkdir(path.dirname(INDEX_FILE), { recursive: true });
  const temp = `${INDEX_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(index, null, 2));
  await fs.rename(temp, INDEX_FILE);
  indexCache = index;
}

/** 缓存键只由地点决定，与 category/坐标精度等噪声无关。 */
export function cacheKeyOf(city: string, name: string): string {
  return createHash("sha1")
    .update(`${city.trim()}|${name.trim()}`)
    .digest("hex")
    .slice(0, 16);
}

export function cachedPhotoUrl(key: string): string | null {
  const entry = indexCache?.entries[key];
  if (!entry) return null;
  const file = path.join(CACHE_DIR, `${entry.hash}.jpg`);
  return existsSync(file) ? `/photos/live/${entry.hash}.jpg` : null;
}

export function getCacheStats(): { count: number; bytes: number } {
  const entries = Object.values(indexCache?.entries ?? {});
  return {
    count: entries.length,
    bytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
  };
}

async function evictIfNeeded(index: CacheIndex, addedBytes: number): Promise<void> {
  const entries = Object.values(index.entries);
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0) + addedBytes;
  if (entries.length <= MAX_FILES && totalBytes <= MAX_BYTES) return;
  const sorted = Object.entries(index.entries).sort(
    (a, b) => a[1].cachedAt - b[1].cachedAt,
  );
  let count = entries.length;
  let bytes = totalBytes;
  for (const [key, entry] of sorted) {
    if (count <= MAX_FILES && bytes <= MAX_BYTES) break;
    try {
      await fs.unlink(path.join(CACHE_DIR, `${entry.hash}.jpg`));
    } catch {
      // 文件已不在也当作淘汰成功。
    }
    delete index.entries[key];
    count -= 1;
    bytes -= entry.bytes || 0;
  }
}

/**
 * 把远程图落到本地静态目录，返回可直接 <img src> 的路径。
 * 任何一步失败都返回原 photo（CDN 直链），不让缓存层变成故障点。
 */
export async function persistLivePhoto(
  photo: LivePhotoLike,
  key: string,
): Promise<LivePhotoLike> {
  if (photo.url.startsWith("/photos/")) return photo;

  const index = await readIndex();
  const hit = index.entries[key];
  if (hit) {
    const file = path.join(CACHE_DIR, `${hit.hash}.jpg`);
    if (existsSync(file)) {
      const result: LivePhotoLike = {
        ...photo,
        url: `/photos/live/${hit.hash}.jpg`,
      };
      // 缓存命中时以索引里的出处为准（原页面可能已变）。
      if (hit.sourceUrl) result.sourceUrl = hit.sourceUrl;
      if (hit.title) result.title = hit.title;
      if (hit.license) result.license = hit.license;
      if (hit.author) result.author = hit.author;
      return result;
    }
    delete index.entries[key];
  }

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const task = (async (): Promise<LivePhotoLike> => {
    try {
      const response = await fetch(photo.url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 8_000) throw new Error("图片过小");
      const output = await sharp(buffer, { failOn: "error" })
        .rotate()
        .resize({ width: 720, height: 540, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 72 })
        .toBuffer();
      const meta = await sharp(output).metadata();
      if (!meta.width || meta.width < 320 || !meta.height || meta.height < 200) {
        throw new Error("尺寸不足");
      }

      await fs.mkdir(CACHE_DIR, { recursive: true });
      const hash = cacheKeyOf(key, photo.url);
      const file = path.join(CACHE_DIR, `${hash}.jpg`);
      await fs.writeFile(file, output);

      const entry: CacheEntry = {
        hash,
        source: photo.source,
        sourceUrl: photo.sourceUrl,
        title: photo.title,
        license: photo.license,
        author: photo.author,
        bytes: output.length,
        cachedAt: Date.now(),
      };
      index.entries[key] = entry;
      await evictIfNeeded(index, output.length);
      await writeIndex(index);

      return { ...photo, url: `/photos/live/${hash}.jpg` };
    } catch {
      return photo; // 写盘失败 → CDN 直链，功能不降级
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, task);
  return task;
}
