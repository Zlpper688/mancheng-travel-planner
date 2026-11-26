import { promises as fs } from "node:fs";
import path from "node:path";
import { haversine } from "../geo";
import type { Category, Place } from "../types";

/**
 * 本地景点知识库读取层。
 *
 * 数据源是 data/knowledge/下由「攻略建模 + agent 联网核实」沉淀的静态包：
 *   - cities/<city>.json       建模：必去点（must）、景点聚合、路线模板
 *   - enrichment/<city>.json   核实：真实经纬度、评分、门票、简介（agent 联网查证）
 *
 * 设计目的：让演示城市不依赖不稳定的实时地图 API —— 必去点有本地真坐标就能排线。
 * 实时源（高德/开放地图）仍可通过 provider 补充候选池，本地包是「保底 + 必去点优先」。
 */
const KNOWLEDGE_DIR = path.join(process.cwd(), "data", "knowledge");

type EnrichPlace = {
  name: string;
  lng: number;
  lat: number;
  category?: Category;
  rating?: number;
  ticket?: string;
  hours?: string;
  intro?: string;
  source?: string;
  verified?: boolean;
};

type EnrichDoc = {
  city: string;
  verifiedAt?: string;
  method?: string;
  sources?: string[];
  center?: [number, number];
  places: Record<string, EnrichPlace>;
  unverified?: string[];
};

type MustStop = { name: string; order: number; kind?: string };
type CityDoc = {
  city: string;
  center?: [number, number] | null;
  must: MustStop[];
  places?: { name: string; category?: string; frequency?: number }[];
};

export type DestinationForm =
  | "city-hub"
  | "outskirt-day"
  | "small-town-big-sight"
  | "scenic-base"
  | "multi-city"
  | "region-loop";

export const FORM_LABELS: Record<DestinationForm, string> = {
  "city-hub": "单城漫游",
  "outskirt-day": "城郊一日",
  "small-town-big-sight": "小城大景点",
  "scenic-base": "景区基地",
  "multi-city": "多城联游",
  "region-loop": "区域环线",
};

type CacheEntry = { city: CityDoc | null; enrich: EnrichDoc | null };
const memoryCache = new Map<string, CacheEntry>();

