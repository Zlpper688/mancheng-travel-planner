import path from "node:path";
import { cacheRoot } from "./disk-cache";
import { haversine } from "./geo";
import { persistentCache } from "./persistent-cache";
import { isEndpointDown, noteEndpointFailure, noteEndpointSuccess } from "./upstream-health";
import { cleanNameForMatch, nameSimilarity } from "./providers/normalize";
import type { Place } from "./types";

// 维基数据的官方接口在部分网络不可达；QLever（弗赖堡大学，Apache-2.0）
// 提供同一份 Wikidata 的 SPARQL 端点，支持按中文标签和经纬度检索。
const QLEVER_URL = "https://qlever.dev/api/wikidata";
const QUERY_TIMEOUT = 8_000;
const FACTS_TTL = 24 * 60 * 60 * 1000;
const MISS_TTL = 60 * 60 * 1000;
const NAME_BATCH = 40;
const QID_BATCH = 160;

const PREFIXES = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
PREFIX wikibase: <http://wikiba.se/ontology#>
`;

const LANG_TAGS = ["zh", "zh-hans", "zh-cn", "en"] as const;
const DESC_LANGS = ["zh-hans", "zh-cn", "zh", "zh-hant"] as const;

export interface WikidataFacts {
  id: string;
  labels: string[];
  lat?: number;
  lng?: number;
  image?: string;
  description?: string;
}

type Binding = { value: string; "xml:lang"?: string };
type SparqlResponse = { results?: { bindings?: Record<string, Binding>[] } };

let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sparqlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim().slice(0, 60));
}

async function runQuery(query: string): Promise<Record<string, Binding>[]> {
  // 冷却判断走共享的、**会落盘**的熔断器，而不是这个模块自己的一个内存变量。
  // 实测（2026-11-27）：qlever.dev 对同一 IP 稳定返回 429，带不带尾斜杠、POST/GET 都一样。
  // 原实现每次都要重试 3 次并退避 1.2s + 2.4s，于是 enrich 段固定烧掉 4.8s 却一条数据都拿不到；
  // 而且这个「别去撞」的记忆一重启就丢，下一单继续烧。知识应该只学一次。
  if (isEndpointDown(QLEVER_URL)) throw new Error("QLever 冷却中");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT);
    try {
      const response = await fetch(QLEVER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/sparql-query",
          Accept: "application/sparql-results+json",
          "User-Agent": "ManchengTravelPlanner/1.0",
        },
        body: `${PREFIXES}${query}`,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        noteEndpointFailure(QLEVER_URL);
        // 429 只补一次、且退避很短：真限流时退 1.2s 也回不来，
        // 白白把用户的等待拉长；瞬时抖动则 300ms 足够。
        if (response.status === 429 && attempt === 0) {
          await sleep(300);
          continue;
        }
        throw new Error(`QLever 返回 ${response.status}`);
      }
      noteEndpointSuccess(QLEVER_URL);
      const data = (await response.json()) as SparqlResponse;
      return data.results?.bindings ?? [];
    } catch (error) {
      const isTimeout = (error as Error)?.name === "AbortError";
      if (isTimeout && attempt === 0) {
        await sleep(300);
        continue;
      }
      noteEndpointFailure(QLEVER_URL);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("QLever 重试后仍失败");
}

function sparql(query: string): Promise<Record<string, Binding>[]> {
  // 维基数据的事实几乎不变（景点简介、图片、坐标），但原来只有进程内缓存：
  // 每次重启后第一单都要把同样的几条 SPARQL 重跑一遍，实测 enrich 段要 5.6s。
  // 落盘后重启即命中。键用查询串哈希——同一批名字永远拼出同一个查询。
  return persistentCache<Record<string, Binding>[]>({
    dir: path.join(cacheRoot(), "wikidata"),
    key: query,
    ttlMs: FACTS_TTL,
    maxFiles: 800,
    load: () => {
      const run = chain.then(async () => {
        const wait = lastRequestAt + 120 - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
        return runQuery(query);
      });
      chain = run.catch(() => undefined);
      return run;
    },
    // 空结果不落盘：一次超时/限流不该把「这个景点没有资料」钉死一整天。
    cacheIf: (rows) => Array.isArray(rows) && rows.length > 0,
  });
}

function qidOf(uri: string): string {
  return uri.split("/").pop() ?? "";
}

function wktPoint(value: string): { lat: number; lng: number } | null {
  const match = value.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/i);
  if (!match) return null;
  const lng = Number(match[1]);
  const lat = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function commonsFileName(value: string): string | undefined {
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

async function fetchCoordinates(
  qids: string[],
): Promise<Map<string, { lat: number; lng: number }>> {
  const out = new Map<string, { lat: number; lng: number }>();
  for (const batch of chunk(qids, QID_BATCH)) {
    const values = batch
      .map((qid) => `<http://www.wikidata.org/entity/${qid}>`)
      .join(" ");
    const rows = await sparql(
      `SELECT ?item ?coord WHERE { VALUES ?item { ${values} } ?item wdt:P625 ?coord }`,
    );
    for (const row of rows) {
      const point = wktPoint(row.coord?.value ?? "");
      if (point) out.set(qidOf(row.item.value), point);
    }
  }
  return out;
}

