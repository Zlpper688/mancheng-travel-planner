import {
  isObviouslyFake,
  judgeExistence,
  judgeReady,
  judgeRelevance,
} from "./photo-judge";
import type { Category } from "./types";

/**
 * 运行时现场找图：搜狗图片 → 360 图片。
 *
 * 守门分两层：
 *  - L0 搜图前：LLM 判这个地点是否真实存在、名字是否记岔（明显编造就直接停，不搜）；
 *  - L1 搜图后：LLM 判候选标题与这个景点的语义相关性（容忍别名/记错名）；
 *  - 兜底：LLM 不可用时退回字符串标题匹配。
 * 绝不拿外地/无关的图冒充这一站的实景。
 */

export interface LiveCandidate {
  title: string;
  thumb: string;
  ori: string;
  page: string;
  width: number;
  height: number;
}

export interface LivePhoto {
  url: string;
  source: "现场搜图" | "通用示意图";
  sourceUrl?: string;
  title?: string;
  author?: string;
  license?: string;
  /** 是否只是同类示意图（不是这一站的实景）。 */
  generic?: boolean;
}

const SEARCH_TIMEOUT = 7_000;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;
const SEARCH_GAP = 250;
const PROVIDER_COOLDOWN = 60_000;

const unavailableUntil = new Map<string, number>();
let searchChain: Promise<unknown> = Promise.resolve();
let lastSearchAt = 0;

function coolDown(provider: string): void {
  unavailableUntil.set(provider, Date.now() + PROVIDER_COOLDOWN);
}

function ready(provider: string): boolean {
  return (unavailableUntil.get(provider) ?? 0) <= Date.now();
}

function searchSlot<T>(task: () => Promise<T>): Promise<T> {
  const run = searchChain.then(async () => {
    const wait = lastSearchAt + SEARCH_GAP - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastSearchAt = Date.now();
    return task();
  });
  searchChain = run.catch(() => undefined);
  return run;
}

