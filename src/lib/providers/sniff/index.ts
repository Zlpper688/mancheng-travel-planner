import { cached } from "../../cache";
import { isDemoCity } from "../../demo";
import type { DataSourceKind, Place } from "../../types";
import { XIAMEN_SIGHTS } from "../../../content/demo-xiamen";
import { isAmapConfigured } from "../index";
import { dedupePlaces } from "../normalize";
import { wikidataHeritageSearch, wikidataSearch } from "../open";
import {
  PHOTON_DEEP_SIGHT_INCLUDES,
  PHOTON_SIGHT_INCLUDES,
  photonCategorySearch,
} from "../photon";
import { sniffAmap } from "./amap";
import { datavCityBoundary } from "./boundary";
import { sniffOsm } from "./osm";
import {
  distanceToCenter,
  emptyBreakdown,
  mergePlaceLayers,
  SIGHT_CATEGORIES,
  withinBoundary,
} from "./shared";
import type {
  SniffBoundary,
  SniffOptions,
  SniffResult,
  SniffSourceResult,
  SniffStage,
} from "./types";

const STAGE_CAP: Record<SniffStage, number> = {
  base: 520,
  deep: 1_500,
};

const STAGE_WIKI: Record<SniffStage, { radiusKm: number; limit: number }> = {
  base: { radiusKm: 28, limit: 180 },
  deep: { radiusKm: 55, limit: 400 },
};

async function sniffWikidata(
  city: string,
  center: [number, number],
  stage: SniffStage,
): Promise<SniffSourceResult> {
  const { radiusKm, limit } = STAGE_WIKI[stage];
  const places = await cached(
    `wikidata:sniff-city:v3:${city}:${stage}`,
    30 * 60 * 1000,
    async () => {
      const [typed, heritage] = await Promise.all([
        wikidataSearch(center, radiusKm, limit),
        wikidataHeritageSearch(center, radiusKm, Math.min(600, limit * 2)),
      ]);
      return dedupePlaces([...typed, ...heritage]);
    },
    { cacheIf: (value) => value.length > 0 },
  );
  const notes: string[] = [];
  if (places.length) {
    notes.push(`Wikidata 收录 ${places.length} 个可定位地标（含文保点位）。`);
  }
  return {
    source: "wikidata",
    places,
    notes,
    requests: 2,
    truncated: places.length >= limit * 3,
    raw: places.length,
  };
}