const factsCache = new Map<
  string,
  { value: { image?: string; description?: string }; at: number }
>();

async function fetchFacts(
  qids: string[],
  deadline?: number,
): Promise<Map<string, { image?: string; description?: string }>> {
  const out = new Map<string, { image?: string; description?: string }>();
  const missing: string[] = [];
  for (const qid of qids) {
    const hit = factsCache.get(qid);
    if (hit && Date.now() - hit.at < (hit.value.image || hit.value.description ? FACTS_TTL : MISS_TTL)) {
      out.set(qid, hit.value);
    } else {
      missing.push(qid);
    }
  }
  for (const batch of chunk(missing, QID_BATCH)) {
    if (deadline && Date.now() > deadline) break;
    const values = batch
      .map((qid) => `<http://www.wikidata.org/entity/${qid}>`)
      .join(" ");
    const [images, descriptions] = await Promise.all([
      sparql(
        `SELECT ?item ?image WHERE { VALUES ?item { ${values} } ?item wdt:P18 ?image }`,
      ),
      sparql(
        `SELECT ?item ?desc WHERE { VALUES ?item { ${values} } ?item schema:description ?desc FILTER(lang(?desc) IN (${DESC_LANGS.map(
          (lang) => `"${lang}"`,
        ).join(", ")})) }`,
      ),
    ]);
    const batchFacts = new Map<string, { image?: string; description?: string }>();
    for (const qid of batch) batchFacts.set(qid, {});
    for (const row of images) {
      const facts = batchFacts.get(qidOf(row.item.value));
      if (facts) facts.image = row.image.value;
    }
    // 语言优先级要等结果收齐再选，否则返回顺序会决定简介是简体还是繁体。
    const ranks: Record<string, number> = {
      "zh-hans": 0,
      "zh-cn": 1,
      zh: 2,
      "zh-hant": 3,
    };
    const byItem = new Map<string, { value: string; rank: number }>();
    for (const row of descriptions) {
      const qid = qidOf(row.item.value);
      const lang = row.desc["xml:lang"] ?? "";
      const rank = ranks[lang] ?? 9;
      const current = byItem.get(qid);
      if (!current || rank < current.rank) {
        byItem.set(qid, { value: row.desc.value, rank });
      }
    }
    for (const [qid, entry] of byItem) {
      const facts = batchFacts.get(qid);
      if (facts) facts.description = entry.value;
    }
    for (const qid of batch) {
      const facts = batchFacts.get(qid) ?? {};
      factsCache.set(qid, { value: facts, at: Date.now() });
      out.set(qid, facts);
    }
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function chineseLabel(label: string): boolean {
  return /[\u4e00-\u9fff]/.test(label);
}

const GENERIC_SUFFIX =
  /^(风景区|风景名胜区|景区|旅游区|游览区|公园|博物院|博物馆|纪念馆|旧址|遗址|故居|古寺|寺|庙|宫|观|楼|阁|塔|桥|码头|广场|步行街|商业街|老街|古街|古村|村|社区|镇|山|湖|岛|湾|海滩|沙滩|海滨|浴场|湿地|植物园|动物园|大学|学院|校区|观景平台|观景台)$/;

function genericSuffixOnly(longer: string, shorter: string): boolean {
  if (!longer.includes(shorter)) return false;
  const extra = longer.replace(shorter, "");
  return GENERIC_SUFFIX.test(extra);
}

function descriptionUsable(value: string): boolean {
  const text = value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 4 || text.length > 120) return false;
  if (!chineseLabel(text)) return false;
  return !/消歧义|维基媒体|维基百科|列表|分类|维基数据/.test(text);
}

type PlaceProbe = Pick<Place, "name" | "lat" | "lng">;

// cleanNameForMatch 只写了厦门；换城市后「西安市植物园」和「西安植物园」要能对上。
function normalizedName(value: string, city?: string): string {
  let text = cleanNameForMatch(value);
  // 双语点位名（大昭寺 ཇོ་ཁང།）只保留中文段，否则永远对不上纯中文条目。
  if (/[\u3400-\u9fff]/.test(text)) {
    text = text.replace(/[^\u3400-\u9fff]/g, "");
  }
  if (!city) return text;
  const short = cleanNameForMatch(city.replace(/市$/, ""));
  if (!short) return text;
  text = text.split(short).join("").replace(/^市/, "");
  return text;
}

const LOOKUP_SUFFIX = /(观景平台|观景台|步行街|商业街|游船码头|码头|广场)$/;
const OWN_SUFFIX =
  /(路|街|巷|弄|公园|园|寺|庙|庵|山|湖|岛|湾|桥|塔|楼|阁|馆|城|镇|村|社区|门|港|滩|宫|观)$/;

// 维基条目常用另一个名字：曾厝垵→曾厝垵社区、厦门园林植物园→厦门市园林植物园。
const EN_SUFFIX =
  /\s+(monastery|temple|museum|palace|park|garden|square|street|old town|fort|pagoda|tower|bridge|lake|island|beach|viewpoint)$/i;

function lookupVariants(place: PlaceProbe, city?: string): string[] {
  const name = place.name.trim();
  const out = new Set<string>([name]);
  // OSM 的双语名字常带藏文、蒙文或拉丁字母，中文条目只认中文那段。
  const han = name.replace(/[^\u3400-\u9fff]+/g, "").trim();
  if (han.length >= 2 && han !== name) out.add(han);
  const bare = name.replace(LOOKUP_SUFFIX, "").trim();
  if (bare.length >= 2 && bare !== name) out.add(bare);
  const parenthetical = name.match(/[（(]([^）)]{2,12})[）)]/)?.[1]?.trim();
  if (parenthetical) out.add(parenthetical);
  const plain = name.replace(/[（(][^）)]*[）)]/g, "").trim();
  if (plain.length >= 2 && plain !== name) out.add(plain);
  if (city) {
    const short = city.replace(/市$/, "").trim();
    if (
      short &&
      name.startsWith(short) &&
      !name.startsWith(`${short}市`) &&
      name.length > short.length + 2
    ) {
      out.add(`${short}市${name.slice(short.length)}`);
    }
    if (short && name.includes(short)) {
      const rest = name.split(short).join("").replace(/^市/, "").trim();
      if (rest.length >= 2 && rest !== name) out.add(rest);
    }
  }
  const enBare = name.replace(EN_SUFFIX, "").trim();
  if (enBare.length >= 3 && enBare !== name) out.add(enBare);
  // 鼓楼博物馆常直接复用鼓楼条目；只对结尾仍是地标通名的才放宽。
  const museumBare = name
    .replace(/(博物馆|博物院|纪念馆|美术馆|陈列馆|展览馆)$/, "")
    .trim();
  if (
    museumBare !== name &&
    /(楼|塔|寺|宫|阁|桥|山|湖|岛|城|门|观|园|祠|庙|堂)$/.test(museumBare)
  ) {
    out.add(museumBare);
  }
  if (name.length <= 5 && !OWN_SUFFIX.test(name)) out.add(`${name}社区`);
  return [...out].slice(0, 6);
}

