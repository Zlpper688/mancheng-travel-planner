import { CATEGORY_PHOTOS } from "../content/category-photos.generated";
import { CURATED_PHOTOS } from "../content/place-photos";
import { fetchJson } from "./cache";
import { searchLivePhotoDetailed } from "./live-search";
import { localPhotoFor } from "./photo-hints";
import { nameSimilarity } from "./providers/normalize";
import type { Category } from "./types";
import { lookupWikidataByName, wikidataImageFileByQid } from "./wikidata";

export interface PlacePhoto {
  url: string;
  source:
    | "高德"
    | "维基百科"
    | "维基共享资源"
    | "搜狗图片"
    | "360图片"
    | "现场搜图"
    | "通用示意图";
  sourceUrl?: string;
  author?: string;
  license?: string;
  title?: string;
  /** true = 同类示意图，不是这一站的实景；UI 必须标注，不能冒充。 */
  generic?: boolean;
}

const PHOTO_TTL = 24 * 60 * 60 * 1000;
// 没有图的时候只记一小会儿：网络恢复后能重新拿到图，又不会让每个点位都重复打上游。
const MISS_TTL = 10 * 60 * 1000;
const PROVIDER_COOLDOWN = 2 * 60 * 1000;
const PROVIDER_TIMEOUT = 4_500;

// 维基媒体在部分网络（含国内直连）只有图片 CDN 被墙/不稳定。Photon 是
// WordPress.com 的公开图片代理，能按原路径取回维基缩略图；换成自有反代时
// 设置 PHOTO_PROXY_BASE，完全关闭则设 PHOTO_PROXY=none。
const PHOTON_BASE = "https://i0.wp.com";
const WIKI_MEDIA_HOSTS = new Set([
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
]);

function photoProxyBase(): string | null {
  if (process.env.PHOTO_PROXY?.trim() === "none") return null;
  return (
    process.env.PHOTO_PROXY_BASE?.trim().replace(/\/+$/, "") || PHOTON_BASE
  );
}

function proxiedImage(url: string): string {
  const base = photoProxyBase();
  if (!base) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  const specialFile =
    host === "commons.wikimedia.org" &&
    parsed.pathname.startsWith("/wiki/Special:FilePath/");
  if (!WIKI_MEDIA_HOSTS.has(host) && !specialFile) return url;
  // Photon 不认 Special:FilePath 的 width 参数，会把 2MB 原图整张吐回来；
  // 用 Photon 自己的 ?w=960 才真正缩到 100KB 左右。文件名里的空格要换成
  // 下划线，否则 Commons 会回 400。
  const path =
    base === PHOTON_BASE ? parsed.pathname.replace(/%20/g, "_") : parsed.pathname;
  const query = base === PHOTON_BASE ? "?w=960" : parsed.search;
  return `${base}/${host}${path}${query}`;
}

function commonsFilePath(file: string): string {
  const name = file.replace(/^File:/i, "").trim();
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=960`;
}

function commonsFilePage(file: string): string {
  const name = file.replace(/^File:/i, "").trim();
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name)}`;
}