async function sniffPhoton(
  city: string,
  center: [number, number],
  stage: SniffStage,
  boundary?: SniffBoundary,
): Promise<SniffSourceResult> {
  const radiusKm = stage === "deep" ? 55 : 25;
  const categories =
    stage === "deep" ? PHOTON_DEEP_SIGHT_INCLUDES : PHOTON_SIGHT_INCLUDES;
  const limit = stage === "deep" ? 120 : 90;
  const places = await photonCategorySearch({
    center,
    radiusKm,
    categories,
    limit,
  }).catch(() => []);
  const kept = places.filter(
    (place) =>
      SIGHT_CATEGORIES.has(place.category) &&
      withinBoundary(place, city, boundary, center),
  );
  return {
    source: "osm",
    places: kept,
    notes: kept.length
      ? [
          `Photon 分类检索补全 ${kept.length} 个点位（约 ${radiusKm} km 内）。`,
        ]
      : [],
    requests: categories.length,
    truncated: places.length >= limit * categories.length * 0.9,
    raw: places.length,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "上游返回异常";
}

export async function sniffCity(options: SniffOptions): Promise<SniffResult> {
  const started = Date.now();
  const { city, center, stage } = options;
  const notes: string[] = [];
  const breakdown = emptyBreakdown();
  let requests = 0;

  const datavBoundary = await Promise.race([
    datavCityBoundary(city, center).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
  ]);

  const [amapResult, osmRaw, wikidataResult, photonResult] =
    await Promise.all([
      isAmapConfigured()
        ? sniffAmap(city, center, stage).catch((error) => {
            notes.push(`高德全城扫描暂不可用：${messageOf(error)}`);
            return null;
          })
        : Promise.resolve(null),
      sniffOsm(city, center, stage, datavBoundary ?? undefined).catch(
        (error) => {
          notes.push(`OpenStreetMap 全城扫描暂不可用：${messageOf(error)}`);
          return null;
        },
      ),
      sniffWikidata(city, center, stage).catch((error) => {
        notes.push(`Wikidata 地标补全暂不可用：${messageOf(error)}`);
        return null;
      }),
      // 有高德或演示数据时不需要额外补位，避免每次扫描都多打一轮外部请求。
      isAmapConfigured() || isDemoCity(city)
        ? Promise.resolve(null)
        : sniffPhoton(city, center, stage, datavBoundary ?? undefined).catch(
            () => null,
          ),
    ]);

  let osmResult = osmRaw;
  if (photonResult?.places.length) {
    if (osmResult) {
      osmResult = {
        ...osmResult,
        places: dedupePlaces([...osmResult.places, ...photonResult.places]),
        notes: [
          ...new Set([
            ...osmResult.notes.filter(
              (note) => !note.includes("暂时不可用"),
            ),
            ...photonResult.notes,
          ]),
        ],
        requests: osmResult.requests + photonResult.requests,
        raw: osmResult.raw + photonResult.raw,
        truncated: osmResult.truncated || photonResult.truncated,
      };
    } else {
      osmResult = photonResult;
    }
  }

  const layers: Place[][] = [];
  const sources: SniffSourceResult[] = [];

  const demoPlaces = isDemoCity(city) ? XIAMEN_SIGHTS : [];
  if (demoPlaces.length) {
    layers.push(demoPlaces);
    breakdown.demo = demoPlaces.length;
    sources.push({
      source: "demo",
      places: demoPlaces,
      notes: [],
      requests: 0,
      truncated: false,
      raw: demoPlaces.length,
    });
  }

  for (const result of [amapResult, osmResult, wikidataResult]) {
    if (!result) continue;
    sources.push(result);
    if (result.source === "amap") breakdown.amap = result.places.length;
    else if (result.source === "osm") breakdown.osm = result.places.length;
    else if (result.source === "wikidata") breakdown.wikidata = result.places.length;
    layers.push(result.places);
    requests += result.requests;
    notes.push(...result.notes);
  }

  const amapBoundary = sources.find(
    (item) => item.source === "amap" && item.boundary?.rings?.length,
  )?.boundary;
  const boundary =
    amapBoundary ??
    (datavBoundary?.rings?.length ? datavBoundary : undefined) ??
    sources.find((item) => item.boundary?.rings?.length)?.boundary ??
    sources.find((item) => item.boundary)?.boundary;

  const usingDatav = Boolean(datavBoundary?.rings?.length) && boundary === datavBoundary;
  if (usingDatav && datavBoundary) {
    notes.push(
      `已按 ${datavBoundary.name} 行政区边界裁剪，排除相邻城市与飞地点位。`,
    );
  }

  const merged = dedupePlaces(mergePlaceLayers(layers)).filter(
    (place) =>
      SIGHT_CATEGORIES.has(place.category) &&
      Number.isFinite(place.lat) &&
      Number.isFinite(place.lng) &&
      withinBoundary(place, city, boundary, center),
  );

  merged.sort(
    (a, b) =>
      (b.popularity ?? 0) - (a.popularity ?? 0) ||
      distanceToCenter(a, center) - distanceToCenter(b, center),
  );

  const cap = STAGE_CAP[stage];
  const kept = merged.slice(0, cap);
  const sourceTruncated = sources.some((item) => item.truncated);
  const capReached = sourceTruncated || merged.length > kept.length;
  // 深挖阶段 OSM 是主力枚举源，它没返回结果时不能宣称“已扫完”。
  const incomplete = stage === "deep" && !breakdown.amap && !breakdown.osm;
  const hasMore = capReached || incomplete;
  const raw = sources.reduce((sum, item) => sum + item.raw, 0);

  const usedAmap = breakdown.amap > 0;
  const usedOsm = breakdown.osm > 0;
  const usedWikidata = breakdown.wikidata > 0;
  const usedDemo = breakdown.demo > 0;

  let source: DataSourceKind = "demo";
  let sourceNote = "内置精选点位";
  if (usedAmap) {
    source = "amap";
    sourceNote = usedOsm
      ? "高德全城扫描 · OpenStreetMap 补全"
      : "高德全城扫描 · 商户与评分数据";
  } else if (usedOsm || usedWikidata) {
    source = "open";
    sourceNote = usedOsm
      ? usedWikidata
        ? "OpenStreetMap 全城扫描 · Wikidata 补全"
        : "OpenStreetMap 全城扫描"
      : "Wikidata 地标扫描";
  }

  const sourceSummary = [
    usedAmap ? `高德 ${breakdown.amap}` : "",
    usedOsm ? `OpenStreetMap ${breakdown.osm}` : "",
    usedWikidata ? `Wikidata ${breakdown.wikidata}` : "",
    usedDemo ? `精选 ${breakdown.demo}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const summaryNotes = [
    `全城扫描到 ${raw} 个候选，合并去重后 ${kept.length} 个景点${
      capReached
        ? "（已达到本次扫描上限，稍后刷新可继续）"
        : incomplete
          ? "（部分地图来源未完成，稍后刷新可继续补全）"
          : ""
    }。`,
    sourceSummary ? `来源：${sourceSummary}。` : "",
  ].filter(Boolean);
  notes.unshift(...summaryNotes);

  if (!usedAmap && !usedOsm && !usedWikidata && usedDemo) {
    notes.push("在线地图扫描未完成，先显示精选点位；稍后刷新可重试。");
  }
  if (usedDemo) {
    notes.push("厦门精选点位已叠加到扫描结果，用来校准人气与一句话介绍。");
  }

  return {
    sights: kept,
    source,
    sourceNote,
    notes: [...new Set(notes)],
    stats: {
      stage,
      raw,
      kept: kept.length,
      bySource: breakdown,
      requests,
      truncated: sourceTruncated || merged.length > kept.length,
      elapsedMs: Date.now() - started,
      hasMore,
      boundary: boundary
        ? {
            name: boundary.name,
            bbox: boundary.bbox,
            areaId: boundary.areaId,
            adcode: boundary.adcode,
          }
        : undefined,
    },
  };
}