function distanceTo(place: PlaceProbe, item: WikidataFacts): number | undefined {
  if (item.lat === undefined || item.lng === undefined) return undefined;
  return haversine([place.lng, place.lat], [item.lng, item.lat]);
}

// 同名条目可能不止一个（博物馆本体和文物保护单位），按距离排完再挑有图的。
function rankItems(
  place: PlaceProbe,
  items: WikidataFacts[],
  city?: string,
): WikidataFacts[] {
  // 条目标签就是按这些变体查出来的，所以变体本身就是合法目标名。
  const targets = [
    ...new Set(
      lookupVariants(place, city)
        .map((name) => normalizedName(name, city))
        .filter(Boolean),
    ),
  ];
  if (!targets.length) return [];
  const exact: { item: WikidataFacts; km?: number }[] = [];
  const related: { item: WikidataFacts; km: number }[] = [];
  for (const item of items) {
    const km = distanceTo(place, item);
    for (const label of item.labels) {
      // 中文点位只认中文条目；英文点位（如 OSM 的 Jokhang Monastery）放宽到英文名。
      if (chineseLabel(place.name) && !chineseLabel(label)) continue;
      const cleaned = normalizedName(label, city);
      if (!cleaned) continue;
      if (targets.includes(cleaned)) {
        exact.push({ item, km });
        break;
      }
      if (km === undefined) continue;
      // 只有“多一个字也是同类通名”的情况才放宽，避免把“沙坡尾站”当成沙坡尾。
      const extraOk = targets.some(
        (target) =>
          genericSuffixOnly(cleaned, target) ||
          genericSuffixOnly(target, cleaned),
      );
      if (extraOk && km <= 0.6 && nameSimilarity(place.name, label) >= 0.68) {
        related.push({ item, km });
        break;
      }
    }
  }
  const precise = exact
    .filter((entry) => entry.km !== undefined && entry.km <= 8)
    .sort((a, b) => (a.km ?? 0) - (b.km ?? 0))
    .map((entry) => entry.item);
  const noCoord =
    exact.length === 1 && exact[0].km === undefined ? [exact[0].item] : [];
  related.sort((a, b) => a.km - b.km);
  return [...precise, ...noCoord, ...related.map((entry) => entry.item)];
}