/** 从 OSM 的 image / wikimedia_commons 标签里取出一张可用的维基图。 */
function taggedPhoto(
  image?: string,
  commons?: string,
): PlacePhoto | null {
  const raw = [image, commons].find((value) => value?.trim());
  if (!raw) return null;
  const value = raw.trim();
  const fileTag = value.match(/^File:(.+)$/i);
  if (fileTag) {
    const file = fileTag[1].trim();
    if (!file) return null;
    return {
      url: proxiedImage(commonsFilePath(file)),
      source: "维基共享资源",
      sourceUrl: commonsFilePage(file),
    };
  }
  if (/^Category:/i.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const filePage = decodeURIComponent(parsed.pathname).match(/\/wiki\/File:(.+)$/);
  if (host === "commons.wikimedia.org" && filePage) {
    const file = filePage[1];
    return {
      url: proxiedImage(commonsFilePath(file)),
      source: "维基共享资源",
      sourceUrl: commonsFilePage(file),
    };
  }
  if (WIKI_MEDIA_HOSTS.has(host)) {
    return {
      url: proxiedImage(value),
      source: "维基共享资源",
      sourceUrl: value,
    };
  }
  return null;
}

type PhotoEntry = { photo: PlacePhoto | null; expiresAt: number };

const photoStore = new Map<string, PhotoEntry>();
const pendingStore = new Map<string, Promise<PlacePhoto | null>>();
const unavailableUntil = new Map<string, number>();

function providerReady(provider: string): boolean {
  return (unavailableUntil.get(provider) ?? 0) <= Date.now();
}

function coolDown(provider: string): void {
  unavailableUntil.set(provider, Date.now() + PROVIDER_COOLDOWN);
}

type AmapPhotoPoi = {
  id?: string;
  name?: string;
  photos?: { title?: string; url?: string }[] | string;
};

type AmapPhotoResponse = {
  status?: string;
  pois?: AmapPhotoPoi[];
};

type WikiImageInfo = {
  thumburl?: string;
  url?: string;
  descriptionurl?: string;
  width?: number;
  height?: number;
  extmetadata?: Record<string, { value?: string }>;
};

type WikiPage = {
  index?: number;
  title?: string;
  thumbnail?: { source?: string };
  pageimage?: string;
  imageinfo?: WikiImageInfo[];
};

type WikiResponse = {
  query?: { pages?: Record<string, WikiPage> };
};

async function amapPhoto(name: string, city: string): Promise<PlacePhoto | null> {
  const key = process.env.AMAP_KEY?.trim();
  if (!key) return null;
  const params = new URLSearchParams({
    key,
    keywords: name,
    region: city,
    city_limit: "true",
    show_fields: "photos",
    page_size: "5",
  });
  try {
    const data = await fetchJson<AmapPhotoResponse>(
      `https://restapi.amap.com/v5/place/text?${params.toString()}`,
      {},
      6_000,
    );
    if (data.status !== "1") return null;
    const photosOf = (poi: AmapPhotoPoi) =>
      Array.isArray(poi.photos)
        ? poi.photos.find((item) => item.url?.trim())
        : undefined;
    // 第一条不一定是我们要的点（“中山路”能命中一串同名店），按名字相似度挑，
    // 相似度不够宁可不用——拿别处的照片冒充比没有图更糟。
    const ranked = (data.pois ?? [])
      .map((poi) => ({
        poi,
        photo: photosOf(poi),
        score: nameSimilarity(name, poi.name ?? ""),
      }))
      .filter((item) => item.photo?.url && item.score >= 0.6)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best?.photo?.url) return null;
    return {
      url: secureUrl(best.photo.url),
      source: "高德",
      sourceUrl: best.poi.id
        ? `https://www.amap.com/place/${best.poi.id}`
        : "https://www.amap.com/",
    };
  } catch {
    // 高德图片是加分项，失败时继续用公开图库兜底。
    return null;
  }
}

function secureUrl(url: string): string {
  return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}

function stripHtml(value?: string): string | undefined {
  const text = value?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return text || undefined;
}

const curatedStore = new Map(
  CURATED_PHOTOS.map((item) => [`${item.city}|${item.name}`, item]),
);

function curatedPhoto(name: string, city: string): PlacePhoto | null {
  const item = curatedStore.get(`${city.trim()}|${name.trim()}`);
  if (!item) return null;
  return {
    url: proxiedImage(item.thumb),
    source: "维基共享资源",
    sourceUrl: item.page,
    author: item.author,
    license: item.license,
  };
}

function commonsPhotoFromFile(file: string): PlacePhoto {
  const name = file.replace(/^File:/i, "").trim();
  return {
    url: proxiedImage(commonsFilePath(name)),
    source: "维基共享资源",
    sourceUrl: commonsFilePage(name),
  };
}

function wikidataFile(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.pathname.startsWith("/wiki/Special:FilePath/")) {
      const file = decodeURIComponent(
        url.pathname.slice("/wiki/Special:FilePath/".length),
      ).trim();
      return file || undefined;
    }
    const parts = url.pathname.split("/");
    const last = decodeURIComponent(parts[parts.length - 1] ?? "").trim();
    return last || undefined;
  } catch {
    return undefined;
  }
}

// 维基数据的官方接口在国内网络常被阻断，统一走 QLever 的 SPARQL 端点。
async function wikidataPhoto(qid: string): Promise<PlacePhoto | null> {
  if (!providerReady("wikidata")) return null;
  try {
    const file = await wikidataImageFileByQid(qid);
    return file ? commonsPhotoFromFile(file) : null;
  } catch (error) {
    console.warn("[photo] wikidata 暂不可用：", (error as Error)?.message ?? error);
    coolDown("wikidata");
    return null;
  }
}

// 点位没有 QID 时，按中文条目名回查维基数据；坐标只用来排除同名异地条目。
async function wikidataNamePhoto(input: {
  name: string;
  city: string;
  lat?: number;
  lng?: number;
}): Promise<PlacePhoto | null> {
  if (!providerReady("wikidata")) return null;
  try {
    const item = await lookupWikidataByName(
      input.name,
      input.city,
      input.lat,
      input.lng,
    );
    const file = wikidataFile(item?.image);
    return file ? commonsPhotoFromFile(file) : null;
  } catch {
    coolDown("wikidata");
    return null;
  }
}