function safeName(city: string): string {
  return city.replace(/[\\/:*?"<>|]/g, "_").trim();
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null; // 本地包坏掉不应让整座城失败
  }
}

export async function readLocalKnowledge(city: string): Promise<{
  city: CityDoc | null;
  enrich: EnrichDoc | null;
  places: Place[];
  center: [number, number] | null;
  form: DestinationForm;
  reachMin: number;
}> {
  const name = safeName(city);
  let entry = memoryCache.get(name);
  if (!entry) {
    const [cityDoc, enrichDoc] = await Promise.all([
      readJson<CityDoc>(path.join(KNOWLEDGE_DIR, "cities", `${name}.json`)),
      readJson<EnrichDoc>(path.join(KNOWLEDGE_DIR, "enrichment", `${name}.json`)),
    ]);
    entry = { city: cityDoc, enrich: enrichDoc };
    memoryCache.set(name, entry);
  }

  const { city: cityDoc, enrich } = entry as CacheEntry;
  const center = enrich?.center ?? cityDoc?.center ?? null;
  if (!enrich?.places) {
    return {
      city: cityDoc,
      enrich,
      places: [],
      center,
      form: "city-hub",
      reachMin: 75,
    };
  }

  // 必去点顺序按建模里的 must.order；enrichment 里查到并 verified 的才进候选。
  const orderByName = new Map<string, number>();
  for (const stop of cityDoc?.must ?? []) {
    orderByName.set(stop.name, stop.order);
  }

  // 必去点的远近不是「污染」，而是目的地形态的线索：
  //   - 城区 + 一个 30–150km 的大景区 → 小城大景点，应住景区门口（lodging 的 gateway 策略）
  //   - 跨几百公里 → 区域环线，应放大搜索半径、按基地分段
  // 先按距离分布读出形态，再把「值得为它跑多久」写进每个必去点。
  const allVerified = Object.values(enrich.places)
    .map((raw) => raw as EnrichPlace)
    .filter(
      (p) =>
        p && p.verified !== false && Number.isFinite(p.lng) && Number.isFinite(p.lat),
    );
  const dists = center
    ? allVerified
        .map((p) => haversine([p.lng, p.lat], center))
        .sort((a, b) => a - b)
    : [];
  const maxKm = dists.length ? dists[dists.length - 1] : 0;
  const nearShare =
    dists.length ? dists.filter((d) => d <= 25).length / dists.length : 1;

  let form: DestinationForm = "city-hub";
  let reachMin = 75;
  if (!center || !dists.length) {
    form = "city-hub";
    reachMin = 75;
  } else if (maxKm <= 25) {
    form = "city-hub";
    reachMin = 75;
  } else if (maxKm <= 70) {
    form = "outskirt-day";
    reachMin = 110;
  } else if (maxKm <= 180 && nearShare >= 0.5) {
    form = "small-town-big-sight";
    reachMin = 150;
  } else if (maxKm <= 180) {
    form = "scenic-base";
    reachMin = 150;
  } else if (maxKm <= 400) {
    form = "multi-city";
    reachMin = 200;
  } else {
    form = "region-loop";
    reachMin = 300;
  }

  const FAR_SIGHT_KM = 30;
  const REGION_KM = 250;
  const places: Place[] = [];
  for (const [key, raw] of Object.entries(enrich.places)) {
    const p = raw as EnrichPlace;
    if (!p || !Number.isFinite(p.lng) || !Number.isFinite(p.lat)) continue;
    if (p.verified === false) continue;
    const order = orderByName.get(key);
    const isMust = order !== undefined;
    const rating = Number.isFinite(p.rating) ? p.rating : undefined;
    const distKm = center ? haversine([p.lng, p.lat], center) : 0;
    const farSight = Boolean(center) && distKm > FAR_SIGHT_KM;
    const regionFar = Boolean(center) && distKm > REGION_KM;

    // 必去点一律保留高热度——它们是攻略明确推荐的，是否值得专程交给远足日/基地逻辑判断。
    const popularity = isMust
      ? 4.95 - (order ?? 0) * 0.001
      : rating
        ? Math.min(4.6, 3.9 + rating / 20)
        : 3.8;
    const tags = ["knowledge", "verified"];
    if (isMust) tags.push("must");
    if (farSight) tags.push("far-sight");
    if (regionFar) tags.push("region-far");
    const noteParts = [p.intro, p.ticket ? `门票：${p.ticket}` : "", p.hours ? `开放：${p.hours}` : ""]
      .filter(Boolean)
      .join("；");
    places.push({
      id: `knowledge-${name}-${key}`,
      name: p.name || key,
      category: p.category ?? "attraction",
      lat: p.lat,
      lng: p.lng,
      city,
      rating,
      popularity,
      // 必去点带形态给出的单程容忍值，远足日与审计据此放宽（城市漫游 75、区域环线 300）。
      reachMin: isMust ? reachMin : undefined,
      address: noteParts || undefined,
      note: farSight
        ? `本地核实知识库（${p.source || "联网核实"}）；距${city}中心约 ${Math.round(distKm)}km，适合作为基地或远足日`
        : `本地核实知识库（${p.source || "联网核实"}）`,
      // 复用现有合法枚举：wikidata 表示「非实时地图、已核实的开放知识」
      source: "wikidata",
      tags,
    });
  }

  return { city: cityDoc, enrich, places, center, form, reachMin };
}

/** 把本地知识库的必去点并入 discover 结果，去重后按热度排序。 */
export function mergeLocalKnowledge(
  discoveredPlaces: Place[],
  localPlaces: Place[],
): { places: Place[]; added: number } {
  if (!localPlaces.length) return { places: discoveredPlaces, added: 0 };
  const seen = new Set<string>();
  const norm = (s: string) => s.replace(/[\s()（）·—_-]/g, "").toLowerCase();
  for (const p of discoveredPlaces) seen.add(norm(p.name));
  let added = 0;
  const merged = [...discoveredPlaces];
  for (const p of localPlaces) {
    if (seen.has(norm(p.name))) continue;
    seen.add(norm(p.name));
    merged.push(p);
    added += 1;
  }
  merged.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
  return { places: merged, added };
}