function bestItem(
  place: PlaceProbe,
  items: WikidataFacts[],
  city?: string,
): WikidataFacts | null {
  return rankItems(place, items, city)[0] ?? null;
}

export function applyWikidataFacts(place: Place, item: WikidataFacts): boolean {
  let changed = false;
  if (!place.wikidataId) {
    place.wikidataId = item.id;
    changed = true;
  }
  if (!place.image && !place.commons && item.image) {
    const file = commonsFileName(item.image);
    if (file) {
      place.image = `File:${file}`;
      changed = true;
    }
  }
  if (!place.note?.trim() && item.description && descriptionUsable(item.description)) {
    place.note = item.description.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    changed = true;
  }
  return changed;
}

const nameCache = new Map<string, { items: WikidataFacts[]; at: number }>();

async function lookupNames(
  names: string[],
  deadline?: number,
): Promise<Map<string, WikidataFacts[]>> {
  const out = new Map<string, WikidataFacts[]>();
  const missing: string[] = [];
  for (const name of names) {
    const hit = nameCache.get(name);
    if (hit && Date.now() - hit.at < (hit.items.length ? FACTS_TTL : MISS_TTL)) {
      out.set(name, hit.items);
    } else {
      missing.push(name);
    }
  }
  for (const batch of chunk([...new Set(missing)], NAME_BATCH)) {
    if (deadline && Date.now() > deadline) break;
    const values = batch
      .flatMap((name) => LANG_TAGS.map((lang) => `${sparqlString(name)}@${lang}`))
      .join(" ");
    let rows: Record<string, Binding>[] = [];
    try {
      rows = await sparql(
        `SELECT ?name ?item WHERE { VALUES ?name { ${values} } ?item rdfs:label ?name . }`,
      );
    } catch {
      for (const name of batch) out.set(name, []);
      continue;
    }
    const byName = new Map<string, Set<string>>();
    for (const row of rows) {
      const name = row.name.value;
      const qid = qidOf(row.item.value);
      if (!qid) continue;
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name)!.add(qid);
    }
    const qids = [...new Set([...byName.values()].flatMap((set) => [...set]))];
    let coords = new Map<string, { lat: number; lng: number }>();
    let facts = new Map<string, { image?: string; description?: string }>();
    try {
      [coords, facts] = await Promise.all([
        fetchCoordinates(qids),
        fetchFacts(qids),
      ]);
    } catch {
      // 坐标或简介失败时仍然保留 QID，但不足以安全配图/配文。
    }
    for (const name of batch) {
      const items: WikidataFacts[] = [...(byName.get(name) ?? [])].map((qid) => {
        const point = coords.get(qid);
        const fact = facts.get(qid);
        return {
          id: qid,
          labels: [name],
          lat: point?.lat,
          lng: point?.lng,
          image: fact?.image,
          description: fact?.description,
        };
      });
      nameCache.set(name, { items, at: Date.now() });
      out.set(name, items);
    }
  }
  return out;
}