function commonsCandidate(
  pages: WikiPage[],
  name: string,
  city: string,
): WikiPage | null {
  const aliases = placeAliases(name);
  const usable = pages
    .filter((page) => {
      const title = page.title ?? "";
      const info = page.imageinfo?.[0];
      if (!info?.thumburl) return false;
      if (!/\.(jpe?g|png|webp)$/i.test(title)) return false;
      if (/map|plan|diagram|logo|icon|poster|cover/i.test(title)) return false;
      if ((info.width ?? 0) < 600) return false;
      // 只接受标题里真的出现地名的图，宁可留白也不放一张“附近的照片”。
      const matched = aliases.filter((alias) => title.includes(alias));
      if (matched.length === 0) return false;
      // 中山路、人民公园这类全国重名的通用地名，标题里没有城市就可能是别的城市。
      const generic = matched.every((alias) =>
        /(路|街|大道|广场|公园|巷)$/.test(alias),
      );
      return !generic || title.includes(city);
    })
    .sort((a, b) => {
      const ai = a.imageinfo?.[0];
      const bi = b.imageinfo?.[0];
      const aLandscape = (ai?.width ?? 0) >= (ai?.height ?? 0) ? 1 : 0;
      const bLandscape = (bi?.width ?? 0) >= (bi?.height ?? 0) ? 1 : 0;
      if (aLandscape !== bLandscape) return bLandscape - aLandscape;
      return (a.index ?? 99) - (b.index ?? 99);
    });
  return usable[0] ?? null;
}

function corePlaceName(name: string): string {
  return name.split(/[·•]/)[0]?.trim() || name.trim();
}

const PLACE_SUFFIX =
  /(观景平台|观景台|步行街|商业街|海鲜排档|咖啡街区|老字号小吃|岛上小吃|小吃街|码头)$/;

function placeAliases(name: string): string[] {
  const full = name.trim();
  const core = corePlaceName(full);
  const stripped = core.replace(PLACE_SUFFIX, "").trim();
  return [...new Set([full, core, stripped])].filter(
    (alias) => alias.length >= 2,
  );
}

async function wikipediaPhoto(name: string): Promise<PlacePhoto | null> {
  if (!providerReady("wikipedia")) return null;
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: name,
    gsrlimit: "2",
    gsrnamespace: "0",
    prop: "pageimages",
    piprop: "thumbnail|name",
    pithumbsize: "960",
    pilicense: "any",
    redirects: "1",
  });
  try {
    const data = await fetchJson<WikiResponse>(
      `https://zh.wikipedia.org/w/api.php?${params.toString()}`,
      {},
      PROVIDER_TIMEOUT,
    );
    const pages = Object.values(data.query?.pages ?? {});
    const page = pages.find((item) => item.thumbnail?.source);
    if (!page?.thumbnail?.source) return null;
    return {
      url: proxiedImage(secureUrl(page.thumbnail.source)),
      source: "维基百科",
      sourceUrl: page.title
        ? `https://zh.wikipedia.org/wiki/${encodeURIComponent(page.title)}`
        : undefined,
    };
  } catch (error) {
    console.warn("[photo] wikipedia 暂不可用：", (error as Error)?.message ?? error);
    coolDown("wikipedia");
    return null;
  }
}

const COMMONS_GAP = 600;
let commonsChain: Promise<unknown> = Promise.resolve();
let lastCommonsAt = 0;

function commonsSlot<T>(task: () => Promise<T>): Promise<T> {
  const run = commonsChain.then(async () => {
    const wait = lastCommonsAt + COMMONS_GAP - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCommonsAt = Date.now();
    return task();
  });
  commonsChain = run.catch(() => undefined);
  return run;
}