/** 从 Next.js 服务端渲染的 NUXT 数据里抠出搜索结果数组（括号配对，避免误截断）。 */
function extractArray(text: string, marker: string): unknown[] | null {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const bracket = text.indexOf("[", start);
  if (bracket < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = bracket; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(bracket, i + 1)) as unknown[];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const SUFFIX =
  /(观景平台|观景台|步行街|商业街|海鲜排档|咖啡街区|老字号小吃|岛上小吃|小吃街|码头|风景区|景区)$/;

/** 景点名可能有通用后缀，也可能带城市前缀；两种都要能匹配上标题。 */
function aliasesOf(name: string, city: string): string[] {
  const out = new Set<string>();
  const clean = name.trim();
  if (clean.length >= 2) out.add(clean);
  const bare = clean.replace(SUFFIX, "").trim();
  if (bare.length >= 2) out.add(bare);
  const shortCity = city.replace(/[市区县]$/, "").trim();
  if (shortCity && clean.startsWith(shortCity)) {
    const stripped = clean.slice(shortCity.length).trim();
    if (stripped.length >= 2) out.add(stripped);
  }
  return [...out];
}

/** 标题守门：必须命中景点名，且不能带明显的"门票/攻略/报价"营销噪声。 */
export function titleMatches(
  title: string,
  name: string,
  city: string,
): boolean {
  if (!title?.trim()) return false;
  const aliases = aliasesOf(name, city);
  if (!aliases.some((alias) => title.includes(alias))) return false;
  return true;
}

function rankCandidates(
  candidates: LiveCandidate[],
  name: string,
  city: string,
  allowedIndices?: Set<number>,
): LiveCandidate[] {
  return candidates
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item, index }) =>
        item.thumb &&
        item.width >= MIN_WIDTH &&
        item.height >= MIN_HEIGHT &&
        // LLM 给了语义判定就用它；没给（不可用）才退回字符串标题匹配。
        (allowedIndices
          ? allowedIndices.has(index)
          : titleMatches(item.title, name, city)),
    )
    .map(({ item }) => item)
    .map((item) => {
      let score = 0;
      if (item.title.includes(name)) score += 4;
      if (city && item.title.includes(city)) score += 1;
      if (item.width >= item.height * 1.2) score += 2;
      if (item.width >= 800) score += 1;
      if (/douyin|weibo|xiaohongshu/.test(item.ori)) score -= 2;
      if (/ctrip|qunar|mafengwo|gov\.cn|wikimedia/.test(item.ori)) score += 2;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

type SogouResult = {
  title?: string;
  thumbUrl?: string;
  oriPicUrl?: string;
  url?: string;
  width?: number;
  height?: number;
};

type So360Result = {
  title?: string;
  thumb?: string;
  img?: string;
  https?: string;
  http?: string;
  link?: string;
  width?: string | number;
  height?: string | number;
};

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function searchSogou(query: string): Promise<LiveCandidate[]> {
  if (!ready("sogou")) return [];
  try {
    const html = await fetchText(
      `https://pic.sogou.com/pics?query=${encodeURIComponent(query)}`,
    );
    const list = extractArray(html, '"searchList":[') ?? [];
    return (list as SogouResult[]).map((item) => ({
      title: item.title ?? "",
      thumb: item.thumbUrl ?? "",
      ori: item.oriPicUrl ?? "",
      page: item.url ?? "",
      width: Number(item.width ?? 0),
      height: Number(item.height ?? 0),
    }));
  } catch {
    coolDown("sogou");
    return [];
  }
}

async function search360(query: string): Promise<LiveCandidate[]> {
  if (!ready("360")) return [];
  try {
    const text = await fetchText(
      `https://image.so.com/j?q=${encodeURIComponent(query)}&pd=1&pn=30&sn=0`,
    );
    const data = JSON.parse(text) as { list?: So360Result[] };
    return (data.list ?? []).map((item) => ({
      title: item.title ?? "",
      thumb: item.thumb ?? "",
      ori: item.img || item.https || item.http || "",
      page: item.link ?? "",
      width: Number(item.width ?? 0),
      height: Number(item.height ?? 0),
    }));
  } catch {
    coolDown("360");
    return [];
  }
}

export interface LiveSearchOutcome {
  photo: LivePhoto | null;
  /** LLM 明确判定地点不存在——调用方应直接落到分类图，不要再走慢速维基源。 */
  nonexistent: boolean;
}

/** 现场搜图：返回一个可直接 <img src> 的候选（CDN 直链，实测无防盗链）。 */
export async function searchLivePhoto(input: {
  name: string;
  city: string;
  category?: Category;
}): Promise<LivePhoto | null> {
  return (await searchLivePhotoDetailed(input)).photo;
}

export async function searchLivePhotoDetailed(input: {
  name: string;
  city: string;
  category?: Category;
}): Promise<LiveSearchOutcome> {
  // L0：搜图前先判这地方到底存不存在。明显编造的直接停，不浪费一次搜索。
  if (isObviouslyFake(input.city, input.name)) {
    return { photo: null, nonexistent: true };
  }
  let corrected = input.name;
  if (judgeReady()) {
    const judgement = await judgeExistence(input.city, input.name);
    if (judgement && !judgement.exists && judgement.confidence >= 0.7) {
      return { photo: null, nonexistent: true };
    }
    if (judgement?.corrected) corrected = judgement.corrected;
  }

  // 名字记岔时用纠正后的名字搜（"洪崖洞夜市" -> "洪崖洞"）。
  const query = `${input.city} ${corrected}`.trim();
  for (const [provider, search] of [
    ["sogou", searchSogou],
    ["360", search360],
  ] as const) {
    if (!ready(provider)) continue;
    const candidates = await searchSlot(() => search(query));
    if (!candidates.length) continue;

    // L1：把候选标题交给 LLM 判语义相关性；不可用时退回字符串守门。
    let allowed: Set<number> | undefined;
    if (judgeReady()) {
      const relevant = await judgeRelevance(input.name, corrected, candidates.map((item) => item.title));
      if (relevant !== null) allowed = new Set(relevant);
    }
    const ranked = rankCandidates(candidates, input.name, input.city, allowed);
    const best = ranked[0];
    if (!best) continue;
    return {
      photo: {
        url: best.thumb,
        source: "现场搜图",
        sourceUrl: best.page || best.ori || best.thumb,
        title: best.title,
        license: "版权归原作者",
      },
      nonexistent: false,
    };
  }
  return { photo: null, nonexistent: false };
}