export interface EnrichOptions {
  maxNames?: number;
  city?: string;
  budgetMs?: number;
}

export async function enrichPlacesFromWikidata(
  places: Place[],
  options: EnrichOptions = {},
): Promise<number> {
  const deadline = options.budgetMs ? Date.now() + options.budgetMs : undefined;
  const targets = places.filter(
    (place) =>
      place.name &&
      Number.isFinite(place.lat) &&
      Number.isFinite(place.lng) &&
      (!place.image || !place.note?.trim() || !place.wikidataId),
  );
  if (!targets.length) return 0;

  const matched = new Map<string, WikidataFacts>();
  const fallbackImages = new Map<string, string>();
  // 名字批查有空位上限，先保证人气高的点被覆盖，图鉴前排才不会都是占位图。
  const ranked = [...targets]
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, options.maxNames ?? 120);
  const variants = new Map<string, string[]>();
  const lookup = new Set<string>();
  for (const place of ranked) {
    const names = lookupVariants(place, options.city);
    variants.set(place.id, names);
    for (const name of names) lookup.add(name);
  }
  if (lookup.size) {
    try {
      const byName = await lookupNames([...lookup], deadline);
      for (const place of ranked) {
        const items: WikidataFacts[] = [];
        const seen = new Set<string>();
        for (const name of variants.get(place.id) ?? []) {
          for (const item of byName.get(name) ?? []) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            items.push(item);
          }
        }
        const ranked = rankItems(place, items, options.city);
        const item = ranked[0];
        if (!item) continue;
        matched.set(place.id, item);
        if (!item.image) {
          const withImage = ranked.find((entry) => entry.image);
          if (withImage?.image) fallbackImages.set(place.id, withImage.image);
        }
      }
    } catch {
      // 外部数据是增强项，失败就保持原样。
    }
  }

  const qids = [...new Set([...matched.values()].map((item) => item.id))];
  const facts = qids.length
    ? await fetchFacts(qids, deadline).catch(() => new Map())
    : new Map();
  let enriched = 0;
  for (const place of targets) {
    const item = matched.get(place.id);
    if (!item) continue;
    const fact = facts.get(item.id);
    const merged: WikidataFacts = {
      ...item,
      image: fact?.image ?? item.image ?? fallbackImages.get(place.id),
      description: fact?.description ?? item.description,
    };
    if (applyWikidataFacts(place, merged)) enriched += 1;
  }
  return enriched;
}