// 共享资源对本机出口限流很紧，十几张图并发会整片 429。
// 串行排队留间隔；命中 429 先等一轮再排，其他错误才当作供应商不可用。
async function commonsSearch(query: string): Promise<WikiPage[] | null> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `filetype:bitmap ${query}`,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|size|extmetadata",
    iiurlwidth: "960",
  });
  const url = `https://commons.wikimedia.org/w/api.php?${params.toString()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await commonsSlot(() =>
        fetchJson<WikiResponse>(url, {}, PROVIDER_TIMEOUT),
      );
      return Object.values(data.query?.pages ?? {});
    } catch (error) {
      const message = `${(error as Error)?.message ?? error}`;
      if (attempt === 0 && message.includes("429")) {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        continue;
      }
      console.warn("[photo] commons 暂不可用：", message);
      coolDown("commons");
      return null;
    }
  }
  return null;
}

async function commonsPhoto(
  name: string,
  city: string,
): Promise<PlacePhoto | null> {
  if (!providerReady("commons")) return null;
  // “沙坡尾 · 海鲜排档”这类组合点位没有对应条目，用片区照片冒充会误导，直接留白用版式卡。
  if (/[·•]/.test(name)) return null;
  const core = corePlaceName(name);
  const stripped = core.replace(PLACE_SUFFIX, "").trim();
  // 先用精确名字搜；像“演武大桥观景平台”这种条目名更短的，再退一步搜核心名。
  const queries = stripped && stripped !== core ? [core, stripped] : [core];
  for (const query of queries) {
    if (!providerReady("commons")) break;
    const pages = await commonsSearch(query);
    if (!pages) break;
    const page = commonsCandidate(pages, name, city);
    const info = page?.imageinfo?.[0];
    if (!page || !info?.thumburl) continue;
    return {
      url: proxiedImage(secureUrl(info.thumburl)),
      source: "维基共享资源",
      sourceUrl: info.descriptionurl,
      author: stripHtml(info.extmetadata?.Artist?.value),
      license: stripHtml(info.extmetadata?.LicenseShortName?.value),
    };
  }
  return null;
}

async function resolveUncached(input: {
  name: string;
  city: string;
  lat?: number;
  lng?: number;
  qid?: string;
  image?: string;
  commons?: string;
  category?: Category;
}): Promise<PlacePhoto | null> {
  // 本地静态图库最优先：演示零外网依赖，且每张图都能追溯到原图页面。
  const local = localPhotoFor(input.name, input.city);
  if (local) {
    return {
      url: local.url,
      source: local.source as PlacePhoto["source"],
      sourceUrl: local.sourceUrl,
      author: local.title,
      license: local.source === "维基共享资源" ? undefined : "版权归原作者",
    };
  }

  const amap = await amapPhoto(input.name, input.city);
  if (amap) return amap;

  // OSM 明确挂接的图最可靠：它就是这一条 POI 自己的 image / wikimedia_commons。
  const tagged = taggedPhoto(input.image, input.commons);
  if (tagged) return tagged;

  const curated = curatedPhoto(input.name, input.city);
  if (curated) return curated;

  // 现场找图优先于维基慢源：国内网络下维基 API 常 4.5s 超时，而搜图 ~1s。
  // 搜图前由 LLM 判存在性、搜图后判语义相关性，不会为了快而牺牲准确性。
  const live = await searchLivePhotoDetailed(input);
  if (live.photo) return live.photo as PlacePhoto;

  // LLM 明确说这地方不存在：直接落分类图，连维基慢源都不必试。
  if (!live.nonexistent) {
    // 现场没搜到才走维基源（CC 许可更清晰，但慢）。
    if (input.qid && /^Q\d+$/.test(input.qid)) {
      const byQid = await wikidataPhoto(input.qid);
      if (byQid) return byQid;
    }
    const byName = await wikidataNamePhoto(input);
    if (byName) return byName;

    const [wiki, commons] = await Promise.all([
      wikipediaPhoto(input.name),
      commonsPhoto(input.name, input.city),
    ]);
    if (wiki || commons) return wiki ?? commons;
  }

  // 最后一层：同类通用示意图。明确标记 generic，UI 会写"示意"，不冒充实景。
  const fallback = input.category ? CATEGORY_PHOTOS[input.category] : undefined;
  if (fallback) {
    return {
      url: fallback.url,
      source: "通用示意图",
      sourceUrl: fallback.sourceUrl,
      title: fallback.title,
      generic: true,
    };
  }
  return null;
}

export async function resolvePlacePhoto(input: {
  name: string;
  city: string;
  lat?: number;
  lng?: number;
  qid?: string;
  image?: string;
  commons?: string;
  category?: Category;
}): Promise<PlacePhoto | null> {
  const key = `photo:${input.city}|${input.name}|${input.lat?.toFixed(4) ?? ""}|${input.lng?.toFixed(4) ?? ""}|${input.qid ?? ""}|${input.image ?? ""}|${input.commons ?? ""}|${input.category ?? ""}`;
  const now = Date.now();
  const hit = photoStore.get(key);
  if (hit && hit.expiresAt > now) return hit.photo;

  const pending = pendingStore.get(key);
  if (pending) return pending;

  const promise = resolveUncached(input)
    .then((photo) => {
      photoStore.set(key, {
        photo,
        expiresAt: Date.now() + (photo ? PHOTO_TTL : MISS_TTL),
      });
      return photo;
    })
    .finally(() => {
      pendingStore.delete(key);
    });
  pendingStore.set(key, promise);
  return promise;
}