export interface WikidataReach {
  sitelinks: number;
  description?: string;
}

// 跨语言版本数当人气信号；官方 SPARQL 端点在国内常超时，这里同样走 QLever。
export async function wikidataReach(
  qids: string[],
): Promise<Map<string, WikidataReach>> {
  const out = new Map<string, WikidataReach>();
  const valid = [...new Set(qids)].filter((qid) => /^Q\d+$/.test(qid));
  for (const batch of chunk(valid, QID_BATCH)) {
    const values = batch
      .map((qid) => `<http://www.wikidata.org/entity/${qid}>`)
      .join(" ");
    let rows: Record<string, Binding>[] = [];
    try {
      rows = await sparql(
        `SELECT ?item ?links ?desc WHERE { VALUES ?item { ${values} } OPTIONAL { ?item wikibase:sitelinks ?links } OPTIONAL { ?item schema:description ?desc FILTER(lang(?desc) IN (${DESC_LANGS.map(
          (lang) => `"${lang}"`,
        ).join(", ")})) } }`,
      );
    } catch {
      continue;
    }
    const links = new Map<string, number>();
    const descs = new Map<string, { value: string; rank: number }>();
    const ranks: Record<string, number> = {
      "zh-hans": 0,
      "zh-cn": 1,
      zh: 2,
      "zh-hant": 3,
    };
    for (const row of rows) {
      const qid = qidOf(row.item.value);
      if (!qid) continue;
      const count = Number(row.links?.value);
      if (Number.isFinite(count)) {
        links.set(qid, Math.max(links.get(qid) ?? 0, count));
      }
      if (!row.desc) continue;
      const rank = ranks[row.desc["xml:lang"] ?? ""] ?? 9;
      const current = descs.get(qid);
      if (!current || rank < current.rank) {
        descs.set(qid, { value: row.desc.value, rank });
      }
    }
    for (const qid of batch) {
      out.set(qid, {
        sitelinks: links.get(qid) ?? 0,
        description: descs.get(qid)?.value,
      });
    }
  }
  return out;
}

export async function wikidataImageFileByQid(
  qid: string,
): Promise<string | undefined> {
  if (!/^Q\d+$/.test(qid)) return undefined;
  const facts = await fetchFacts([qid]).catch(() => new Map());
  const raw = facts.get(qid)?.image;
  return raw ? commonsFileName(raw) : undefined;
}

export async function lookupWikidataByName(
  name: string,
  city: string | undefined,
  lat: number | undefined,
  lng: number | undefined,
): Promise<WikidataFacts | null> {
  const deadline = Date.now() + 6_000;
  const byName = await lookupNames(
    lookupVariants({ name, lat: 0, lng: 0 }, city),
    deadline,
  );
  const items: WikidataFacts[] = [];
  const seen = new Set<string>();
  for (const list of byName.values()) {
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  if (!items.length) return null;
  if (lat === undefined || lng === undefined) {
    return items.length === 1 ? items[0] : null;
  }
  const ranked = rankItems({ name, lat, lng }, items, city);
  if (!ranked.length) return null;
  const item = ranked.find((entry) => entry.image) ?? ranked[0];
  const facts = await fetchFacts([item.id], deadline).catch(() => new Map());
  const fact = facts.get(item.id);
  return fact
    ? { ...item, image: fact.image, description: fact.description }
    : item;
}